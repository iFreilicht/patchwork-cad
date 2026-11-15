import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { extrude, plane, registerFont, sketch, svg, type Profile } from "../src/index.ts";
import { beginBuild, currentTrace } from "../src/runtime.ts";
import { parsePathData, parseXml } from "../src/svg.ts";
import { loadOC } from "./oc.ts";

beforeAll(async () => {
  await loadOC();
  // The devshell's fonts, which the editor bundles (flake.nix, CAD_FONTS).
  const dir = process.env["CAD_FONTS"];
  if (!dir) throw new Error("CAD_FONTS isn't set: run the tests inside `nix develop`");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ttf"))) registerFont(readFileSync(join(dir, file)));
});

const doc = (body: string, attrs = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const paths = (p: Profile) => (p.kind === "paths" ? p : (undefined as never));

/** The regions of a profile on XY, as `loops: area` sorted, areas rounded. */
function regions(profile: Profile, digits = 0): string[] {
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile });
  expect(currentTrace().at(-1)?.message).toBeUndefined();
  return s.regions.map((r) => `${r.loops.join("+")}: ${r.area.toFixed(digits)}${r.filled ? "" : " (unfilled)"}`).sort();
}

test("basic shapes are loops named by their ids, or by tag and number", () => {
  const p = svg(
    doc(`<rect id="plate" x="0" y="0" width="40" height="20"/>
      <circle cx="70" cy="10" r="5"/>
      <ellipse cx="70" cy="40" rx="10" ry="5"/>
      <polygon points="0,50 20,50 10,70"/>
      <polyline points="40,50 60,50 60,70" fill="none"/>
      <line x1="80" y1="80" x2="90" y2="90"/>
      <rect x="0" y="80" width="10" height="10" rx="2"/>`),
    { scale: 1 },
  );
  expect(paths(p).paths.map((x) => `${x.id}${x.closed ? "" : " (open)"}: ${x.segments.map((s) => s.id).join(" ")}`)).toEqual([
    "plate: plate.1 plate.2 plate.3 plate.4",
    "circle1: circle1.1",
    "ellipse1: ellipse1.1",
    "polygon1: polygon1.1 polygon1.2 polygon1.3",
    "polyline1 (open): polyline1.1 polyline1.2",
    "line1 (open): line1.1",
    "rect1: rect1.1 rect1.2 rect1.3 rect1.4 rect1.5 rect1.6 rect1.7 rect1.8",
  ]);
  expect(paths(p).warnings).toEqual([]);
  expect(regions(p, 2)).toEqual(["circle1: 78.54", "ellipse1: 157.08", "plate: 800.00", "polygon1: 200.00", `rect1: ${(100 - (4 - Math.PI) * 4).toFixed(2)}`]);
});

test("overlapping shapes enclose a region per part, and a group's id names what has none", () => {
  const p = svg(doc(`<g id="marks"><rect x="0" y="0" width="10" height="10"/><rect x="5" y="5" width="10" height="10" fill="none"/></g>`));
  expect(regions(p)).toEqual(["marks/rect1+marks/rect2: 25", "marks/rect1: 75", "marks/rect2: 75 (unfilled)"]);
});

test("size: absolute units are kept, a pixel is a millimetre, and width, height or scale set it", () => {
  const size = (p: Profile) => {
    const xs = paths(p).paths.flatMap((x) => [x.start, ...x.segments.map((s) => (s.curve.kind === "arc" ? s.curve.center : s.curve.to))]);
    const span = (i: 0 | 1) => Math.max(...xs.map((q) => q[i])) - Math.min(...xs.map((q) => q[i]));
    return [+span(0).toFixed(6), +span(1).toFixed(6)];
  };
  const square = `<rect x="10" y="10" width="20" height="10"/>`;
  expect(size(svg(doc(square, 'width="200mm" height="200mm" viewBox="0 0 100 100"')))).toEqual([40, 20]);
  expect(size(svg(doc(square, 'width="1in" viewBox="0 0 25.4 25.4"')))).toEqual([20, 10]);
  expect(size(svg(doc(square, 'width="50" viewBox="0 0 100 100"')))).toEqual([10, 5]);
  expect(size(svg(doc(square, 'viewBox="0 0 100 100"')))).toEqual([20, 10]);
  expect(size(svg(doc(square, 'width="10mm" height="10mm"')))).toEqual([20 * (25.4 / 96), 10 * (25.4 / 96)].map((v) => +v.toFixed(6)));
  expect(size(svg(doc(square), { width: 50 }))).toEqual([50, 25]);
  expect(size(svg(doc(square), { height: 50 }))).toEqual([100, 50]);
  expect(size(svg(doc(square), { scale: 3 }))).toEqual([60, 30]);
  // Centred on `center`, y up: the top left corner of the drawing is at the top left.
  const placed = paths(svg(doc(square), { center: [100, 50] }));
  expect(placed.paths[0]!.start).toEqual([90, 55]);
  expect(svg(doc(square), { width: 10, height: 10 })).toMatchObject({ error: "svg(): give one of scale, width and height" });
  expect(svg(doc(square), { width: -1 })).toMatchObject({ error: "svg(): width must be a positive number, got -1" });
});

