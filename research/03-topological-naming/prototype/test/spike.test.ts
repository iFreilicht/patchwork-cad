import { expect, test } from "vitest";
import init from "replicad-opencascadejs";

test("OCCT loads in Node and reports fillet history", async () => {
  const oc = await init();
  const box = new oc.BRepPrimAPI_MakeBox(10, 20, 30).Shape();

  const faces = (s: InstanceType<typeof oc.TopoDS_Shape>) => {
    const out = [];
    for (const ex = new oc.TopExp_Explorer(s, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) out.push(ex.Current());
    return out;
  };
  const edges = [];
  for (const ex = new oc.TopExp_Explorer(box, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) edges.push(oc.TopoDS.Edge(ex.Current()));

  const mf = new oc.BRepFilletAPI_MakeFillet(box, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  mf.Add(2, edges[0]!);
  mf.Build(new oc.Message_ProgressRange());
  expect(mf.IsDone()).toBe(true);
  const result = mf.Shape();

  let modified = 0, generated = 0, deleted = 0;
  for (const f of faces(box)) {
    if (mf.IsDeleted(f)) deleted++;
    if (mf.Modified(f).Size() > 0) modified++;
  }
  generated = mf.Generated(edges[0]!).Size();
  console.log({ inFaces: faces(box).length, outFaces: faces(result).length, modified, generated, deleted });
  expect(faces(result).length).toBe(7);
  expect(generated).toBe(1);
});
