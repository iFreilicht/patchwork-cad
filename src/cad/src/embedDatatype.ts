import type { CadModelEmbedDoc } from "./types.ts";

/** Embeds are dragged out of a model's named views, so the datatype is unlisted and `init` has no model to point at. */
export const CadModelEmbedDatatype = {
  init(doc: CadModelEmbedDoc) {
    doc.title = "CAD Embed";
  },
  getTitle(doc: CadModelEmbedDoc) {
    return doc.title || "CAD Embed";
  },
  setTitle(doc: CadModelEmbedDoc, title: string) {
    doc.title = title;
  },
  markCopy(doc: CadModelEmbedDoc) {
    doc.title = `Copy of ${CadModelEmbedDatatype.getTitle(doc)}`;
  },
};
