/** In isolation, a cut splitting M1's front-top edge reports both pieces as Modified, with or without SimplifyResult. */
import { buildCase } from "../src/bench.ts";
import { m1 } from "../src/cases/m1-slotted-block.ts";
import { describe, fmt } from "../src/geom.ts";
import { listToArray, loadOC, progress, subShapes } from "../src/oc.ts";

const o = await loadOC();
const s = buildCase(m1, m1.params, m1.features(m1.params)).before("f3");
const onFrontTop = (e: Parameters<typeof describe>[0]) => {
  const d = describe(e, "edge");
  return d.kind === "edge" && d.type === "line" && d.ends.every((v) => Math.abs(v[1]) < 1e-6 && Math.abs(v[2] - 20) < 1e-6);
};
const target = s.edges.find((e) => onFrontTop(e) && describe(e, "edge").centroid[0] > 40)!;
console.log("target", fmt(describe(target, "edge").centroid));
const circ = new o.gp_Circ(new o.gp_Ax2(new o.gp_Pnt(45, 0, -500), new o.gp_Dir(0, 0, 1)), 3);
const face = new o.BRepBuilderAPI_MakeFace(new o.BRepBuilderAPI_MakeWire(new o.BRepBuilderAPI_MakeEdge(circ).Edge()).Wire(), true).Face();
const tool = new o.BRepPrimAPI_MakePrism(face, new o.gp_Vec(0, 0, 1000), false, true).Shape();
for (const simplify of [false, true]) {
  const bop = new o.BRepAlgoAPI_Cut(s.shape!, tool, progress());
  if (simplify) bop.SimplifyResult(true, true, 1e-3);
  const res = bop.Shape();
  const inRes = (x: typeof target) => subShapes(res, "edge").some((e) => e.IsSame(x));
  console.log(`simplify=${simplify} deleted=${bop.IsDeleted(target)} modified:`, listToArray(bop.Modified(target)).map((m) => fmt(describe(m, "edge").centroid) + (inRes(m) ? "✓" : "✗")));
}
