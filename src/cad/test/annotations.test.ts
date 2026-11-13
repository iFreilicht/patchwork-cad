// Annotations in the model document (research/21-embedding.md, "Annotation"): adding, changing and
// removing them, where each is pinned, one whose feature is gone, concurrent edits of two users, and
// the role a drop preselects.
import { save } from "@automerge/automerge";
import { initSubduction, Repo, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { addAnnotation, anchorLabel, annotations, featureGone, placementOf, removeAnnotation, setAnnotationAnchor, setAnnotationDoc, setAnnotationTool, setAnnotationView } from "../src/model/annotations.ts";
import { analyze } from "../src/model/analyze.ts";
import { timeline } from "../src/model/timeline.ts";
import { preselects } from "../src/components/editor/inserts.ts";
import { MODEL_MIME_TYPE } from "../src/datatype.ts";
import type { CadAnchor, CadModelDoc } from "../src/types.ts";

beforeAll(() => initSubduction());

const model = (): DocHandle<CadModelDoc> => new Repo().create<CadModelDoc>({ title: "m", content: "", mimeType: MODEL_MIME_TYPE });
const DOC = "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG" as AutomergeUrl;
const OTHER = "automerge:3RtmWqXcDkz8hPvN5sYbJ7uELfAa" as AutomergeUrl;
const face: CadAnchor = { feature: "extrude1", statement: "const extrude1 = …", entity: { kind: "face", history: [] } as unknown as NonNullable<CadAnchor["entity"]>, entityName: "extrude1.end" };

test("annotations are added, changed and removed by id; unset fields are removed, not undefined", () => {
  const handle = model();
  handle.change((d) => addAnnotation(d, { id: "a", doc: DOC }));
  handle.change((d) => addAnnotation(d, { id: "b", doc: DOC, anchor: face }));
  expect(annotations(handle.doc()).map((a) => a.id)).toEqual(["a", "b"]);
  handle.change((d) => {
    setAnnotationDoc(d, "a", OTHER);
    setAnnotationTool(d, "a", "markdown");
    setAnnotationView(d, "a", "home");
    setAnnotationAnchor(d, "a", { feature: "extrude1" });
  });
  expect(annotations(handle.doc())[0]).toEqual({ id: "a", doc: OTHER, tool: "markdown", view: "home", anchor: { feature: "extrude1" } });
  handle.change((d) => {
    setAnnotationTool(d, "a", undefined);
    setAnnotationView(d, "a", undefined);
    setAnnotationAnchor(d, "a", undefined);
  });
  expect(annotations(handle.doc())[0]).toEqual({ id: "a", doc: OTHER });
  handle.change((d) => removeAnnotation(d, "a"));
  handle.change((d) => removeAnnotation(d, "missing"));
  expect(annotations(handle.doc()).map((a) => a.id)).toEqual(["b"]);
});

test("an anchor is a copy", () => {
  const handle = model();
  const anchor: CadAnchor = { feature: "extrude1" };
  handle.change((d) => addAnnotation(d, { id: "a", doc: DOC, anchor }));
  anchor.feature = "changed";
  expect(annotations(handle.doc())[0]?.anchor).toEqual({ feature: "extrude1" });
});

test("where an annotation is pinned, and how it is named", () => {
  expect(placementOf({ id: "a", doc: DOC })).toBe("model");
  expect(placementOf({ id: "a", doc: DOC, anchor: { feature: "extrude1" } })).toBe("feature");
  expect(placementOf({ id: "a", doc: DOC, anchor: face })).toBe("entity");
  expect(anchorLabel({})).toBe("the model");
  expect(anchorLabel({ anchor: { feature: "extrude1" } })).toBe("extrude1");
  expect(anchorLabel({ anchor: face })).toBe("extrude1.end");
});

test("an annotation on a feature is gone while the timeline has no feature of its name", () => {
  const source = `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [1, 1] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: 1 });
  return { extrude1 };
}
`;
  const entries = timeline(source, analyze(source), []).entries;
  expect(featureGone({ id: "a", doc: DOC, anchor: { feature: "extrude1" } }, entries)).toBe(false);
  expect(featureGone({ id: "a", doc: DOC, anchor: { feature: "extrude2" } }, entries)).toBe(true);
  // One on a face is found or not by the worker, one on the model is never gone.
  expect(featureGone({ id: "a", doc: DOC, anchor: { ...face, feature: "extrude2" } }, entries)).toBe(false);
  expect(featureGone({ id: "a", doc: DOC }, entries)).toBe(false);
});

test("two users' annotations both stay; a removal wins over a concurrent change", () => {
  const a = model();
  a.change((d) => addAnnotation(d, { id: "x", doc: DOC }));
  const b = new Repo().import<CadModelDoc>(save(a.doc()));
  a.change((d) => addAnnotation(d, { id: "y", doc: DOC }));
  b.change((d) => addAnnotation(d, { id: "z", doc: OTHER }));
  a.change((d) => removeAnnotation(d, "x"));
  b.change((d) => setAnnotationTool(d, "x", "markdown"));
  a.merge(b);
  expect(annotations(a.doc()).map((x) => x.id).sort()).toEqual(["y", "z"]);
});

test("a drop on a face preselects Annotation, but not for an image or an SVG; the code, the timeline and the list Import", () => {
  const file = (extension: string, mimeType: string) => ({ "@patchwork": { type: "file" }, name: "f", extension, mimeType, content: "x" });
  expect(preselects({ kind: "face" }, { title: "Notes" })).toBe("annotation");
  expect(preselects({ kind: "face" }, file("md", "text/markdown"))).toBe("annotation");
  expect(preselects({ kind: "face" }, undefined)).toBe("annotation");
  expect(preselects({ kind: "face" }, file("png", "image/png"))).toBeUndefined();
  expect(preselects({ kind: "face" }, file("svg", "image/svg+xml"))).toBeUndefined();
  expect(preselects({ kind: "import" }, file("png", "image/png"))).toBe("import");
  expect(preselects({ kind: "insert" }, { title: "Notes" })).toBeUndefined();
});
