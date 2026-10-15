import type { CadModelViewDoc } from "./types.ts";

/** Views are made by dragging a ViewCube region out of a model, so the datatype is unlisted and `init` has no model to point at. */
export const CadModelViewDatatype = {
  init(doc: CadModelViewDoc) {
    doc.title = "CAD View";
  },
  getTitle(doc: CadModelViewDoc) {
    return doc.title || "CAD View";
  },
  setTitle(doc: CadModelViewDoc, title: string) {
    doc.title = title;
  },
  markCopy(doc: CadModelViewDoc) {
    doc.title = `Copy of ${CadModelViewDatatype.getTitle(doc)}`;
  },
};
