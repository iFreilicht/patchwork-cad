// The scene's content provider for CAD models (`scene:source` "cad-model-scene"): the scene calls
// build() for a model placed in it and draws the GLB it returns, kept in the object's render doc and
// built again when fingerprint() or one of dependencies() changes. A placed model is built with a
// configuration of its own (params(), research/23-scene-editing.md, F1). The contract is the scene's
// README, "Writing a provider" (patchwork-experiments/scene).

import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";
import { resolvedFrom } from "../components/configurations.ts";
import { createImports, docOf, headsOf } from "../components/imports.ts";
import { documentImports, type Imports } from "../kernel/imports.ts";
import type { MeshedShape, ModelError, FeatureTrace } from "../kernel/protocol.ts";
import { canvases } from "../model/canvases.ts";
import { configurations, isLinked } from "../model/configurations.ts";
import { locksOf } from "../model/locks.ts";
import type { CadModelDoc, ParamValue } from "../types.ts";
import { canvasImages, faceRefsOf, placedCanvases } from "./canvasGlb.ts";
import { buildModel } from "./kernel.ts";
import { modelGlb } from "./modelGlb.ts";

type Repo = typeof globalThis.repo;

/** 53-bit string hash (cyrb53) as hex: a change detector, not cryptographic. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The locks, in an order that doesn't depend on how they were written. */
const sortedLocks = (doc: CadModelDoc | undefined) =>
  Object.entries(locksOf(doc))
    .map(([url, heads]) => [url, [...heads].sort()] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));

/**
 * What build() and params() read of the model document: its code, the locks of the documents it
 * follows, its configurations and its canvases. Not its title, views, comments or annotations, so
 * editing those builds nothing.
 */
export function fingerprint(doc: CadModelDoc | undefined): string {
  return `cad3:${hash(JSON.stringify([String(doc?.content ?? ""), sortedLocks(doc), configurations(doc), canvases(doc)]))}`;
}

/** The key of the configuration param: a model's configuration's id, or "" for its defaults. */
export const CONFIGURATION = "configuration";

/** A placed model's own params (the scene's `params(doc)`): which of its configurations it is built with. */
export function params(doc: CadModelDoc | undefined) {
  return [
    {
      key: CONFIGURATION,
      label: "Configuration",
      kind: "enum" as const,
      default: "",
      options: [{ value: "", label: "Defaults" }, ...configurations(doc).map((c) => ({ value: c.id, label: c.name }))],
    },
  ];
}

/** The values configuration `id` builds with, its linked ones read from their documents as they are now, and why some aren't there. */
export async function configurationValues(doc: CadModelDoc, id: unknown, repo: Repo): Promise<{ values: Record<string, ParamValue> | undefined; problems: string[] }> {
  const c = configurations(doc).find((x) => x.id === id);
  if (!c) return { values: undefined, problems: [] };
  const values: Record<string, ParamValue> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(c.params)) {
    if (!isLinked(value)) values[key] = value as ParamValue;
    else {
      if (!repo) {
        problems.push(`${key}: its linked value can't be read outside Patchwork`);
        continue;
      }
      const linked = await repo.find<unknown>(value.link as AutomergeUrl).then(
        (h) => resolvedFrom(h.doc()),
        (error: unknown) => ({ value: undefined, problem: `can't be loaded: ${String((error as Error)?.message ?? error)}` }),
      );
      if (linked.problem === undefined) values[key] = linked.value!;
      else problems.push(`${key}: its linked value ${linked.problem}`);
    }
  }
  return { values: Object.keys(values).length ? values : undefined, problems };
}

/**
 * The documents the code imports that can change what it builds: those it follows without a lock.
 * A pinned import (`#heads`) never changes, and a locked one changes only with its lock, which is the
 * model's own (fingerprint). Documents imported through an imported JS file aren't listed; the editor
 * locks them as it builds.
 */
