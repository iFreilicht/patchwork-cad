/**
 * SVG drawings as sketch profiles (research/21, "Sketch from a drawing"): `svg(text, { width, center })`.
 * It parses in plain JS, without a DOM, so that a model stays portable and runs in a worker. What it
 * can't draw, it says in the profile's warnings rather than leaving it out silently.
 */
import type { Profile } from "./feature.ts";
import { endOf, samplePath, type Curve, type Fill, type Path, type Point } from "./profile.ts";
import { textOutlines, type TextRun } from "./text.ts";

// ---------- XML ----------

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: (XmlElement | string)[];
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A well-formed XML document's root element; anything else throws. Entities declared in its DOCTYPE are replaced, as Illustrator's `&ns_svg;`. */
export function parseXml(text: string): XmlElement {
  const entities = { ...XML_ENTITIES };
  const decode = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[\w.:-]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return entities[e] ?? m;
      const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
  const tag = /<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let i = 0;
  const fail = (why: string): never => {
    const line = text.slice(0, i).split("\n").length;
    throw new Error(`the SVG isn't well-formed XML: ${why} on line ${line}`);
  };
  const skipTo = (end: string) => {
    const j = text.indexOf(end, i);
    if (j < 0) fail(`no ${end}`);
    i = j + end.length;
  };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (stack.length && chunk) stack.at(-1)!.children.push(decode(chunk));
    else if (chunk.trim()) fail("text outside the root element");
    if (lt < 0) break;
    i = lt;
    if (text.startsWith("<!--", i)) skipTo("-->");
    else if (text.startsWith("<![CDATA[", i)) {
      const j = text.indexOf("]]>", i);
      if (j < 0) fail("an unclosed CDATA section");
      if (stack.length) stack.at(-1)!.children.push(text.slice(i + 9, j));
      i = j + 3;
    } else if (text.startsWith("<?", i)) skipTo("?>");
    else if (text.startsWith("<!DOCTYPE", i)) {
      const open = text.indexOf("[", i);
      const close = text.indexOf(">", i);
      if (open >= 0 && open < close) {
        const end = text.indexOf("]", open);
        if (end < 0) fail("an unclosed DOCTYPE");
        for (const m of text.slice(open, end).matchAll(/<!ENTITY\s+([\w.:-]+)\s+(["'])([^]*?)\2\s*>/g)) entities[m[1]!] = m[3]!;
        i = end;
      }
      skipTo(">");
    } else if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i);
      const name = text.slice(i + 2, end < 0 ? undefined : end).trim();
      if (stack.at(-1)?.name !== name) fail(`</${name}> closes ${stack.length ? `<${stack.at(-1)!.name}>` : "nothing"}`);
      stack.pop();
      i = end + 1;
    } else {
      tag.lastIndex = i;
      const m = tag.exec(text);
      if (!m) fail("a malformed tag");
      const el: XmlElement = { name: m![1]!, attrs: {}, children: [] };
      for (const a of m![2]!.matchAll(attr)) el.attrs[a[1]!] = decode(a[2] ?? a[3] ?? "");
      if (stack.length) stack.at(-1)!.children.push(el);
      else if (root) fail("a second root element");
      else root = el;
      if (!m![3]) stack.push(el);
      i = tag.lastIndex;
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.name}> isn't closed`);
  if (!root) throw new Error("the SVG has no root element");
  return root;
}

// ---------- CSS ----------

type Declarations = Record<string, { value: string; important: boolean }>;

function parseDeclarations(text: string): Declarations {
  const out: Declarations = {};
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    if (prop && value) out[prop] = { value, important };
  }
  return out;
}

interface Selector {
  tag?: string;
  id?: string;
  classes: string[];
}

interface Rule {
  selector: Selector;
  specificity: number;
  order: number;
  declarations: Declarations;
}

/** Rules of `<style>` sheets with simple selectors (`rect`, `.cls-1`, `#logo`, `path.a.b`, `*`); others are listed in `unsupported`. */
function parseCss(text: string, rules: Rule[], unsupported: Set<string>): void {
  text = text.replace(/\/\*[^]*?\*\//g, "");
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    // The block's end, past nested blocks of an at-rule.
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth; j++) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith("@")) {
      if (!/^@font-face/i.test(prelude)) unsupported.add(prelude.split(/\s/)[0]!);
      continue;
    }
    const declarations = parseDeclarations(body);
    for (const raw of prelude.split(",")) {
      const s = raw.trim();
      const m = /^(\*|[\w-]+)?((?:[.#][\w-]+)*)$/.exec(s);
      if (!m || !s) {
        unsupported.add(s);
        continue;
      }
      const selector: Selector = { classes: [] };
      if (m[1] && m[1] !== "*") selector.tag = m[1];
      for (const part of m[2]!.match(/[.#][\w-]+/g) ?? []) {
        if (part[0] === "#") selector.id = part.slice(1);
        else selector.classes.push(part.slice(1));
      }
      rules.push({ selector, specificity: (selector.id ? 100 : 0) + 10 * selector.classes.length + (selector.tag ? 1 : 0), order: rules.length, declarations });
    }
  }
}

const matches = (s: Selector, el: XmlElement) => {
  if (s.tag && s.tag !== localName(el)) return false;
  if (s.id && s.id !== el.attrs["id"]) return false;
  const classes = (el.attrs["class"] ?? "").split(/\s+/);
  return s.classes.every((c) => classes.includes(c));
};

// ---------- styles ----------

/** The properties that decide what is drawn and how text is laid out. */
const INHERITED = ["fill", "fill-rule", "visibility", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "letter-spacing", "word-spacing", "dominant-baseline", "writing-mode"] as const;
const OWN = ["display", "clip-path", "mask"] as const;
type Prop = (typeof INHERITED)[number] | (typeof OWN)[number];
export type Style = Partial<Record<Prop, string>>;

const INITIAL: Style = { fill: "black", "fill-rule": "nonzero", visibility: "visible", "font-family": "serif", "font-size": "16px", "font-weight": "normal", "font-style": "normal", "text-anchor": "start", "letter-spacing": "normal", "word-spacing": "normal" };

// ---------- geometry ----------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const linear = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

/** A subpath in the coordinates of whatever drew it. */
export interface Sub {
  start: Point;
  curves: Curve[];
  closed: boolean;
}

export function transformCurve(m: Matrix, c: Curve): Curve {
  if (c.kind === "line") return { kind: "line", to: apply(m, c.to) };
  if (c.kind === "bezier") return { kind: "bezier", controls: c.controls.map((p) => apply(m, p)), to: apply(m, c.to) };
  return { ...c, center: apply(m, c.center), u: linear(m, c.u), v: linear(m, c.v) };
}

const transformSub = (m: Matrix, s: Sub): Sub => ({ start: apply(m, s.start), curves: s.curves.map((c) => transformCurve(m, c)), closed: s.closed });

/** `transform`'s list of functions as one matrix, or undefined if it doesn't parse. */
export function parseTransform(text: string): Matrix | undefined {
  let m = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/y;
  let i = 0;
  while (i < text.trim().length + (text.length - text.trimStart().length)) {
    re.lastIndex = i;
    const f = re.exec(text);
    if (!f) return text.slice(i).trim() ? undefined : m;
    i = re.lastIndex;
    const a = (f[2]!.match(NUMBER_G) ?? []).map(Number);
    const rad = (d: number) => (d * Math.PI) / 180;
    let n: Matrix;
    switch (f[1]) {
      case "matrix":
        if (a.length !== 6) return undefined;
        n = a as Matrix;
        break;
      case "translate":
        if (a.length < 1 || a.length > 2) return undefined;
        n = translate(a[0]!, a[1] ?? 0);
        break;
      case "scale":
        if (a.length < 1 || a.length > 2) return undefined;
        n = [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0];
        break;
      case "rotate": {
        if (a.length !== 1 && a.length !== 3) return undefined;
        const [c, s] = [Math.cos(rad(a[0]!)), Math.sin(rad(a[0]!))];
        const r: Matrix = [c, s, -s, c, 0, 0];
        n = a.length === 3 ? multiply(multiply(translate(a[1]!, a[2]!), r), translate(-a[1]!, -a[2]!)) : r;
        break;
      }
      case "skewX":
        if (a.length !== 1) return undefined;
        n = [1, 0, Math.tan(rad(a[0]!)), 1, 0, 0];
        break;
      default:
        if (a.length !== 1) return undefined;
        n = [1, Math.tan(rad(a[0]!)), 0, 1, 0, 0];
    }
    m = multiply(m, n);
  }
  return m;
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const NUMBER_G = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** The endpoint-to-centre conversion of SVG's arcs (SVG 1.1, F.6.5 and F.6.6). */
function arcCurve(from: Point, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, to: Point): Curve | undefined {
  if (from[0] === to[0] && from[1] === to[1]) return undefined;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return { kind: "line", to };
  const phi = (angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const center: Point = [cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2, sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2];
  const angleOf = (ux: number, uy: number) => Math.atan2(uy, ux);
  const t0 = angleOf((x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angleOf((-x1 - cx1) / rx, (-y1 - cy1) / ry) - t0;
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  return { kind: "arc", center, u: [rx * cos, rx * sin], v: [-ry * sin, ry * cos], from: t0, to: t0 + dt };
}

/** A path's `d` as subpaths; on an error, those up to it, as a browser draws them, and the error. */
export function parsePathData(d: string): { subs: Sub[]; error?: string } {
  const subs: Sub[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const num = (): number | undefined => {
    skip();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return undefined;
    i = NUMBER.lastIndex;
    return Number(m[0]);
  };
  const flag = (): boolean | undefined => {
    skip();
    const c = d[i];
    if (c !== "0" && c !== "1") return undefined;
    i++;
    return c === "1";
  };
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  let sub: Sub | undefined;
  /** The last control point of a cubic or quadratic curve, for S and T. */
  let control: { cubic?: Point; quad?: Point } = {};
  let command = "";
  const begin = () => (sub ??= { start: [...cur], curves: [], closed: false });
  const end = () => {
    if (sub?.curves.length) subs.push(sub);
    sub = undefined;
  };
  const error = (why: string) => {
    end();
    return { subs, error: why };
  };
  while (true) {
    skip();
    if (i >= d.length) break;
    const c = d[i]!;
    const at = i;
    if (/[a-zA-Z]/.test(c)) {
      command = c;
      i++;
    } else if (!command || /[zZ]/.test(command) || !/[-+.\d]/.test(c)) return error(`unexpected "${c}" at ${i}`);
    else if (command === "M") command = "L";
    else if (command === "m") command = "l";
    const rel = command === command.toLowerCase();
    const pt = (): Point | undefined => {
      const x = num();
      const y = x === undefined ? undefined : num();
      return x === undefined || y === undefined ? undefined : rel ? [cur[0] + x, cur[1] + y] : [x, y];
    };
    const upper = command.toUpperCase();
    const missing = () => error(`"${command}" at ${at} lacks numbers`);
    let next: { cubic?: Point; quad?: Point } = {};
    switch (upper) {
      case "M": {
        const p = pt();
        if (!p) return missing();
        end();
        cur = p;
        start = p;
        break;
      }
      case "Z":
        if (sub) {
          if (cur[0] !== start[0] || cur[1] !== start[1]) sub.curves.push({ kind: "line", to: [...start] });
          sub.closed = true;
        }
        end();
        cur = start;
        break;
      case "L":
      case "H":
      case "V": {
        let p: Point | undefined;
        if (upper === "L") p = pt();
        else {
          const v = num();
          p = v === undefined ? undefined : upper === "H" ? [rel ? cur[0] + v : v, cur[1]] : [cur[0], rel ? cur[1] + v : v];
        }
        if (!p) return missing();
        begin().curves.push({ kind: "line", to: p });
        cur = p;
        break;
      }
      case "C":
      case "S": {
        const c1 = upper === "C" ? pt() : control.cubic ? [2 * cur[0] - control.cubic[0], 2 * cur[1] - control.cubic[1]] as Point : cur;
        const c2 = c1 ? pt() : undefined;
        const p = c2 ? pt() : undefined;
        if (!c1 || !c2 || !p) return missing();
        begin().curves.push({ kind: "bezier", controls: [c1, c2], to: p });
        next = { cubic: c2 };
        cur = p;
        break;
      }
      case "Q":
      case "T": {
        const c1 = upper === "Q" ? pt() : control.quad ? [2 * cur[0] - control.quad[0], 2 * cur[1] - control.quad[1]] as Point : cur;
        const p = c1 ? pt() : undefined;
        if (!c1 || !p) return missing();
        begin().curves.push({ kind: "bezier", controls: [c1], to: p });
        next = { quad: c1 };
        cur = p;
        break;
      }
      case "A": {
        const rx = num();
        const ry = rx === undefined ? undefined : num();
        const angle = ry === undefined ? undefined : num();
        const large = angle === undefined ? undefined : flag();
        const sweep = large === undefined ? undefined : flag();
        const p = sweep === undefined ? undefined : pt();
        if (!p) return missing();
        const curve = arcCurve(cur, rx!, ry!, angle!, large!, sweep!, p);
        begin();
        if (curve) sub!.curves.push(curve);
        cur = p;
        break;
      }
      default:
        return error(`unknown command "${command}" at ${at - 1}`);
    }
    control = next;
  }
  end();
  return { subs };
}

// ---------- the drawing ----------

/** Model units per user unit of each CSS unit: user units are px, 96 to an inch. */
const UNITS: Record<string, number> = { "": 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, q: 96 / 101.6 };

export interface SvgOptions {
  /** Model units per user unit of the drawing. By default, a millimetre per millimetre of a drawing sized in absolute units, and one per pixel otherwise. */
  scale?: number;
  /** The width the drawn curves are scaled to, in model units; or `height`. */
  width?: number;
  height?: number;
  /** Where the middle of the drawn curves lies on the sketch. */
  center?: [number, number];
  /** Ids of the elements to draw, with what they contain; all, if left out. */
  only?: string[];
  /** Fonts for texts, by family, as TTF or OTF bytes, e.g. an imported font file; besides the ones the library has. */
  fonts?: Record<string, Uint8Array | ArrayBuffer>;
}

/** What an element drew, in the drawing's user units. */
interface Drawn {
  name: string;
  tag: string;
  subs: Sub[];
  fill: Fill["rule"] | undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An element's name without a prefix bound to SVG's namespace; elements of other namespaces (Inkscape's, Sodipodi's) keep theirs. */
const localName = (el: XmlElement) => el.name.replace(/^svg:/, "");

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text"]);

/** Elements that draw nothing themselves and whose content is drawn only where it is used. */
const NOT_DRAWN = new Set(["defs", "symbol", "clipPath", "mask", "pattern", "marker", "linearGradient", "radialGradient", "filter", "style", "title", "desc", "metadata", "script", "font", "font-face", "view", "cursor"]);

/** The attribute an editor keeps stable, which names an element's loops: its `id`, or draw.io's `data-cell-id`. */
const stableName = (el: XmlElement) => el.attrs["id"] ?? el.attrs["data-cell-id"];

class Drawing {
  readonly warnings: string[] = [];
  readonly drawn: Drawn[] = [];
  private readonly rules: Rule[] = [];
  private readonly unsupported = new Set<string>();
  private readonly byId = new Map<string, XmlElement>();
  private readonly names = new Set<string>();
  readonly onlyFound = new Set<string>();

  constructor(
    readonly root: XmlElement,
    private readonly only: readonly string[] | undefined,
    private readonly fonts: SvgOptions["fonts"],
  ) {
    const index = (el: XmlElement) => {
      const id = el.attrs["id"];
      if (id && !this.byId.has(id)) this.byId.set(id, el);
      if (localName(el) === "style") parseCss(el.children.filter((c) => typeof c === "string").join(""), this.rules, this.unsupported);
      for (const c of el.children) if (typeof c !== "string") index(c);
    };
    index(root);
    if (this.unsupported.size) this.warn(`CSS rules ${[...this.unsupported].map((s) => JSON.stringify(s)).join(", ")} aren't applied`);
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** An element's computed style: presentation attributes, then style sheets by specificity, then its `style` attribute. */
  style(el: XmlElement, parent: Style): Style {
    const own: Record<string, { value: string; important: boolean; rank: number }> = {};
    const set = (decls: Declarations, rank: number) => {
      for (const [prop, d] of Object.entries(decls)) {
        const r = d.important ? rank + 1e6 : rank;
        if (!own[prop] || own[prop]!.rank <= r) own[prop] = { ...d, rank: r };
      }
    };
    for (const p of [...INHERITED, ...OWN]) if (el.attrs[p] !== undefined) set({ [p]: { value: el.attrs[p]!.trim(), important: false } }, 0);
    for (const r of this.rules) if (matches(r.selector, el)) set(r.declarations, 1 + r.specificity * 1000 + r.order);
    if (el.attrs["style"]) set(parseDeclarations(el.attrs["style"]), 1e5);
    const out: Style = {};
    for (const p of INHERITED) if (parent[p] !== undefined) out[p] = parent[p];
    for (const p of [...INHERITED, ...OWN]) {
      const v = own[p]?.value;
      if (v !== undefined && v !== "inherit") out[p] = v;
    }
    // A font shorthand sets the family, size, weight and style; only its common forms are read.
    const font = own["font"]?.value;
    if (font) {
      const m = /^(?:(italic|oblique|normal)\s+)?(?:(bold|bolder|lighter|normal|\d{3})\s+)?([\d.]+(?:px|pt|em|%)?)(?:\/\S+)?\s+(.+)$/.exec(font);
      if (m) Object.assign(out, { ...(m[1] ? { "font-style": m[1] } : {}), ...(m[2] ? { "font-weight": m[2] } : {}), "font-size": m[3], "font-family": m[4] });
    }
    return out;
  }

  /** A length in user units; percentages of the viewport's `axis`. */
  length(value: string | undefined, axis: "x" | "y" | "other", viewport: Point, style: Style, fallback = 0): number {
    if (value === undefined) return fallback;
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(value);
    if (!m) return fallback;
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    if (unit === "%") return (n / 100) * (axis === "x" ? viewport[0] : axis === "y" ? viewport[1] : Math.hypot(viewport[0], viewport[1]) / Math.SQRT2);
    if (unit === "em" || unit === "ex") return n * this.fontSize(style) * (unit === "ex" ? 0.5 : 1);
    return UNITS[unit] !== undefined ? n * UNITS[unit]! : fallback;
  }

  fontSize(style: Style): number {
    const v = style["font-size"] ?? "16px";
    const keywords: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 };
    return keywords[v] ?? this.length(v, "other", [0, 0], { "font-size": "16px" }, 16);
  }

  /** The name of an element's loops: its stable name, or its tag and number within the nearest element with one (`cell12/rect2`). */
  private nameOf(el: XmlElement, scope: Scope): string {
    const own = stableName(el);
    const tag = localName(el);
    let name = own ?? (scope.name ? `${scope.name}/` : "") + `${tag}${(scope.counts.set(tag, (scope.counts.get(tag) ?? 0) + 1), scope.counts.get(tag))}`;
    if (own && scope.instance) name = `${scope.instance}/${own}`;
    // Ids are unique in a valid SVG; a duplicate is numbered.
    for (let k = 2; this.names.has(name); k++) name = `${own ?? name}#${k}`;
    this.names.add(name);
    return name;
  }

  /** Draws `el` and what it contains, under transform `m` and in the viewport `viewport` (for percentages). */
  walk(el: XmlElement, m: Matrix, parent: Style, viewport: Point, scope: Scope, included: boolean, inUse: Set<string> = new Set()): void {
    const tag = localName(el);
    if (el.name.includes(":") && !el.name.startsWith("svg:")) return;
    if (NOT_DRAWN.has(tag)) return;
    const style = this.style(el, parent);
    if (style.display === "none") {
      // A hidden shape still takes its number, so that showing or hiding it renames none of the others.
      if (SHAPES.has(tag)) this.nameOf(el, scope);
      return;
    }
    const own = stableName(el);
    if (this.only && !included && own && this.only.includes(own)) {
      included = true;
      this.onlyFound.add(own);
    }
    const transform = el.attrs["transform"];
    if (transform !== undefined) {
      const t = parseTransform(transform);
      if (!t) this.warn(`${own ?? tag}: its transform ${JSON.stringify(transform)} doesn't parse, and is left out`);
      else m = multiply(m, t);
    }
    if (style["clip-path"] && style["clip-path"] !== "none") this.warn(`${own ?? tag}: clip paths aren't applied`);
    if (style.mask && style.mask !== "none") this.warn(`${own ?? tag}: masks aren't applied`);
    const inner = own && tag !== "svg" ? { name: scope.instance ? `${scope.instance}/${own}` : own, counts: new Map(), instance: scope.instance } : scope;
    const children = () => {
      for (const c of el.children) if (typeof c !== "string") this.walk(c, m, style, viewport, inner, included, inUse);
    };
    switch (tag) {
      case "svg": {
        if (el === this.root) return children();
        const vp: Point = [this.length(el.attrs["width"], "x", viewport, style, viewport[0]), this.length(el.attrs["height"], "y", viewport, style, viewport[1])];
        const placed = multiply(m, translate(this.length(el.attrs["x"], "x", viewport, style), this.length(el.attrs["y"], "y", viewport, style)));
        const box = viewBox(el.attrs["viewBox"]);
        const fit = box ? multiply(placed, viewBoxTransform(box, vp, el.attrs["preserveAspectRatio"])) : placed;
        for (const c of el.children) if (typeof c !== "string") this.walk(c, fit, style, box ? [box[2], box[3]] : vp, inner, included, inUse);
        return;
      }
      case "g":
      case "a":
        return children();
      case "switch": {
        // The first child it can draw: HTML in a foreignObject falls back on what follows it, as draw.io's labels on a text.
        const pick = el.children.find((c): c is XmlElement => typeof c !== "string" && localName(c) !== "foreignObject" && !(c.name.includes(":") && !c.name.startsWith("svg:")) && !c.attrs["requiredExtensions"]);
        if (pick) this.walk(pick, m, style, viewport, inner, included, inUse);
        else if (el.children.some((c) => typeof c !== "string" && localName(c) === "foreignObject")) this.warn(`${own ?? "switch"}: HTML in a foreignObject isn't drawn, and it has no fallback`);
        return;
      }
      case "use":
        return this.use(el, m, style, viewport, scope, included, inUse);
      case "foreignObject":
        return this.warn(`${own ?? tag}: HTML in a foreignObject isn't drawn`);
      case "image":
        return this.warn(`${own ?? tag}: images aren't drawn`);
      case "text":
        return this.text(el, m, style, viewport, scope, included);
      case "path":
      case "rect":
      case "circle":
      case "ellipse":
      case "line":
      case "polyline":
      case "polygon": {
        const name = this.nameOf(el, scope);
        if (!included || style.visibility === "hidden" || style.visibility === "collapse") return;
        const subs = this.shape(el, tag, name, style, viewport);
        if (subs.length) this.add({ name, tag, subs: subs.map((s) => transformSub(m, s)), fill: fillRule(style) });
        return;
      }
      default:
        return children();
    }
  }

  add(d: Drawn): void {
    this.drawn.push(d);
    const open = d.subs.filter((s) => !s.closed && (s.curves.length > 1 || s.curves.some((c) => c.kind !== "line")));
    if (d.fill && open.length && d.tag !== "line") this.warn(`${d.name}: filled, but not closed, so it encloses no profile`);
  }

  private use(el: XmlElement, m: Matrix, style: Style, viewport: Point, scope: Scope, included: boolean, inUse: Set<string>): void {
    const href = el.attrs["href"] ?? el.attrs["xlink:href"] ?? "";
    const id = href.startsWith("#") ? href.slice(1) : undefined;
    const target = id ? this.byId.get(id) : undefined;
    const label = stableName(el) ?? "use";
    if (!target) return this.warn(`${label}: ${href ? `${JSON.stringify(href)} isn't an element of the drawing` : "it refers to nothing"}`);
    if (inUse.has(id!)) return this.warn(`${label}: it uses itself`);
    const placed = multiply(m, translate(this.length(el.attrs["x"], "x", viewport, style), this.length(el.attrs["y"], "y", viewport, style)));
    // The instance's elements are named within the use: `badge/star`.
    const name = this.nameOf(el, scope);
    const instance: Scope = { name, counts: new Map(), instance: name };
    const nested = new Set([...inUse, id!]);
    const own = stableName(el);
    if (this.only && !included && own && this.only.includes(own)) {
      included = true;
      this.onlyFound.add(own);
    }
    if (this.only && !included && this.only.includes(id!)) {
      included = true;
      this.onlyFound.add(id!);
    }
    const tag = localName(target);
    if (tag === "symbol" || tag === "svg") {
      const vp: Point = [this.length(el.attrs["width"] ?? target.attrs["width"], "x", viewport, style, viewport[0]), this.length(el.attrs["height"] ?? target.attrs["height"], "y", viewport, style, viewport[1])];
      const box = viewBox(target.attrs["viewBox"]);
      const fit = box ? multiply(placed, viewBoxTransform(box, vp, target.attrs["preserveAspectRatio"])) : placed;
      const symbolStyle = this.style(target, style);
      for (const c of target.children) if (typeof c !== "string") this.walk(c, fit, symbolStyle, box ? [box[2], box[3]] : vp, instance, included, nested);
      return;
    }
    this.walk(target, placed, style, viewport, instance, included, nested);
  }

  private text(el: XmlElement, m: Matrix, style: Style, viewport: Point, scope: Scope, included: boolean): void {
    const name = this.nameOf(el, scope);
    if (!included) return;
    const runs: TextRun[] = [];
    const visit = (node: XmlElement, s: Style, inherited: { x: number[]; y: number[]; dx: number[]; dy: number[] }) => {
      for (const c of node.children) {
        if (typeof c === "string") {
          runs.push({ text: c, style: s, ...inherited, preserve: (node.attrs["xml:space"] ?? el.attrs["xml:space"]) === "preserve" });
          inherited = { x: [], y: [], dx: [], dy: [] };
          continue;
        }
        const tag = localName(c);
        if (tag === "textPath") {
          this.warn(`${name}: text on a path isn't drawn`);
          continue;
        }
        if (tag !== "tspan" && tag !== "a") continue;
        for (const attr of ["rotate", "textLength"]) if (c.attrs[attr] !== undefined) this.warn(`${name}: ${attr} isn't applied`);
        const cs = this.style(c, s);
        if (cs.display === "none") continue;
        visit(c, cs, this.positions(c, cs, viewport));
      }
    };
    for (const attr of ["rotate", "textLength"]) if (el.attrs[attr] !== undefined) this.warn(`${name}: ${attr} isn't applied`);
    if (/^(vertical|tb)/.test(style["writing-mode"] ?? "")) this.warn(`${name}: vertical text is drawn horizontally`);
    visit(el, style, this.positions(el, style, viewport));
    if (!runs.some((r) => r.text.trim())) return;
    const laid = textOutlines(runs, { fonts: this.fonts, fontSize: (s) => this.fontSize(s), length: (v, s) => this.length(v, "other", viewport, s) });
    for (const w of laid.warnings) this.warn(`${name}: ${w}`);
    const subs = laid.subs.map((s) => transformSub(m, s));
    if (subs.length) this.add({ name, tag: "text", subs, fill: fillRule(style) });
  }

  private positions(el: XmlElement, style: Style, viewport: Point) {
    const list = (attr: string, axis: "x" | "y") => (el.attrs[attr] ?? "").split(/[\s,]+/).filter(Boolean).map((v) => this.length(v, axis, viewport, style));
    return { x: list("x", "x"), y: list("y", "y"), dx: list("dx", "x"), dy: list("dy", "y") };
  }

  /** A basic shape's or path's subpaths in its own coordinates. */
  private shape(el: XmlElement, tag: string, name: string, style: Style, viewport: Point): Sub[] {
    const a = el.attrs;
    const len = (k: string, axis: "x" | "y" | "other") => this.length(a[k], axis, viewport, style);
    switch (tag) {
      case "path": {
        const { subs, error } = parsePathData(a["d"] ?? "");
        if (error) this.warn(`${name}: its path data has an error, ${error}; it is drawn up to there`);
        return subs;
      }
      case "rect": {
        const [x, y, w, h] = [len("x", "x"), len("y", "y"), len("width", "x"), len("height", "y")];
        if (!(w > 0 && h > 0)) return [];
        let rx = a["rx"] !== undefined && a["rx"] !== "auto" ? len("rx", "x") : undefined;
        let ry = a["ry"] !== undefined && a["ry"] !== "auto" ? len("ry", "y") : undefined;
        rx = Math.min(Math.max(0, rx ?? ry ?? 0), w / 2);
        ry = Math.min(Math.max(0, ry ?? rx), h / 2);
        if (!(rx > 0 && ry > 0)) return [{ start: [x, y], curves: [{ kind: "line", to: [x + w, y] }, { kind: "line", to: [x + w, y + h] }, { kind: "line", to: [x, y + h] }, { kind: "line", to: [x, y] }], closed: true }];
        const corner = (cx: number, cy: number, t: number): Curve => ({ kind: "arc", center: [cx, cy], u: [rx, 0], v: [0, ry], from: t, to: t + Math.PI / 2 });
        const curves: Curve[] = [];
        // Straight sides that the corners leave no length are not drawn.
        const side = (to: Point, length: number) => length > 0 && curves.push({ kind: "line", to });
        side([x + w - rx, y], w - 2 * rx);
        curves.push(corner(x + w - rx, y + ry, -Math.PI / 2));
        side([x + w, y + h - ry], h - 2 * ry);
        curves.push(corner(x + w - rx, y + h - ry, 0));
        side([x + rx, y + h], w - 2 * rx);
        curves.push(corner(x + rx, y + h - ry, Math.PI / 2));
        side([x, y + ry], h - 2 * ry);
        curves.push(corner(x + rx, y + ry, Math.PI));
        return [{ start: [x + rx, y], curves, closed: true }];
      }
      case "circle":
      case "ellipse": {
        const [cx, cy] = [len("cx", "x"), len("cy", "y")];
        const rx = tag === "circle" ? len("r", "other") : a["rx"] !== undefined && a["rx"] !== "auto" ? len("rx", "x") : len("ry", "y");
        const ry = tag === "circle" ? rx : a["ry"] !== undefined && a["ry"] !== "auto" ? len("ry", "y") : rx;
        if (!(rx > 0 && ry > 0)) return [];
        return [{ start: [cx + rx, cy], curves: [{ kind: "arc", center: [cx, cy], u: [rx, 0], v: [0, ry], from: 0, to: 2 * Math.PI }], closed: true }];
      }
      case "line": {
        const from: Point = [len("x1", "x"), len("y1", "y")];
        const to: Point = [len("x2", "x"), len("y2", "y")];
        return from[0] === to[0] && from[1] === to[1] ? [] : [{ start: from, curves: [{ kind: "line", to }], closed: false }];
      }
      default: {
        const n = (a["points"] ?? "").match(NUMBER_G)?.map(Number) ?? [];
        if (n.length % 2) this.warn(`${name}: its points have an odd count of numbers; the last is left out`);
        const pts = Array.from({ length: Math.floor(n.length / 2) }, (_, k): Point => [n[2 * k]!, n[2 * k + 1]!]);
        if (pts.length < 2) return [];
        const curves: Curve[] = pts.slice(1).map((to) => ({ kind: "line", to }));
        if (tag === "polygon") {
          const last = pts.at(-1)!;
          if (last[0] !== pts[0]![0] || last[1] !== pts[0]![1]) curves.push({ kind: "line", to: pts[0]! });
        }
        return [{ start: pts[0]!, curves, closed: tag === "polygon" }];
      }
    }
  }
}

interface Scope {
  /** The nearest stable name, which names what has none within it. */
  name: string | undefined;
  counts: Map<string, number>;
  /** The use whose instance this is, which prefixes stable names in it. */
  instance?: string | undefined;
}

/** Whether an element's fill paints anything, and by which rule. */
function fillRule(style: Style): Fill["rule"] | undefined {
  const fill = (style.fill ?? "black").trim().toLowerCase();
  if (fill === "none" || fill === "transparent") return undefined;
  return style["fill-rule"] === "evenodd" ? "evenodd" : "nonzero";
}

function viewBox(text: string | undefined): [number, number, number, number] | undefined {
  const n = text?.match(NUMBER_G)?.map(Number);
  return n && n.length === 4 && n[2]! > 0 && n[3]! > 0 ? (n as [number, number, number, number]) : undefined;
}

/** How a viewBox maps into a viewport of size `vp` (SVG's preserveAspectRatio, `xMidYMid meet` by default). */
function viewBoxTransform([bx, by, bw, bh]: [number, number, number, number], vp: Point, aspect = "xMidYMid meet"): Matrix {
  let sx = vp[0] / bw;
  let sy = vp[1] / bh;
  const [align = "xMidYMid", mode = "meet"] = aspect.trim().split(/\s+/);
  if (align !== "none") {
    sx = sy = mode === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
  }
  const free = [vp[0] - bw * sx, vp[1] - bh * sy];
  const shift = (axis: 0 | 1) => (align.includes(axis === 0 ? "xMid" : "YMid") ? free[axis]! / 2 : align.includes(axis === 0 ? "xMax" : "YMax") ? free[axis]! : 0);
  return [sx, 0, 0, sy, shift(0) - bx * sx, shift(1) - by * sy];
}

/**
 * Model units (millimetres) per user unit: a drawing's absolute size (mm, cm, in, pt, pc) is kept, and
 * a pixel is a millimetre, since a drawing without units has no size of its own.
 */
function naturalScale(root: XmlElement): number {
  const box = viewBox(root.attrs["viewBox"]);
  const size = (v: string | undefined) => {
    const m = /^\s*([\d.]+(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|q|px)?\s*$/i.exec(v ?? "");
    if (!m) return undefined;
    const unit = (m[2] ?? "px").toLowerCase();
    return unit === "px" ? Number(m[1]) : (Number(m[1]) * UNITS[unit]!) / UNITS["mm"]!;
  };
  const w = size(root.attrs["width"]);
  const h = size(root.attrs["height"]);
  const absolute = /(mm|cm|in|pt|pc|q)\s*$/i;
  const perPx = absolute.test(root.attrs["width"] ?? "") || absolute.test(root.attrs["height"] ?? "") ? 1 / UNITS["mm"]! : 1;
  if (!box) return perPx;
  if (w === undefined && h === undefined) return 1;
  const scales = [w !== undefined ? w / box[2] : undefined, h !== undefined ? h / box[3] : undefined].filter((s): s is number => s !== undefined);
  return Math.min(...scales);
}

const bad = (option: string, value: unknown, want: string) => `svg(): ${option} must be ${want}, got ${JSON.stringify(value)}`;
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The options' problem, if any. */
function checkOptions(o: SvgOptions): string | undefined {
  if (typeof o !== "object" || o === null) return bad("its options", o, "an object");
  for (const k of ["scale", "width", "height"] as const) if (o[k] !== undefined && !positive(o[k])) return bad(k, o[k], "a positive number");
  if ([o.scale, o.width, o.height].filter((v) => v !== undefined).length > 1) return "svg(): give one of scale, width and height";
  if (o.center !== undefined && !(Array.isArray(o.center) && o.center.length === 2 && o.center.every((x) => typeof x === "number" && Number.isFinite(x)))) return bad("center", o.center, "a point [x, y]");
  if (o.only !== undefined && !(Array.isArray(o.only) && o.only.every((x) => typeof x === "string"))) return bad("only", o.only, "a list of ids");
  if (o.fonts !== undefined && (typeof o.fonts !== "object" || o.fonts === null || !Object.values(o.fonts).every((f) => f instanceof Uint8Array || f instanceof ArrayBuffer))) return bad("fonts", "…", "an object of font files' bytes by family");
  return undefined;
}

const failed = (error: string): Profile => ({ kind: "paths", paths: [], fills: [], warnings: [], error });

/**
 * The curves of an SVG drawing as a sketch profile, e.g. of an imported file: `svg(logo, { width: 40 })`.
 * Its y axis points up, as a sketch's does, and the middle of what it draws lies at `center`. An
 * element's loops are named by its `id` (`leaf`, `leaf.2` for its second subpath), and their segments
 * are numbered (`leaf.3`, `leaf.2.3`); one without an id by its tag and number (`path4`), within the
 * nearest element that has one. A drawing that can't be read gives a profile that fails its sketch.
 */
export function svg(source: string | Uint8Array, options: SvgOptions = {}): Profile {
  const problem = checkOptions(options);
  if (problem) return failed(problem);
  let text: string;
  try {
    text = typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return failed("svg(): the file isn't text");
  }
  if (typeof text !== "string") return failed(bad("its drawing", source, "the text of an SVG file"));
  let root: XmlElement;
  try {
    root = parseXml(text.replace(/^﻿/, ""));
  } catch (error) {
    return failed(`svg(): ${(error as Error).message}`);
  }
  if (localName(root) !== "svg" || (root.attrs["xmlns"] !== undefined && root.attrs["xmlns"] !== SVG_NS)) return failed(`svg(): the file is <${root.name}>, not an SVG drawing`);
  const drawing = new Drawing(root, options.only, options.fonts);
  const box = viewBox(root.attrs["viewBox"]);
  const viewport: Point = box ? [box[2], box[3]] : [drawing.length(root.attrs["width"], "x", [100, 100], INITIAL, 100), drawing.length(root.attrs["height"], "y", [100, 100], INITIAL, 100)];
  drawing.walk(root, IDENTITY, INITIAL, viewport, { name: undefined, counts: new Map() }, !options.only);
  for (const id of options.only ?? []) if (!drawing.onlyFound.has(id)) drawing.warn(`only: no element has the id ${JSON.stringify(id)}`);
  // Loops and segments named; the drawing's extent.
  const paths: Path[] = [];
  const fills: Fill[] = [];
  for (const d of drawing.drawn) {
    const loops: string[] = [];
    d.subs.forEach((s, k) => {
      const id = d.subs.length === 1 ? d.name : `${d.name}.${k + 1}`;
      paths.push({ id, start: s.start, closed: s.closed || closesItself(s), segments: s.curves.map((curve, i) => ({ id: `${id}.${i + 1}`, curve })) });
      if (paths.at(-1)!.closed) loops.push(id);
    });
    if (d.fill && loops.length) fills.push({ loops, rule: d.fill });
  }
  if (!paths.length) drawing.warn("nothing in it is drawn");
  const extent = measure(paths);
  const natural = naturalScale(root);
  const width = extent ? extent.max[0] - extent.min[0] : 0;
  const height = extent ? extent.max[1] - extent.min[1] : 0;
  if (options.width !== undefined && !(width > 0)) return failed("svg(): width: the drawing has no width");
  if (options.height !== undefined && !(height > 0)) return failed("svg(): height: the drawing has no height");
  const s = options.scale ?? (options.width !== undefined ? options.width / width : options.height !== undefined ? options.height / height : natural);
  const [mx, my] = extent ? [(extent.min[0] + extent.max[0]) / 2, (extent.min[1] + extent.max[1]) / 2] : [0, 0];
  const [cx, cy] = options.center ?? [0, 0];
  // Flips y, which points down in SVG and up in a sketch.
  const place: Matrix = [s, 0, 0, -s, cx - s * mx, cy + s * my];
  return {
    kind: "paths",
    paths: paths.map((p) => ({ ...p, start: apply(place, p.start), segments: p.segments.map((g) => ({ id: g.id, curve: transformCurve(place, g.curve) })) })),
    fills,
    warnings: drawing.warnings,
  };
}

/** Whether a subpath without a closing command ends where it starts, so that it is closed all the same. */
function closesItself(s: Sub): boolean {
  if (!s.curves.length) return false;
  const end = endOf(s.curves.at(-1)!);
  const scale = Math.max(1, Math.abs(s.start[0]), Math.abs(s.start[1]));
  return Math.hypot(end[0] - s.start[0], end[1] - s.start[1]) <= 1e-9 * scale;
}

/** The extent of what paths draw, curves sampled finely. */
function measure(paths: readonly Path[]): { min: Point; max: Point } | undefined {
  const rough = paths.flatMap((p) => samplePath(p, Infinity));
  if (!rough.length) return undefined;
  const size = rough.reduce((m, p) => Math.max(m, Math.abs(p[0]), Math.abs(p[1])), 1);
  const min: Point = [Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity];
  for (const p of paths)
    for (const [x, y] of samplePath(p, size * 1e-6)) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
  return { min, max };
}
