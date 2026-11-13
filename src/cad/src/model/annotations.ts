import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { Annotation, CadAnchor, CadModelDoc } from "../types.ts";
import type { Entry } from "./timeline.ts";

/**
 * Annotations (research/21-embedding.md, "Annotation"): documents shown at places on the model,
 * kept in its document next to the code, under `cad.annotations`, as named views are. They change
 * nothing a build returns. The edits run inside a `change` of the model document.
 */

export const annotations = (doc: CadModelDoc | undefined): Annotation[] => doc?.cad?.annotations ?? [];

/** A copy that shares nothing with `value`, which may be another document's, and has no undefined fields, which Automerge rejects. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function addAnnotation(doc: CadModelDoc, annotation: Annotation): void {
  // An assignment evaluates to the plain object, not to the document's proxy of it: read back.
  if (!doc.cad) doc.cad = {};
  if (!doc.cad.annotations) doc.cad.annotations = [];
  doc.cad.annotations.push(copy(annotation));
}

export function removeAnnotation(doc: CadModelDoc, id: string): void {
  const list = doc.cad?.annotations;
  const at = list?.findIndex((a) => a.id === id) ?? -1;
  if (list && at >= 0) list.splice(at, 1);
}

const find = (doc: CadModelDoc, id: string) => doc.cad?.annotations?.find((a) => a.id === id);

export function setAnnotationDoc(doc: CadModelDoc, id: string, url: AutomergeUrl): void {
  const a = find(doc, id);
  if (a && a.doc !== url) a.doc = url;
}

/** Pins it to a place, or with `undefined` to the model as a whole. */
export function setAnnotationAnchor(doc: CadModelDoc, id: string, anchor: CadAnchor | undefined): void {
  const a = find(doc, id);
  if (!a) return;
  if (anchor) a.anchor = copy(anchor);
  else delete a.anchor;
}

export function setAnnotationTool(doc: CadModelDoc, id: string, tool: string | undefined): void {
  const a = find(doc, id);
  if (!a || a.tool === tool) return;
  if (tool) a.tool = tool;
  else delete a.tool;
}

export function setAnnotationView(doc: CadModelDoc, id: string, view: string | undefined): void {
  const a = find(doc, id);
  if (!a || a.view === view) return;
  if (view) a.view = view;
  else delete a.view;
}

/** Where an annotation is pinned: a face or edge, a feature, or the model as a whole. */
export type Placement = "entity" | "feature" | "model";
export const placementOf = (a: Annotation): Placement => (a.anchor?.entity ? "entity" : a.anchor?.feature ? "feature" : "model");

/** An annotation on a feature whose feature the timeline doesn't have, e.g. deleted; it comes back with a feature of that name. */
export const featureGone = (a: Annotation, entries: readonly Entry[]): boolean =>
  placementOf(a) === "feature" && !entries.some((e) => e.kind === "feature" && e.names.includes(a.anchor!.feature!));

/** What an annotation is pinned to, for people: `extrude1.side.front`, `extrude1`, or the model. */
export const anchorLabel = (a: Pick<Annotation, "anchor">): string => a.anchor?.entityName ?? a.anchor?.feature ?? "the model";
