import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import { emptySvg } from "./svg.ts";

/**
 * A draw.io diagram, shaped as a file so that anything that reads files, e.g. a CAD model's canvas,
 * reads it as the SVG it is: `content` is a .drawio.svg (see svg.ts), replaced whole on every save,
 * so that concurrent saves leave one of them and never mix two into invalid XML.
 */
export interface DrawioDoc {
  name: string;
  extension: "drawio.svg";
  mimeType: "image/svg+xml";
  content: string;
}

export const DrawioDatatype: DatatypeImplementation<DrawioDoc> = {
  init(doc) {
    doc.name = "Untitled diagram";
    doc.extension = "drawio.svg";
    doc.mimeType = "image/svg+xml";
    doc.content = emptySvg();
  },
  getTitle: (doc) => doc.name || "Untitled diagram",
  setTitle(doc, title) {
    doc.name = title;
  },
};