test("transforms, nested viewports and uses", () => {
  const p = svg(
    doc(`<defs><path id="tri" d="M0 0 L10 0 L0 10 Z"/><symbol id="sq" viewBox="0 0 1 1"><rect width="1" height="1"/></symbol></defs>
      <g transform="translate(50 50) scale(2)"><rect id="r" width="5" height="5"/></g>
      <g transform="rotate(45)"><rect id="d" x="-1" y="-1" width="2" height="2"/></g>
      <use id="u1" href="#tri" x="20"/><use xlink:href="#tri" x="40" transform="matrix(1 0 0 2 0 0)"/>
      <use href="#sq" x="0" y="80" width="10" height="10"/>
      <svg x="80" y="80" width="20" height="10" viewBox="0 0 2 2"><rect id="nested" width="2" height="2"/></svg>
      <use href="#missing"/>`),
    { scale: 1 },
  );
  expect(regions(p, 3)).toEqual(["d: 4.000", "nested: 100.000", "r: 100.000", "u1/tri: 50.000", "use1/tri: 100.000", "use2/rect1: 100.000"]);
  expect(paths(p).warnings).toEqual(['use: "#missing" isn\'t an element of the drawing']);
});

test("what isn't shown isn't drawn, and what can't be drawn is said", () => {
  const p = svg(
    doc(`<style>.hidden { display: none } .ghost { visibility: hidden }</style>
      <rect id="a" width="10" height="10" display="none"/><rect class="hidden" width="10" height="10"/><rect class="ghost" width="10" height="10"/>
      <g visibility="hidden"><rect id="shown" visibility="visible" width="10" height="10"/></g>
      <image href="x.png" width="10" height="10"/><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
      <switch><foreignObject requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility" width="10" height="10"/><rect id="fallback" x="20" width="10" height="10"/></switch>
      <rect id="clipped" x="40" width="10" height="10" clip-path="url(#c)"/>
      <path id="open" d="M60 0 L70 0 L70 10"/>
      <path id="bad" d="M80 0 L90 0 L90 10 L 80 Z"/>
      <inkscape:namedview xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"/>`),
  );
  expect(paths(p).paths.map((x) => x.id)).toEqual(["shown", "fallback", "clipped", "open", "bad"]);
  expect(paths(p).warnings).toEqual([
    "image: images aren't drawn",
    "foreignObject: HTML in a foreignObject isn't drawn",
    "clipped: clip paths aren't applied",
    "open: filled, but not closed, so it encloses no profile",
    'bad: its path data has an error, "L" at 19 lacks numbers; it is drawn up to there',
    "bad: filled, but not closed, so it encloses no profile",
  ]);
});

