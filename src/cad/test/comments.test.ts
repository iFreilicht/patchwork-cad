// Comment threads on the model (research/13-collaboration.md, "Comments"): where a thread's range is
// in `source` after edits, which timeline entry it belongs to, and where it goes after its text was
// deleted and came back.
import { readFileSync } from "node:fs";
import { cursor, initSubduction, Repo, type DocHandle } from "@automerge/automerge-repo";
import { splice } from "@automerge/automerge";
import { beforeAll, expect, test } from "vitest";
import { analyze } from "../src/model/analyze.ts";
import { entryOf, isDetached, placeThreads, reanchorTarget, sourceRange } from "../src/model/comments.ts";
import { timeline } from "../src/model/timeline.ts";
import type { CadAnchor, CadModelDoc } from "../src/types.ts";

// The subduction fork's Repo needs its wasm before it is constructed.
beforeAll(() => initSubduction());

const M1 = readFileSync(new URL("../../features/examples/m1.js", import.meta.url), "utf8");

function model(source = M1): DocHandle<CadModelDoc> {
  return new Repo().create<CadModelDoc>({ title: "m", source });
}

const entries = (handle: DocHandle<CadModelDoc>) => {
  const source = handle.doc().source;
  return timeline(source, analyze(source), []).entries;
};

/** Comments on the statement of `name`, as the timeline makes it. */
function commentOn(handle: DocHandle<CadModelDoc>, name: string, anchor: CadAnchor = { feature: name }) {
  const entry = entries(handle).find((e) => e.kind === "feature" && e.name === name)!;
  const ref = handle.sub("source", cursor(entry.span.start, entry.span.end)).url;
  handle.change((d) => {
    d["@comments"] ??= { threads: [] };
    d["@comments"].threads.push({ id: name, refs: [ref], isResolved: false, comments: [], "@cad": anchor });
  });
  return entry;
}

const edit = (handle: DocHandle<CadModelDoc>, start: number, remove: number, text = "") => handle.change((d) => splice(d, ["source"], start, remove, text));

test("a thread's range follows edits before and inside it", () => {
  const handle = model();
  const entry = commentOn(handle, "extrude1");
  const statement = M1.slice(entry.span.start, entry.span.end);
  const header = "// header\n";
  edit(handle, 0, 0, header);
  edit(handle, header.length + entry.span.start + statement.indexOf("extrude1"), "extrude1".length, "block");
  const [placed] = placeThreads(handle.doc(), handle.url);
  expect(handle.doc().source.slice(placed!.range!.start, placed!.range!.end)).toBe(statement.replace("extrude1", "block"));
  expect(entryOf(entries(handle), placed!.range!)).toBe(entries(handle).findIndex((e) => e.kind === "feature" && e.name === "block"));
});

test("a deleted statement detaches its thread; an undo, which inserts the text again, re-anchors it by name", () => {
  const handle = model();
  const entry = commentOn(handle, "extrude1");
  const statement = M1.slice(entry.span.start, entry.span.end);
  edit(handle, entry.span.start, statement.length);
  let [placed] = placeThreads(handle.doc(), handle.url);
  expect(placed!.range).toBeUndefined();
  expect(reanchorTarget(placed!, entries(handle))).toBeUndefined();

  edit(handle, entry.span.start, 0, statement);
  [placed] = placeThreads(handle.doc(), handle.url);
  // The cursors stay collapsed: the undo's text is new text.
  expect(placed!.range).toBeUndefined();
  expect(reanchorTarget(placed!, entries(handle))).toEqual(entry.span);
});

test("resolved threads, other documents' refs and other paths are left out", () => {
  const handle = model();
  const other = model();
  commentOn(handle, "extrude1");
  handle.change((d) => (d["@comments"]!.threads[0]!.isResolved = true));
  expect(placeThreads(handle.doc(), handle.url)).toEqual([]);
  expect(sourceRange(handle.doc(), handle.url, other.sub("source", cursor(0, 5)).url)).toBeUndefined();
  expect(sourceRange(handle.doc(), handle.url, handle.sub("title").url)).toBeUndefined();
  expect(sourceRange(handle.doc(), handle.url, handle.url)).toBeUndefined();
});

test("a thread on the whole document, as the Comments panel's Add comment makes it, is not detached", () => {
  const handle = model();
  handle.change((d) => {
    d["@comments"] = { threads: [{ id: "doc", refs: [handle.url], isResolved: false, comments: [] }] };
  });
  const [placed] = placeThreads(handle.doc(), handle.url);
  expect(placed!.document).toBe(true);
  expect(isDetached(placed!)).toBe(false);
  expect(reanchorTarget(placed!, entries(handle))).toBeUndefined();
});

test("a feature thread whose statement is deleted and the name gone stays detached", () => {
  const handle = model();
  const entry = commentOn(handle, "chamfer1");
  // Deletes the statement, and with it the only `chamfer1`.
  edit(handle, entry.span.start, entry.span.end - entry.span.start);
  const [placed] = placeThreads(handle.doc(), handle.url);
  expect(isDetached(placed!)).toBe(true);
  expect(reanchorTarget(placed!, entries(handle))).toBeUndefined();
});
