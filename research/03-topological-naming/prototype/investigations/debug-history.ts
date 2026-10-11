/** What history do MakeRevol and MakeThickSolid report? (Revolve end disks: none; shell inner faces: Generated.) */
import { describeFace, fmt } from "../src/geom.ts";
import { listToArray, loadOC, progress, subShapes } from "../src/oc.ts";

const o = await loadOC();
const P = (x: number, y: number, z: number) => new o.gp_Pnt(x, y, z);
// revolve: rectangle in the XZ plane around Z
const pts = [P(0, 0, 0), P(10, 0, 0), P(10, 0, 20), P(0, 0, 20)];
const w = new o.BRepBuilderAPI_MakeWire();
for (let i = 0; i < 4; i++) w.Add(new o.BRepBuilderAPI_MakeEdge(pts[i]!, pts[(i + 1) % 4]!).Edge());
const face = new o.BRepBuilderAPI_MakeFace(w.Wire(), true).Face();
const mk = new o.BRepPrimAPI_MakeRevol(face, new o.gp_Ax1(P(0, 0, 0), new o.gp_Dir(0, 0, 1)), false);
mk.Build(progress());
const res = mk.Shape();
console.log("revolve result faces:", subShapes(res, "face").map((f) => describeFace(f).type + fmt(describeFace(f).centroid)));
for (const e of subShapes(face, "edge")) {
  const g = listToArray(mk.Generated(e));
  console.log("edge generated", g.length, g.map((s) => s.ShapeType()), "in result:", g.map((s) => subShapes(res, "face").some((f) => f.IsSame(s))));
}

// shell: box without its top face
const box = new o.BRepPrimAPI_MakeBox(60, 40, 20).Shape();
const bf = subShapes(box, "face");
const top = bf.find((f) => describeFace(f).centroid[2] > 19)!;
const list = new o.NCollection_List_TopoDS_Shape();
list.Append(top);
const th = new o.BRepOffsetAPI_MakeThickSolid();
th.MakeThickSolidByJoin(box, list, -2, 1e-3);
th.Build(progress());
const sf = subShapes(th.Shape(), "face");
for (const f of bf) {
  const tag = (m: typeof f) => fmt(describeFace(m).centroid) + (sf.some((x) => x.IsSame(m)) ? "✓" : "✗");
  const generated = listToArray((th as unknown as { Generated(s: typeof f): Parameters<typeof listToArray>[0] }).Generated(f));
  console.log("box face", fmt(describeFace(f).centroid), "deleted", th.IsDeleted(f), "same in result", sf.some((x) => x.IsSame(f)), "modified", listToArray(th.Modified(f)).map(tag), "generated", generated.map(tag));
}
