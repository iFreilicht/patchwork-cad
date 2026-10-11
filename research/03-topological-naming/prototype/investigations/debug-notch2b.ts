/** OCCT's fillet reports an untouched edge as deleted although it is still (IsSame) in the result. */
import { buildCase } from "../src/bench.ts";
import { m1 } from "../src/cases/m1-slotted-block.ts";
import { describe, fmt } from "../src/geom.ts";
import { listToArray, loadOC, subShapes } from "../src/oc.ts";

const o = await loadOC();
const p = { ...m1.params, extraNotch: true };
const s = buildCase(m1, p, m1.features(p)).before("f3");
const at = (x: number, z: number, type: string) => s.edges.find((e) => { const d = describe(e, "edge"); return d.type === type && Math.abs(d.centroid[0] - x) < 1e-6 && Math.abs(d.centroid[2] - z) < 1e-6; })!;
const piece = at(54, 20, "line");
const arc = s.edges.find((e) => { const d = describe(e, "edge"); return d.kind === "edge" && d.type === "circle" && Math.abs(d.center![0] - 30) < 1e-6 && Math.abs(d.center![2] - 20) < 1e-6; })!;
console.log("piece", fmt(describe(piece, "edge").centroid), [...s.edgeHist[s.edges.indexOf(piece)]!]);
const mk = new o.BRepFilletAPI_MakeFillet(s.shape!, o.ChFi3d_FilletShape.ChFi3d_Rational);
mk.Add(1.5, o.TopoDS.Edge(arc));
mk.Build(new o.Message_ProgressRange());
const res = mk.Shape();
console.log("fillet: piece IsDeleted", mk.IsDeleted(piece), "Modified", listToArray(mk.Modified(piece)).length, "IsSame in result", subShapes(res, "edge").some((e) => e.IsSame(piece)));