test("fills: attributes, style sheets and style attributes, rules, and none", () => {
  const p = svg(
    doc(`<style>/* Illustrator's */ .cls-1{fill:none;} #ring { fill-rule: evenodd } rect.solid { fill: red } g > rect { fill: blue }</style>
      <path id="ring" d="M0 0H30V30H0Z M10 10H20V20H10Z"/>
      <path id="same" d="M40 0H70V30H40Z M50 10H60V20H50Z"/>
      <rect class="cls-1" x="80" width="10" height="10"/>
      <rect class="cls-1 solid" x="80" y="20" width="10" height="10"/>
      <rect class="solid" x="80" y="40" width="10" height="10" style="fill: none"/>
      <rect x="80" y="60" width="10" height="10" fill="none" style="fill: inherit"/>`),
  );
  expect(regions(p)).toEqual(["rect1: 100 (unfilled)", "rect2: 100", "rect3: 100 (unfilled)", "rect4: 100", "ring.1+ring.2: 100 (unfilled)", "ring.1: 800", "same.1+same.2: 100", "same.1: 800"]);
  expect(paths(p).warnings).toEqual(['CSS rules "g > rect" aren\'t applied']);
});

test("path data: every command, relative and absolute, implicit repeats, packed numbers and flags", () => {
  const { subs, error } = parsePathData("M0,0 10.5.5l-1-1h2v2H0V0zm5 5 1 1 1-1c1 1 2 2 3 3s1 1 2 2q1 1 2 2t1 1a5 5 0 0110 0A5,5,0,1,1,5,5z l1 1");
  expect(error).toBeUndefined();
  expect(subs.map((s) => [s.closed, s.curves.map((c) => c.kind[0]).join("")])).toEqual([
    [true, "llllll"],
    [true, "llbbbbaa"],
    [false, "l"],
  ]);
  // After z, a command without m starts at the subpath's start.
  expect(subs[2]!.start).toEqual([5, 5]);
  // S and T reflect the previous control point.
  expect(subs[1]!.curves[3]).toEqual({ kind: "bezier", controls: [[11, 9], [11, 9]], to: [12, 10] });
  expect(subs[1]!.curves[5]).toEqual({ kind: "bezier", controls: [[15, 13]], to: [15, 13] });
  expect(parsePathData("M0 0 L10 0 L10 x10")).toEqual({ subs: [{ start: [0, 0], curves: [{ kind: "line", to: [10, 0] }], closed: false }], error: '"L" at 11 lacks numbers' });
  expect(parsePathData("10 10").error).toBe('unexpected "1" at 0');
});

test("arcs: SVG's endpoint form, radii scaled up to fit, and none for a zero radius", () => {
  // A half disc of radius 5 from an arc that is too small for its chord, and its chord.
  expect(regions(svg(doc(`<path id="h" d="M0 0 A1 1 0 0 1 10 0 Z"/>`), { scale: 1 }), 4)).toEqual([`h: ${(12.5 * Math.PI).toFixed(4)}`]);
  // A quarter of an ellipse turned by 30°, large arc: three quarters, and the triangle to its centre.
  const big = regions(svg(doc(`<path id="e" d="M0 0 A20 10 30 1 0 10 10 L0 0Z"/>`), { scale: 1 }), 3);
  expect(big).toHaveLength(1);
  expect(regions(svg(doc(`<path id="z" d="M0 0 A0 5 0 0 1 10 0 L10 10Z"/>`), { scale: 1 }))).toEqual(["z: 50"]);
});

test("a drawing that can't be read fails its sketch alone", () => {
  for (const [source, error] of [
    ["<svg><rect></svg>", "svg(): the SVG isn't well-formed XML: </svg> closes <rect> on line 1"],
    ["not xml", "svg(): the SVG isn't well-formed XML: text outside the root element on line 1"],
    ['<html xmlns="http://www.w3.org/1999/xhtml"/>', "svg(): the file is <html>, not an SVG drawing"],
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]), "svg(): the file isn't text"],
  ] as const) {
    beginBuild({ lenient: true });
    const s = sketch({ plane: plane("XY"), profile: svg(source) });
    expect(currentTrace().at(-1)).toMatchObject({ status: "failed", message: error });
    extrude({ sketch: s });
    expect(currentTrace().at(-1)).toMatchObject({ status: "failed" });
  }
  // Entities of Illustrator's DOCTYPE, CDATA, comments and a BOM.
  const illustrator = `﻿<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><!-- c --><svg xmlns="&ns_svg;" viewBox="0 0 10 10"><style><![CDATA[.a{fill:none}]]></style><rect class="a" width="10" height="10"/></svg>`;
  expect(regions(svg(illustrator))).toEqual(["rect1: 100 (unfilled)"]);
  expect(parseXml(`<svg a="&lt;&#65;&#x42;"/>`).attrs["a"]).toBe("<AB");
});

