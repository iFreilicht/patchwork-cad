// The scene's content provider (src/scene): what a build reads and is rebuilt for, the documents it
// imports at the editor's locks, and the GLB by the scene's conventions. The kernel isn't run here.
import { generateAutomergeUrl, initSubduction, Repo } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { moduleKey } from "../src/kernel/imports.ts";
import type { MeshedShape } from "../src/kernel/protocol.ts";
import { parseGLB } from "../src/scene/glb.js";
import { EDGE_COLOR, layerIds, linearColor, modelGlb, SKETCH_LAYER, toScene } from "../src/scene/modelGlb.ts";
import { dependencies, errorText, fingerprint, notesOf, readImports } from "../src/scene/source.ts";
import type { CadModelDoc } from "../src/types.ts";

beforeAll(() => initSubduction());

const model = (content: string, cad: CadModelDoc["cad"] = {}): CadModelDoc => ({ title: "Bracket", content, mimeType: "application/javascript", cad });
const A = generateAutomergeUrl();
const B = generateAutomergeUrl();

test("a model's fingerprint is its code and locks, nothing else it keeps", () => {
  const base = model("export default () => 1;", { locks: { [A]: ["h2", "h1"] } });
  expect(fingerprint({ ...base, title: "Renamed", cad: { ...base.cad, views: [] } })).toBe(fingerprint(base));
  expect(fingerprint({ ...base, cad: { locks: { [A]: ["h1", "h2"] } } })).toBe(fingerprint(base));
  expect(fingerprint({ ...base, content: "export default () => 2;" })).not.toBe(fingerprint(base));
  expect(fingerprint({ ...base, cad: { locks: { [A]: ["h3"] } } })).not.toBe(fingerprint(base));
});

test("a model depends on the documents it follows without a lock", () => {
  const code = `import a from "${A}";\nimport b from "${B}/rows/@0" with { type: "json" };\nimport c from "${A}#abc";\n`;
  expect(dependencies(model(code))).toEqual([A, B]);
  expect(dependencies(model(code, { locks: { [A]: ["h"] } }))).toEqual([B]);
  expect(dependencies(model(`import c from "${A}#abc";`))).toEqual([]);
  expect(dependencies(undefined)).toEqual([]);
});

test("imports are read at the editor's locks, from the repo the scene gives", async () => {
  const repo = new Repo();
  const data = repo.create<{ width: number }>({ width: 10 });
  const before = data.heads();
  data.change((d) => (d.width = 20));
  const source = `import { width } from "${data.url}";\n`;
  const latest = await readImports(source, model(source), repo);
  expect(latest[data.url]).toEqual({ kind: "data", value: { width: 20 } });
  const locked = await readImports(source, model(source, { locks: { [data.url]: before } }), repo);
  expect(locked[data.url]).toEqual({ kind: "data", value: { width: 10 } });
  // A lock this repo doesn't have the version of reads the document as it is.
  const unknown = await readImports(source, model(source, { locks: { [data.url]: ["2ZpxcJvGYuEcyRaZUAgfQMTVkZz6HTaLMLtrmn4sDmDw"] } }), repo);
  expect(unknown[data.url]).toEqual({ kind: "data", value: { width: 20 } });
  expect((await readImports(`import x from "${A}" with { type: "text" };`, model(""), undefined))[moduleKey(A, "text")]).toMatchObject({ kind: "problem" });
});

test("points go from Z up in millimetres to Y up in metres", () => {
  expect(Array.from(toScene([1000, 2000, 3000]))).toEqual([1, 3, -2]);
  expect(Array.from(toScene([0, 0, 1], 1))).toEqual([0, 1, -0]);
});

test("a shape without a colour takes the theme's; one with a colour or an opacity keeps it", () => {
  expect(linearColor(undefined, undefined)).toBeUndefined();
  expect(linearColor(undefined, 1)).toBeUndefined();
  expect(linearColor("red", undefined)).toEqual([1, 0, 0, 1]);
  expect(linearColor("#ff0000", 0.5)).toEqual([1, 0, 0, 0.5]);
  expect(linearColor(undefined, 0.5)?.[3]).toBe(0.5);
});

