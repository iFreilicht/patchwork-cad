// A diagram as a .drawio.svg (src/svg.ts): the diagram an SVG carries, the SVG of a new document, and
// draw.io's export as text.
import { expect, test } from "vitest";
import { diagramOf, EMPTY_DIAGRAM, emptySvg, textOfDataUri } from "../src/svg.ts";

test("the diagram is the root's content attribute, unescaped; an SVG without one carries none", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="122px" content="&lt;mxfile host=&quot;x&quot;&gt;&lt;diagram name=&quot;Page-1&quot;&gt;jZJN&amp;b&lt;/diagram&gt;&lt;/mxfile&gt;"><g/></svg>`;
  expect(diagramOf(svg)).toBe('<mxfile host="x"><diagram name="Page-1">jZJN&b</diagram></mxfile>');
  expect(diagramOf("<svg xmlns='http://www.w3.org/2000/svg' content='&lt;mxfile/&gt;'/>")).toBe("<mxfile/>");
  expect(diagramOf('<svg xmlns="http://www.w3.org/2000/svg"><rect content="no"/></svg>')).toBeUndefined();
  expect(diagramOf("not svg")).toBeUndefined();
});

test("a new document is an SVG that carries an empty diagram", () => {
  const svg = emptySvg();
  expect(svg.startsWith("<svg")).toBe(true);
  expect(diagramOf(svg)).toBe(EMPTY_DIAGRAM);
});

test("draw.io's export is read as UTF-8 text, base64 or percent-encoded", () => {
  const svg = '<svg content="ä &amp; ö"/>';
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  expect(textOfDataUri(`data:image/svg+xml;base64,${base64}`)).toBe(svg);
  expect(textOfDataUri(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toBe(svg);
});