test("only: the elements with these ids, with what they contain", () => {
  const p = svg(doc(`<g id="leaf"><rect width="10" height="10"/><circle cx="20" cy="5" r="5"/></g><rect id="frame" width="100" height="100"/>`), { only: ["leaf", "nope"] });
  expect(paths(p).paths.map((x) => x.id)).toEqual(["leaf/rect1", "leaf/circle1"]);
  expect(paths(p).warnings).toEqual(['only: no element has the id "nope"']);
});

test("text: glyph outlines of the named font, its holes unfilled, laid out by SVG's rules", () => {
  const p = svg(doc(`<text id="t" x="10" y="50" font-family="Liberation Sans" font-size="20">Ob</text>`));
  // O and b have a counter each.
  const r = regions(p);
  expect(r.filter((x) => x.endsWith("(unfilled)"))).toHaveLength(2);
  expect(r.filter((x) => !x.endsWith("(unfilled)"))).toHaveLength(2);
  expect(paths(p).warnings).toEqual([]);
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile: p });
  const letters = extrude({ sketch: s, regions: s.filled, distance: 1 });
  expect(currentTrace().at(-1)?.status).toBe("ok");
  expect(letters.topo.faces.length).toBeGreaterThan(10);
});

test("text: a font that isn't there is drawn in another, and said so", () => {
  const warnings = (family: string, body = "Hi") => paths(svg(doc(`<text font-family="${family}">${body}</text>`))).warnings;
  expect(warnings("sans-serif")).toEqual([]);
  expect(warnings("'Liberation Mono', monospace")).toEqual([]);
  expect(warnings("Helvetica")).toEqual(['text1: "Helvetica" isn\'t available: drawn in Liberation Sans, which has its metrics']);
  expect(warnings("Roboto, Arial, sans-serif")).toEqual(['text1: "Roboto", "Arial" aren\'t available: drawn in Liberation Sans, which has the metrics of Arial']);
  expect(warnings("Roboto, sans-serif")).toEqual(['text1: "Roboto" isn\'t available: drawn in Liberation Sans']);
  expect(warnings("Comic Sans MS")).toEqual(['text1: "Comic Sans MS" isn\'t available: drawn in Liberation Serif']);
  expect(warnings("serif", "漢a")).toEqual(['text1: "漢" isn\'t in Liberation Serif or any other font, and isn\'t drawn']);
  // A font given to svg() by family, e.g. an imported TTF file.
  const mono = readFileSync(join(process.env["CAD_FONTS"]!, "LiberationMono-Regular.ttf"));
  expect(paths(svg(doc(`<text font-family="Brand">Hi</text>`), { fonts: { Brand: mono } })).warnings).toEqual([]);
  expect(paths(svg(doc(`<text font-family="Brand">Hi</text>`), { fonts: { Brand: new Uint8Array([1, 2, 3]) } })).warnings[0]).toMatch(/^text1: the font given for "Brand" can't be read/);
});

test("text: anchors, spacing, positions, styles and white space", () => {
  const extent = (body: string) => {
    const pts = paths(svg(doc(body), { scale: 1, center: [0, 0] })).paths.flatMap((x) => [x.start]);
    return [Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0]))];
  };
  const width = (body: string) => {
    const [a, b] = extent(body);
    return b! - a!;
  };
  const plain = width(`<text font-family="Liberation Sans" font-size="20">AB</text>`);
  expect(width(`<text font-family="Liberation Sans" font-size="20" letter-spacing="10">AB</text>`)).toBeCloseTo(plain + 10, 1);
  expect(width(`<text font-family="Liberation Sans" font-size="20">A  \n B</text>`)).toBeGreaterThan(plain);
  expect(width(`<text font-family="Liberation Sans" font-size="40">AB</text>`)).toBeCloseTo(2 * plain, 1);
  // Each anchor moves the text by its advance, or half of it, with y unchanged.
  // Measured from a rectangle, as svg() centres the whole drawing.
  const at = (anchor: string) => {
    const [rect, text] = paths(svg(doc(`<rect x="0" y="0" width="1" height="1"/><text x="50" y="50" text-anchor="${anchor}" font-family="Liberation Sans" font-size="20">AB</text>`), { scale: 1 })).paths;
    return text!.start[0] - rect!.start[0];
  };
  expect(at("start") - at("middle")).toBeCloseTo(at("middle") - at("end"), 6);
  // A and B advance 1366 units of 2048 each in Liberation Sans.
  expect(at("start") - at("end")).toBeCloseTo((2 * 1366 * 20) / 2048, 6);
  const bold = paths(svg(doc(`<text font-family="Liberation Sans" font-weight="bold">B</text><text font-family="Liberation Sans" style="font: italic bold 12px Liberation Sans">B</text>`)));
  expect(bold.warnings).toEqual([]);
  const tspans = paths(svg(doc(`<text font-family="Liberation Sans"><tspan x="0" y="10">a</tspan><tspan x="0" y="30" dx="5">b</tspan><textPath href="#p">c</textPath></text>`)));
  expect(tspans.warnings).toEqual(["text1: text on a path isn't drawn"]);
  expect(paths(svg(doc(`<text font-family="Liberation Sans" rotate="10">a</text>`))).warnings).toEqual(["text1: rotate isn't applied"]);
});

