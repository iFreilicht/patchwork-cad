// M3 from research/03: an L-bracket whose base and upright merge their back faces, with ribs in a
// loop that split the inner corner edge, which is filleted; a hole goes into the merged back face.
import { sketch, plane, rect, polygon, circle, extrude, fillet, chamfer, edge, any, ref } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, t: 8, H: 50, ribs: [30], ribT: 6 };

export default function main({ w, d, t, H, ribs, ribT }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const base = extrude({ sketch: sketch1, distance: t });
  const sketch2 = sketch({ plane: plane("XY", t), profile: rect({ from: [0, 0], to: [w, t] }) });
  const upright = extrude({ sketch: sketch2, distance: H - t, operation: "join", target: base });
  let body = upright;
  for (const [i, x] of ribs.entries()) {
    const profile = polygon({ foot: [t, t], hyp: [t + 20, t], web: [t, t + 20] });
    const rib = sketch({ plane: plane("YZ", x - ribT / 2), profile });
    body = extrude({ sketch: rib, distance: ribT, operation: "join", target: body }, { name: `rib${i}` });
  }
  const corner = edge(upright.side.back, upright.start);
  const fillet1 = fillet({ body, edges: [corner.piece(ref.rib0, 1, { near: [46.5, 8, 8] }), corner.piece(ref.rib0, 2, { near: [13.5, 8, 8] })], radius: 2 });
  const chamfer1 = chamfer({ body: fillet1, edges: [edge(upright.end, upright.side.front)], distance: 1 });
  const sketch3 = sketch({ body: chamfer1, plane: any(base.side.front, upright.side.front), profile: circle({ center: [w / 2, (t + H) / 2], radius: 4 }) });
  const extrude1 = extrude({ sketch: sketch3, distance: 5, operation: "cut", target: chamfer1 });
  return extrude1;
}
