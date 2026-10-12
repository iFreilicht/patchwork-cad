import type { CadModelDoc } from "./types.ts";

export const DEFAULT_SOURCE = `import { sketch, plane, rect, circle, extrude, fillet, edge } from "@patchwork-cad/features";

export const defaultParams = { width: 60, depth: 40, height: 12, hole: 8 };

export default function main({ width, depth, height, hole }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [width, depth] }) });
  const plate = extrude({ sketch: sketch1, distance: height });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [width / 2, depth / 2], radius: hole / 2 }) });
  const bore = extrude({ sketch: sketch2, operation: "cut", target: plate, extent: "through" });
  const fillet1 = fillet({ body: bore, edges: [edge(plate.end, bore.side.c)], radius: 1.5 });
  return fillet1;
}
`;

export const CadModelDatatype = {
  init(doc: CadModelDoc) {
    doc.title = "CAD Model";
    doc.source = DEFAULT_SOURCE;
  },
  getTitle(doc: CadModelDoc) {
    return doc.title || "CAD Model";
  },
  setTitle(doc: CadModelDoc, title: string) {
    doc.title = title;
  },
  markCopy(doc: CadModelDoc) {
    doc.title = `Copy of ${CadModelDatatype.getTitle(doc)}`;
  },
};
