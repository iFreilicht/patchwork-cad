// M4 (research/15): bodies that fork, copy and merge. A plate with a boss modelled on its own and
// joined onto it; a copy of the plate cuts a corner out of the result, and another copy is a lid.
// A rounded variant of the plate forks off it and stays private.
import { sketch, plane, rect, circle, extrude, fillet, combine, move, edge } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, h: 8 };

export default function main({ w, d, h }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const plate = extrude({ sketch: sketch1, distance: h });
  const sketch2 = sketch({ plane: plane("XY", h), profile: circle({ center: [w / 2, d / 2], radius: 8 }) });
  const boss = extrude({ sketch: sketch2, distance: 12 });
  const fillet1 = fillet({ body: boss, edges: [edge(boss.end, boss.side.c)], radius: 2 });
  const joined = combine({ target: plate, tools: [fillet1] });
  const rounded = fillet({ body: plate, edges: [edge(plate.side.front, plate.side.right)], radius: 3 });
  const corner = move({ body: plate, x: w / 2, y: d / 2, z: h / 2 });
  const notched = combine({ target: joined, tools: [corner], operation: "cut" });
  const lid = move({ body: plate, z: 30 });
  return [notched, lid];
}
