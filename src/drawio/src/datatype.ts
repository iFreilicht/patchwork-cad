import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import { emptyPages, type PageRecord } from "./diagram.ts";
import { emptySvg } from "./svg.ts";

/**
 * A draw.io diagram, shaped as a file so that anything that reads files, e.g. a CAD model's canvas,
 * reads it as the SVG it is: `content` is a .drawio.svg (see svg.ts), exported after each change and
 * replaced whole, so that concurrent exports leave one of them and never mix two into invalid XML.
 * The diagram itself is `pages`, records per cell that collaborators' edits merge into (diagram.ts);
 * a document without them, e.g. one made before them, has its diagram only in the SVG.
 */
export interface DrawioDoc {
  name: string;
  extension: "drawio.svg";
  mimeType: "image/svg+xml";
  content: string;
  pages?: PageRecord[];
}

export const DrawioDatatype: DatatypeImplementation<DrawioDoc> = {
  init(doc) {
    doc.name = "Untitled diagram";
    doc.extension = "drawio.svg";
    doc.mimeType = "image/svg+xml";
    doc.content = emptySvg();
    doc.pages = emptyPages();
  },
  getTitle: (doc) => doc.name || "Untitled diagram",
  setTitle(doc, title) {
    doc.name = title;
  },
};
