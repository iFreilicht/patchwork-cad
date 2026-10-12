import type { CadModelDoc } from "./types.ts";

export const DEFAULT_SOURCE = `import { drawRoundedRectangle, drawCircle } from "replicad";

export const defaultParams = { width: 60, depth: 40, height: 12, hole: 8 };

export default function main({ width, depth, height, hole }) {
  const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
  const bore = drawCircle(hole / 2).sketchOnPlane().extrude(height);
  return plate.cut(bore).fillet(1.5, (e) => e.inPlane("XY", height));
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