test("draw.io's labels: a switch draws the text that HTML falls back on", () => {
  const drawio = doc(
    `<g data-cell-id="0"><g data-cell-id="1"><g data-cell-id="box"><rect x="10" y="10" width="80" height="40" fill="#ffffff" stroke="#000000"/></g><g data-cell-id="label"><switch><foreignObject width="100%" height="100%" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility"><div xmlns="http://www.w3.org/1999/xhtml">Hi</div></foreignObject><text x="50" y="34" fill="rgb(0, 0, 0)" font-family="Helvetica" font-size="12px" text-anchor="middle">Hi</text></switch></g></g></g>`,
  );
  const p = paths(svg(drawio));
  expect(p.paths.map((x) => x.id.replace(/\.\d+$/, ""))).toEqual(["box/rect1", "label/text1", "label/text1", "label/text1"]);
  expect(p.warnings).toEqual(['label/text1: "Helvetica" isn\'t available: drawn in Liberation Sans, which has its metrics']);
});

test("a self-crossing path encloses a region per part, filled by its rule", () => {
  // A pentagram: five tips, wound once, and the pentagon in the middle, wound twice.
  const star = (rule: string) => svg(doc(`<path id="star" fill-rule="${rule}" d="M50 0 L79 90 L2 35 L98 35 L21 90 Z"/>`));
  const nonzero = regions(star("nonzero"));
  expect(nonzero).toHaveLength(6);
  expect(nonzero.every((r) => !r.endsWith("(unfilled)"))).toBe(true);
  const evenodd = regions(star("evenodd"));
  expect(evenodd.filter((r) => r.endsWith("(unfilled)"))).toHaveLength(1);
  // All six lie inside the star alone: a point tells them apart.
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile: star("evenodd") }, { name: "s", variable: true });
  extrude({ sketch: s, regions: [s.region("star")] });
  expect(currentTrace().at(-1)).toMatchObject({ status: "broken", refs: [{ status: "ambiguous", matches: [0, 1, 2, 3, 4, 5] }] });
  const tips = extrude({ sketch: s, regions: s.filled, distance: 1 });
  expect(currentTrace().at(-1)?.status).toBe("ok");
  expect(tips.topo.faces.length).toBe(5 * 5);
});

test("a shape drawn twice, as a fill and a stroke over it, is one region inside both", () => {
  const p = svg(doc(`<rect id="fill" width="10" height="10"/><rect id="stroke" width="10" height="10" fill="none" stroke="black"/>`));
  expect(regions(p)).toEqual(["fill+stroke: 100"]);
  beginBuild({ lenient: true });
  const s = sketch({ plane: plane("XY"), profile: p }, { name: "s", variable: true });
  const box = extrude({ sketch: s, distance: 1 }, { name: "box" });
  // Each side lies on a segment of both.
  expect(box.topo.faceHist.map((h) => [...h.keys()].join(" | ")).filter((n) => n.includes("side")).sort()[0]).toBe('ref.box.side["fill.1"] | ref.box.side["stroke.1"]');
});
