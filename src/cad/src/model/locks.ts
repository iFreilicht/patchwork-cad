/**
 * Locks of the documents a model follows (research/21, "Following and pinning"): `cad.locks` holds
 * the version of each that the model last built with. A build with a newer version that fails where
 * the build with the locked one doesn't is held back; otherwise the lock advances. Pure, so that
 * the rules can be tested without a kernel.
 */
import type { CadModelDoc } from "../types.ts";

/** A build's outcome as far as locks compare it: its error, and its features that are broken or failed. */
export interface BuildErrors {
  error?: { kind: string; line: number | undefined; message?: string } | undefined;
  failures: readonly { name: string; status: string; message?: string | undefined }[];
}

/**
 * The errors of a build, as keys that are equal for the same error in two builds: an error of the
 * build by its kind and line, a broken or failed feature by its status and name; never by message,
 * which names values and versions. A runtime error without a line is a kernel error, as the status
 * bar has it. Meshing isn't compared: a trial build doesn't mesh.
 */
export function errorKeys(build: BuildErrors): string[] {
  return Object.keys(errorTexts(build));
}

/** A build's errors as `errorKeys` names them, each with its message, for showing them. */
export function errorTexts(build: BuildErrors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of build.failures) out[`${f.status} ${f.name}`] = `${f.name}: ${f.status === "broken" ? "broken reference" : "failed"}${f.message ? `: ${f.message}` : ""}`;
  const e = build.error;
  if (e && e.kind !== "mesh") {
    const key = `${e.kind === "runtime" && e.line === undefined ? "kernel" : e.kind} error${e.line === undefined ? "" : ` on line ${e.line}`}`;
    out[key] = e.message ? `${key}: ${e.message}` : key;
  }
  return out;
}

/** The errors of `latest` that `locked` doesn't have: those a newer version of the documents brought. */
export const newErrors = (latest: readonly string[], locked: readonly string[]): string[] => latest.filter((key) => !locked.includes(key));

/** A followed document as one build saw it. */
export interface Followed {
  /** Its URL, without a path or heads: the key of its lock. */
  doc: string;
  /** The version the latest build read. */
  latest: readonly string[];
  /** Its lock, if it has one. */
  locked: readonly string[] | undefined;
  /** Whether this copy of the document has every head of the lock, so that it can build with it and may replace it. */
  hasLocked: boolean;
}

const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) => !!a && !!b && a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/** The documents whose version moved on from their lock: those a build with the locks reads at another version. */
export const moved = (docs: readonly Followed[]): Followed[] => docs.filter((d) => d.locked && d.hasLocked && !same(d.locked, d.latest));

export interface Decision {
  /** Which build to show: with the latest versions, or with the moved documents at their locks. */
  show: "latest" | "locked";
  /** The moved documents held back at their locks, with the errors the latest versions brought. */
  held: { doc: string; errors: string[] }[];
  /** The locks to write, by document. */
  write: Record<string, string[]>;
}

/**
 * What to do with a build of the latest versions (`latest`, its error keys), given the build with the
 * moved documents at their locks (`locked`), if one was made; it is needed only when the latest
 * build has errors and some document moved. Several documents that moved at once are held back
 * together. A lock is written only where `writable`, only if it changes, and only forward: a copy
 * that lacks a head of the stored lock (`hasLocked`) is behind the editor that wrote it and leaves
 * it alone, or two editors with different versions of a document would overwrite each other's locks
 * forever. A document without a lock gets one with the first build, whatever its errors: there is
 * nothing to compare them with, and later versions are compared with this one.
 */
export function decide(docs: readonly Followed[], latest: readonly string[], locked: readonly string[] | undefined, writable: boolean): Decision {
  const movedDocs = moved(docs);
  const brought = movedDocs.length && locked ? newErrors(latest, locked) : [];
  const hold = brought.length > 0;
  const write: Record<string, string[]> = {};
  if (writable) {
    for (const d of docs) {
      if (hold && movedDocs.includes(d)) continue;
      if (d.locked && (!d.hasLocked || same(d.locked, d.latest))) continue;
      write[d.doc] = [...d.latest].sort();
    }
  }
  return { show: hold ? "locked" : "latest", held: hold ? movedDocs.map((d) => ({ doc: d.doc, errors: brought })) : [], write };
}

/** The locks of a model document. */
export const locksOf = (doc: CadModelDoc | undefined): Record<string, string[]> => (doc?.cad?.locks ?? {}) as Record<string, string[]>;

/**
 * Writes locks and removes those of documents no longer followed (`keep`, if given), inside a
 * change of the model document. Lock writes are never undo steps (`UNDO_IGNORE`).
 */
export function writeLocks(doc: CadModelDoc, write: Record<string, string[]>, keep?: ReadonlySet<string>): void {
  if (!doc.cad) doc.cad = {};
  if (!doc.cad.locks) doc.cad.locks = {};
  const locks = doc.cad.locks;
  for (const [url, heads] of Object.entries(write)) locks[url] = heads;
  if (keep) for (const url of Object.keys(locks)) if (!keep.has(url)) delete locks[url];
}

/**
 * The paths of a model document that the editor's undo doesn't undo (research/16-undo-redo.md):
 * Patchwork's metadata and comments (`@…`) and the locks; and the `cad` field's creation alone,
 * which a lock may be the first to need.
 */
export const UNDO_IGNORE = (path: readonly unknown[]): boolean => String(path[0]).startsWith("@") || (path[0] === "cad" && (path.length === 1 || path[1] === "locks"));
