// M1 from research/03: a block with a through notch, the notch's top arc filleted, the front-top
// edge right of the notch chamfered, and a boss on the front face right of the notch.
import { sketch, plane, rect, circle, extrude, fillet, chamfer, edge } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, h: 20, a: 30, r: 8 };

export default function main({ w, d, h, a, r }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: h });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [a, 0], radius: r }) });
  const notch = extrude({ sketch: sketch2, operation: "cut", target: extrude1, extent: "through" });
  const fillet1 = fillet({ body: notch, edges: [edge(extrude1.end, notch.side.c)], radius: 1.5 });
  const chamfer1 = chamfer({ body: fillet1, edges: [edge(extrude1.end, extrude1.side.front).piece(notch, 1, { near: [49.75, 0, 20] })], distance: 1 });
  const sketch3 = sketch({ body: chamfer1, plane: extrude1.side.front.piece(notch, 2, { near: [49.501, 0, 9.499] }), profile: circle({ center: [w - 6, h / 2], radius: 2 }) });
  const extrude2 = extrude({ sketch: sketch3, distance: 4, operation: "join", target: chamfer1 });
  return extrude2;
}
