// The scene's content provider (src/scene): what a build reads and is rebuilt for, the documents it
// imports at the editor's locks, and the GLB by the scene's conventions. The kernel isn't run here.
import { generateAutomergeUrl, initSubduction, Repo } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { moduleKey } from "../src/kernel/imports.ts";
import type { MeshedShape } from "../src/kernel/protocol.ts";
import { parseGLB } from "../src/scene/glb.js";
import { CANVAS_LIFT, canvasLayer, EDGE_COLOR, layerIds, LINE_WIDTH, linearColor, modelGlb, SKETCH_LAYER, toScene, type GlbCanvas } from "../src/scene/modelGlb.ts";
import { configurationValues, dependencies, errorText, fingerprint, notesOf, params, readImports } from "../src/scene/source.ts";
import type { CadModelDoc } from "../src/types.ts";

beforeAll(() => initSubduction());

const model = (content: string, cad: CadModelDoc["cad"] = {}): CadModelDoc => ({ title: "Bracket", content, mimeType: "application/javascript", cad });
const A = generateAutomergeUrl();
const B = generateAutomergeUrl();

test("a model's fingerprint is its code, locks and configurations, nothing else it keeps", () => {
  const base = model("export default () => 1;", { locks: { [A]: ["h2", "h1"] } });
  expect(fingerprint({ ...base, title: "Renamed", cad: { ...base.cad, views: [] } })).toBe(fingerprint(base));
  expect(fingerprint({ ...base, cad: { locks: { [A]: ["h1", "h2"] } } })).toBe(fingerprint(base));
  expect(fingerprint({ ...base, content: "export default () => 2;" })).not.toBe(fingerprint(base));
  expect(fingerprint({ ...base, cad: { locks: { [A]: ["h3"] } } })).not.toBe(fingerprint(base));
  expect(fingerprint({ ...base, cad: { ...base.cad, configurations: [{ id: "c1", name: "Tall", params: { h: 30 } }] } })).not.toBe(fingerprint(base));
});

test("a placed model is built with one of its configurations, its defaults first", () => {
  const doc = model("", { configurations: [{ id: "c1", name: "Tall", params: { h: 30 } }, { id: "c2", name: "Wide", params: { w: 90 } }] });
  expect(params(doc)).toEqual([
    {
      key: "configuration",
      label: "Configuration",
      kind: "enum",
      default: "",
      options: [
        { value: "", label: "Defaults" },
        { value: "c1", label: "Tall" },
        { value: "c2", label: "Wide" },
      ],
    },
  ]);
  expect(params(undefined)[0]?.options).toEqual([{ value: "", label: "Defaults" }]);
});

test("a configuration's values are read with its linked ones; a link that isn't a number says why", async () => {
  const repo = new Repo();
  const note = repo.create<{ width: string; nested: { not: string } }>({ width: "12.5", nested: { not: "a number" } });
  const w = `${note.url}/width`;
  const d = `${note.url}/nested`;
  const doc = model("", { configurations: [{ id: "c1", name: "Linked", params: { h: 30, w: { link: w }, d: { link: d } } }] });
  const read = await configurationValues(doc, "c1", repo);
  expect(read.values).toEqual({ h: 30, w: 12.5 });
  expect(read.problems).toEqual([expect.stringMatching(/^d: its linked value is .*not a number$/)]);
  // The defaults: no values over the model's own.
  expect(await configurationValues(doc, "", repo)).toEqual({ values: undefined, problems: [] });
  // A configuration's links are documents it is built again for.
  expect(dependencies(doc)).toEqual([note.url]);
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
  expect(latest.imports[data.url]).toEqual({ kind: "data", value: { width: 20 } });
  const locked = await readImports(source, model(source, { locks: { [data.url]: before } }), repo);
  expect(locked.imports[data.url]).toEqual({ kind: "data", value: { width: 10 } });
  // A lock this repo doesn't have the version of reads the document as it is.
  const unknown = await readImports(source, model(source, { locks: { [data.url]: ["2ZpxcJvGYuEcyRaZUAgfQMTVkZz6HTaLMLtrmn4sDmDw"] } }), repo);
  expect(unknown.imports[data.url]).toEqual({ kind: "data", value: { width: 20 } });
  expect((await readImports(`import x from "${A}" with { type: "text" };`, model(""), undefined)).imports[moduleKey(A, "text")]).toMatchObject({ kind: "problem" });
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

test("a build is a GLB of a node per shape, on its own layer, with dark edges and sketches on a layer, both drawn as wide as the editor draws them", () => {
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
  expect(edge.extras).toEqual({ lineWidth: LINE_WIDTH });
  expect(json.materials[sketches.primitives[0].material].extras).toEqual({ lineWidth: LINE_WIDTH });
  expect(json.materials[plate.primitives[0].material]?.extras).toBeUndefined();
  // A closed outline of three points is three segments.
  expect(json.accessors[sketches.primitives[0].attributes.POSITION].count).toBe(6);
  expect(triangles).toBe(4);
  expect(bounds?.min.map((v) => +v.toFixed(6))).toEqual([0, 0, -0.01]);
  expect(bounds?.max.map((v) => +v.toFixed(6))).toEqual([0.01, 0.02, 0]);
});

test("a canvas is a picture on a layer of its own, a hair off its plane; a drawing says it was drawn for a light background", () => {
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const drawing: GlbCanvas = { id: "c1", name: "plan", corners: [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]], normal: [0, 0, 1], image, mimeType: "image/png", opacity: 0.5, drawing: true };
  const photo: GlbCanvas = { ...drawing, id: "c2", name: "photo", image: new Uint8Array([0xff, 0xd8, 0xff, 4]), mimeType: "image/jpeg", drawing: false };
  const { glb } = modelGlb([square("plate", 0)], [], [drawing, photo]);
  const { json } = parseGLB(glb);
  expect(json.scenes[0].extras.layers.slice(1)).toEqual([
    { id: canvasLayer("c1"), name: "plan" },
    { id: canvasLayer("c2"), name: "photo" },
  ]);
  const [, plan, picture] = json.meshes;
  const primitive = plan.primitives[0];
  // The image's top left is its corners' last.
  expect(Array.from(readFloats(json, glb, primitive.attributes.TEXCOORD_0))).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
  // Z up in millimetres, lifted along the plane's normal, to Y up in metres.
  expect(Array.from(readFloats(json, glb, primitive.attributes.POSITION)).slice(0, 3).map((v) => +v.toFixed(9))).toEqual([0, +(CANVAS_LIFT / 1000).toFixed(9), 0]);
  const material = json.materials[primitive.material];
  expect(material.alphaMode).toBe("BLEND");
  expect(material.pbrMetallicRoughness.baseColorFactor[3]).toBe(0.5);
  expect(material.extras).toEqual({ colorScheme: "light" });
  expect(json.materials[picture.primitives[0].material].extras).toBeUndefined();
  expect(json.images.map((i: { mimeType: string }) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
});

/** An accessor's floats, read from the GLB's binary chunk. */
function readFloats(json: { accessors: { bufferView: number; count: number; type: string; byteOffset?: number }[]; bufferViews: { byteOffset?: number }[] }, glb: Uint8Array, index: number): Float32Array {
  const { bin } = parseGLB(glb);
  const a = json.accessors[index]!;
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]!;
  const offset = (json.bufferViews[a.bufferView]!.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return new Float32Array(bin!.buffer.slice(bin!.byteOffset + offset, bin!.byteOffset + offset + a.count * size * 4));
}

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