test("layers are named by what main returns, unique and in order", () => {
  expect(layerIds([{ name: "plate", body: "fillet1" }, { name: "", body: "extrude2" }, { name: "plate", body: "cut1" }, { name: "sketches", body: undefined }])).toEqual(["plate", "extrude2", "plate 2", "sketches 2"]);
});

/** A unit square in the XY plane at height `z`, with its outline as edges. */
const square = (name: string, z: number, extra: Partial<MeshedShape> = {}): MeshedShape => ({
  name,
  color: undefined,
  opacity: undefined,
  faces: { vertices: [0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z], triangles: [0, 1, 2, 0, 2, 3], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] },
  edges: { lines: [0, 0, z, 10, 0, z, 10, 0, z, 10, 10, z] },
  body: name,
  faceIndex: undefined,
  edgeIndex: undefined,
  features: undefined,
  ...extra,
});

test("a build is a GLB of a node per shape, on its own layer, with dark edges and sketches on a layer", () => {
  const sketch = { name: "sketch1", outline: [{ points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] as [number, number, number][], closed: true }] };
  const { glb, bounds, triangles } = modelGlb([square("plate", 0), square("lid", 20, { color: "#00ff00" })], [sketch]);
  const { json } = parseGLB(glb);
  expect(json.scene !== undefined || json.scenes.length === 1).toBe(true);
  expect(json.nodes.map((n: { name: string; extras: unknown }) => [n.name, n.extras])).toEqual([
    ["plate", { layer: "plate" }],
    ["lid", { layer: "lid" }],
    ["Sketches", { layer: SKETCH_LAYER }],
  ]);
  expect(json.scenes[0].extras.layers).toEqual([
    { id: "plate", name: "plate" },
    { id: "lid", name: "lid" },
    { id: SKETCH_LAYER, name: "Sketches" },
  ]);
  const [plate, lid, sketches] = json.meshes;
  expect(plate.primitives.map((p: { mode?: number }) => p.mode ?? 4)).toEqual([4, 1]);
  // Faces without a colour have no baseColor of their own; edges are unlit and dark.
  expect(json.materials[plate.primitives[0].material]?.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1]).toEqual([1, 1, 1, 1]);
  expect(json.materials[lid.primitives[0].material].pbrMetallicRoughness.baseColorFactor).toEqual([0, 1, 0, 1]);
  const edge = json.materials[plate.primitives[1].material];
  expect(edge.extensions).toHaveProperty("KHR_materials_unlit");
  expect(EDGE_COLOR).toMatch(/^#/);
  // A closed outline of three points is three segments.
  expect(json.accessors[sketches.primitives[0].attributes.POSITION].count).toBe(6);
  expect(triangles).toBe(4);
  expect(bounds?.min.map((v) => +v.toFixed(6))).toEqual([0, 0, -0.01]);
  expect(bounds?.max.map((v) => +v.toFixed(6))).toEqual([0.01, 0.02, 0]);
});

test("an empty build is a valid GLB with nothing in it", () => {
  const { glb, bounds } = modelGlb([]);
  expect(parseGLB(glb).json.asset.version).toBe("2.0");
  expect(bounds).toBeUndefined();
});

test("a render says what didn't work", () => {
  const trace = [{ name: "fillet1", status: "failed", message: "BRep_API: command not done" }, { name: "extrude1", status: "ok" }] as never;
  expect(notesOf([square("a", 0)], 0, trace, 0)).toBe("1 feature is broken or failed: fillet1 (BRep_API: command not done)");
  expect(notesOf([], 0, [], 2)).toBe("2 returned values can't be shown. main() returns nothing to show");
  expect(notesOf([square("a", 0)], 0, [], 0)).toBeUndefined();
  expect(errorText({ kind: "syntax", line: 3, message: "Unexpected token" })).toBe("syntax error on line 3: Unexpected token");
});
