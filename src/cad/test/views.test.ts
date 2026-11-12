// Named views in the model document (research/18-named-views.md, "Storage"): adding, renaming,
// updating and removing them, their names, and concurrent edits of two users.
import { save } from "@automerge/automerge";
import { initSubduction, Repo, type DocHandle } from "@automerge/automerge-repo";
import { beforeAll, expect, test } from "vitest";
import { nearestRegion, regionName } from "../src/components/ViewCube.ts";
import { addView, freeName, nameProblem, namedViews, removeView, renameView, setHome, updateView } from "../src/model/views.ts";
import { MODEL_MIME_TYPE } from "../src/datatype.ts";
import type { CadModelDoc, CameraState } from "../src/types.ts";

beforeAll(() => initSubduction());

const camera = (x: number): CameraState => ({ direction: [x, -1, 0], target: [1, 2, 3], extent: [100, 50], projection: "perspective" });
const model = (): DocHandle<CadModelDoc> => new Repo().create<CadModelDoc>({ title: "m", content: "", mimeType: MODEL_MIME_TYPE });

test("views are added, renamed, updated and removed by id", () => {
  const handle = model();
  handle.change((d) => addView(d, { id: "a", name: "Front", camera: camera(0) }));
  handle.change((d) => addView(d, { id: "b", name: "Side", camera: camera(1) }));
  expect(namedViews(handle.doc()).map((v) => v.name)).toEqual(["Front", "Side"]);
  handle.change((d) => renameView(d, "a", "Face"));
  handle.change((d) => updateView(d, "b", camera(2)));
  expect(namedViews(handle.doc())).toEqual([
    { id: "a", name: "Face", camera: camera(0) },
    { id: "b", name: "Side", camera: camera(2) },
  ]);
  handle.change((d) => removeView(d, "a"));
  handle.change((d) => removeView(d, "missing"));
  expect(namedViews(handle.doc()).map((v) => v.id)).toEqual(["b"]);
});

test("a view's camera is a copy", () => {
  const handle = model();
  const c = camera(0);
  handle.change((d) => addView(d, { id: "a", name: "Front", camera: c }));
  c.direction[0] = 5;
  expect(namedViews(handle.doc())[0]?.camera.direction).toEqual([0, -1, 0]);
});

test("names are unique and not empty", () => {
  const views = [
    { id: "a", name: "Front", camera: camera(0) },
    { id: "b", name: "Front 2", camera: camera(0) },
  ];
  expect(freeName("Front", views)).toBe("Front 3");
  expect(freeName("Top", views)).toBe("Top");
  expect(nameProblem(views, "a", "Front 2")).toMatch(/already/);
  expect(nameProblem(views, "a", "Front")).toBeUndefined();
  expect(nameProblem(views, "a", "")).toMatch(/name/);
});

test("a new view is named after the nearest ViewCube region", () => {
  expect(regionName(nearestRegion([0, -1, 0]))).toBe("Front");
  expect(regionName(nearestRegion([0.55, -0.85, 0.65]))).toBe("Front Right Top");
  expect(regionName(nearestRegion([0.01, 0.02, 1]))).toBe("Top");
  expect(regionName(nearestRegion([-1, 0.9, 0.05]))).toBe("Back Left");
});

test("two users' concurrent views both stay, and a removal wins over a rename", () => {
  const a = model();
  a.change((d) => addView(d, { id: "x", name: "Front", camera: camera(0) }));
  const b = new Repo().import<CadModelDoc>(save(a.doc()));
  a.change((d) => addView(d, { id: "a", name: "A", camera: camera(1) }));
  b.change((d) => addView(d, { id: "b", name: "B", camera: camera(2) }));
  a.change((d) => removeView(d, "x"));
  b.change((d) => renameView(d, "x", "Renamed"));
  a.merge(b);
  expect(
    namedViews(a.doc())
      .map((v) => v.id)
      .sort(),
  ).toEqual(["a", "b"]);
});

test("Home is moved and reset to the ViewCube's framing", () => {
  const handle = model();
  expect(handle.doc().cad?.home).toBeUndefined();
  handle.change((d) => setHome(d, camera(1)));
  expect(handle.doc().cad?.home).toEqual(camera(1));
  handle.change((d) => setHome(d, undefined));
  expect(handle.doc().cad?.home).toBeUndefined();
  handle.change((d) => setHome(d, undefined));
  expect(handle.doc().cad).toEqual({});
});