export function dependencies(doc: CadModelDoc | undefined): string[] {
  const locks = locksOf(doc);
  const urls = documentImports(String(doc?.content ?? ""))
    .filter((d) => !headsOf(d.specifier))
    .map((d) => docOf(d.specifier))
    .filter((url): url is NonNullable<typeof url> => !!url && !locks[url]);
  // And the documents configurations link values to, read as they are (research/17, "Values from other documents").
  const links = configurations(doc).flatMap((c) => Object.values(c.params).flatMap((v) => (isLinked(v) ? [docOf(v.link) ?? v.link] : [])));
  // And the images of its canvases, which it follows unless a canvas names a version.
  return [...new Set([...urls, ...links, ...canvasImages(doc)])];
}

/**
 * The documents `source` imports, at the versions the editor last built with: a followed document
 * at its lock if this repo has that version, else as it is (as the read-only editor reads them).
 */
export async function readImports(source: string, doc: CadModelDoc, repo: Repo): Promise<Imports> {
  const reader = createImports(() => {}, repo);
  try {
    const latest = await reader.read(source);
    const locks = locksOf(doc);
    const at: Record<string, UrlHeads> = {};
    for (const d of latest.documents) {
      const lock = d.doc && !headsOf(d.specifier) ? (locks[d.doc] as UrlHeads | undefined) : undefined;
      if (d.doc && lock && reader.has(d.doc, lock)) at[d.doc] = lock;
    }
    return Object.keys(at).length ? (await reader.read(source, at)).imports : latest.imports;
  } finally {
    reader.dispose();
  }
}

export const errorText = (error: ModelError) => `${error.kind} error${error.line ? ` on line ${error.line}` : ""}: ${error.message}`;

/** What the scene's render doc should say besides the geometry: features that didn't work, values that can't be shown, an empty result. */
export function notesOf(shapes: readonly MeshedShape[], sketches: number, trace: readonly FeatureTrace[], dropped: number): string | undefined {
  const notes: string[] = [];
  const bad = trace.filter((t) => t.status !== "ok");
  if (bad.length) notes.push(`${bad.length} feature${bad.length > 1 ? "s" : ""} ${bad.length > 1 ? "are" : "is"} broken or failed: ${bad.map((t) => `${t.name} (${t.message ?? t.status})`).join("; ")}`);
  if (dropped) notes.push(`${dropped} returned value${dropped > 1 ? "s" : ""} can't be shown`);
  if (!shapes.length && !sketches) notes.push("main() returns nothing to show");
  return notes.length ? notes.join(". ") : undefined;
}

export interface BuildArgs {
  doc: CadModelDoc | undefined;
  repo?: Repo;
  /** The placed model's params (params()), with their defaults filled in. */
  params?: Record<string, unknown>;
}

/** The model with its configuration's parameters (its defaults if none), as a GLB in the scene's frame (Y up, metres). Never writes the model document. */
export async function build({ doc, repo, params: placed }: BuildArgs) {
  if (!doc) throw new Error("the CAD model isn't available");
  const source = String(doc.content ?? "");
  const r = repo ?? globalThis.repo;
  const configured = await configurationValues(doc, placed?.[CONFIGURATION], r);
  const { result, located } = await buildModel(source, await readImports(source, doc, r), configured.values, faceRefsOf(doc).map((f) => f.ref));
  if (!result.ok) throw new Error(errorText(result.error));
  const pictures = await placedCanvases(doc, r, result.shapes, located);
  const { glb, bounds } = modelGlb(result.shapes, result.sketches, pictures.canvases);
  const notes = [notesOf(result.shapes, result.sketches.length, result.trace, result.dropped), ...configured.problems, ...pictures.problems].filter(Boolean).join(". ") || undefined;
  return { kind: "glb" as const, glb, meta: { ...(bounds ? { bounds } : {}), ...(notes ? { notes } : {}) } };
}

export default { fingerprint, dependencies, params, build };
