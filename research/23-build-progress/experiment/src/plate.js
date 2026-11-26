// A perforated plate, slow on purpose: a grid of holes cut one feature at a time, each cut a
// boolean on a growing body, then one fillet of every hole's top edge and the outer top edges. With
// `combine`, the holes are extruded as bodies of their own and cut in one feature, which then takes
// most of the build.
import { sketch, plane, rect, circle, extrude, fillet, chamfer, combine, edge } from "@patchwork-cad/features";

export const defaultParams = { n: 6, m: 4, pitch: 12, r: 3, t: 6, fil: 0.8, combine: false };

export default function main({ n, m, pitch, r, t, fil, combine: once }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [n * pitch, m * pitch] }) });
  const plate = extrude({ sketch: sketch1, distance: t });
  let body = plate;
  const holes = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const s = sketch({ plane: plane("XY", once ? -1 : 0), profile: circle({ center: [(i + 0.5) * pitch, (j + 0.5) * pitch], radius: r }) }, { name: `s${i}_${j}` });
      const hole = once ? extrude({ sketch: s, distance: t + 2 }, { name: `hole${i}_${j}` }) : extrude({ sketch: s, operation: "cut", target: body, extent: "through" }, { name: `hole${i}_${j}` });
      if (!once) body = hole;
      holes.push(hole);
    }
  if (once) body = combine({ target: plate, tools: holes, operation: "cut" });
  const edges = holes.map((h) => edge(plate.end, h.side.c));
  const fillet1 = fillet({ body, edges, radius: fil });
  const chamfer1 = chamfer({ body: fillet1, edges: ["front", "right", "back", "left"].map((s) => edge(plate.end, plate.side[s])), distance: 0.5 });
  return { plate: chamfer1 };
}
