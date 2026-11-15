/**
 * Text as outlines of fonts' glyphs (research/21, "Sketch from a drawing"), for SVG `<text>`. The
 * library draws with the fonts registered with it (`registerFont`) and those an `svg()` call is given;
 * the editor registers Liberation Sans, Serif and Mono, which have the metrics of Arial, Times New Roman
 * and Courier New. A family that isn't there is drawn in another, as a browser does, and said so.
 */
import { parse, type Font, type Glyph } from "opentype.js";
import type { Curve, Point } from "./profile.ts";
import type { Style, Sub } from "./svg.ts";

type Variant = "regular" | "bold" | "italic" | "bolditalic";

/** Registered fonts by lowercase family, then variant. */
const registry = new Map<string, { family: string; variants: Partial<Record<Variant, Font>> }>();

const variantOf = (bold: boolean, italic: boolean): Variant => (bold ? (italic ? "bolditalic" : "bold") : italic ? "italic" : "regular");

function fontOf(bytes: Uint8Array | ArrayBuffer): Font {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  return parse(buffer);
}

const nameOf = (font: Font, key: "fontFamily" | "fontSubfamily" | "preferredFamily" | "preferredSubfamily") => (font.names as unknown as Record<string, Record<string, string> | undefined>)[key]?.["en"];

/**
 * Makes a TTF or OTF font available to texts, under its own family name or `family`, as the variant
 * its subfamily names (Bold, Italic, Bold Italic) unless `bold` or `italic` say otherwise.
 */
export function registerFont(bytes: Uint8Array | ArrayBuffer, options: { family?: string; bold?: boolean; italic?: boolean } = {}): string {
  const font = fontOf(bytes);
  const family = options.family ?? nameOf(font, "preferredFamily") ?? nameOf(font, "fontFamily") ?? "font";
  const sub = (nameOf(font, "preferredSubfamily") ?? nameOf(font, "fontSubfamily") ?? "").toLowerCase();
  const variant = variantOf(options.bold ?? /bold|black|heavy/.test(sub), options.italic ?? /italic|oblique/.test(sub));
  const entry = registry.get(family.toLowerCase()) ?? { family, variants: {} };
  entry.variants[variant] = font;
  registry.set(family.toLowerCase(), entry);
  return family;
}

/** Families whose metrics a Liberation font has, and CSS's generic families. */
const ALIASES: Record<string, string> = {
  arial: "Liberation Sans",
  helvetica: "Liberation Sans",
  "helvetica neue": "Liberation Sans",
  arimo: "Liberation Sans",
  "times new roman": "Liberation Serif",
  times: "Liberation Serif",
  tinos: "Liberation Serif",
  "courier new": "Liberation Mono",
  courier: "Liberation Mono",
  cousine: "Liberation Mono",
};
const GENERIC: Record<string, string> = {
  "sans-serif": "Liberation Sans",
  "system-ui": "Liberation Sans",
  "ui-sans-serif": "Liberation Sans",
  serif: "Liberation Serif",
  "ui-serif": "Liberation Serif",
  monospace: "Liberation Mono",
  "ui-monospace": "Liberation Mono",
};
/** What browsers draw a family they don't have in: their default, a serif font. */
const FALLBACK = "Liberation Serif";

const families = (list: string) =>
  list
    .split(",")
    .map((f) => f.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter(Boolean);

type Fonts = Map<string, { family: string; variants: Partial<Record<Variant, Font>> }>;

/** The font a `font-family` list is drawn in, and why it isn't the first, if it isn't. */
function choose(fonts: Fonts, list: string, variant: Variant): { font: Font; family: string; note?: string } | undefined {
  const wanted = families(list);
  const pick = (family: string) => {
    const entry = fonts.get(family.toLowerCase());
    if (!entry) return undefined;
    const font = entry.variants[variant] ?? entry.variants.regular ?? Object.values(entry.variants)[0]!;
    const missing = !entry.variants[variant];
    return { font, family: entry.family, missing };
  };
  let substitute: { family: string; via: string } | undefined;
  for (const family of wanted) {
    const lower = family.toLowerCase();
    const own = pick(family);
    if (own) return withVariantNote(own, variant, own.family === wanted[0] ? undefined : `${unavailable(wanted.slice(0, wanted.indexOf(family)))}: drawn in ${own.family}`);
    // A family with the metrics of an earlier one is closer to what was meant than a generic one.
    if (GENERIC[lower] && fonts.has(GENERIC[lower]!.toLowerCase()) && !substitute) {
      const g = pick(GENERIC[lower]!)!;
      const skipped = wanted.slice(0, wanted.indexOf(family));
      return withVariantNote(g, variant, skipped.length ? `${unavailable(skipped)}: drawn in ${g.family}` : undefined);
    }
    if (!substitute && ALIASES[lower] && fonts.has(ALIASES[lower]!.toLowerCase())) substitute = { family: ALIASES[lower]!, via: family };
  }
  if (substitute) {
    const s = pick(substitute.family)!;
    const metrics = wanted[0]!.toLowerCase() === substitute.via.toLowerCase() ? `, which has its metrics` : `, which has the metrics of ${substitute.via}`;
    return withVariantNote(s, variant, `${unavailable(wanted.slice(0, wanted.indexOf(substitute.via) + 1))}: drawn in ${s.family}${metrics}`);
  }
  const fallback = pick(FALLBACK) ?? pick([...fonts.values()][0]?.family ?? "");
  if (!fallback) return undefined;
  return withVariantNote(fallback, variant, `${unavailable(wanted)}: drawn in ${fallback.family}`);
}

/** Whether a font has a glyph for a character: opentype.js 1.3.4's `hasChar` is true for all, as it maps a missing one to glyph 0, `.notdef`. */
const has = (font: Font, ch: string) => font.charToGlyphIndex(ch) > 0;

const quoted = (list: string[]) => (list.length ? list.map((f) => `"${f}"`).join(", ") : "no font");
const unavailable = (list: string[]) => `${quoted(list)} ${list.length > 1 ? "aren't" : "isn't"} available`;

function withVariantNote(c: { font: Font; family: string; missing: boolean }, variant: Variant, note: string | undefined) {
  const v = c.missing ? `${c.family} has no ${variant === "bolditalic" ? "bold italic" : variant} style: drawn regular` : undefined;
  const all = [note, v].filter(Boolean).join("; ");
  return { font: c.font, family: c.family, ...(all ? { note: all } : {}) };
}

// ---------- layout ----------

/** Characters of a `<text>` or `<tspan>` with their style and the positions its attributes give them, one per character. */
export interface TextRun {
  text: string;
  style: Style;
  x: number[];
  y: number[];
  dx: number[];
  dy: number[];
  /** `xml:space="preserve"`. */
  preserve: boolean;
}

/** SVG 1.1's white space: newlines removed, tabs as spaces, runs of spaces as one, none at the start or end; with `preserve`, newlines and tabs as spaces. */
function whiteSpace(runs: TextRun[]): TextRun[] {
  let previousSpace = true;
  const out = runs.map((r) => {
    if (r.preserve) {
      previousSpace = false;
      return { ...r, text: r.text.replace(/[\n\r\t]/g, " ") };
    }
    let text = r.text.replace(/[\n\r]/g, "").replace(/\t/g, " ").replace(/ +/g, " ");
    if (previousSpace) text = text.replace(/^ /, "");
    if (text) previousSpace = text.endsWith(" ");
    return { ...r, text };
  });
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.preserve) break;
    const trimmed = out[i]!.text.replace(/ $/, "");
    out[i] = { ...out[i]!, text: trimmed };
    if (trimmed) break;
  }
  return out;
}

export interface TextOptions {
  fonts: Record<string, Uint8Array | ArrayBuffer> | undefined;
  fontSize(style: Style): number;
  length(value: string, style: Style): number;
}

/**
 * The outlines of a `<text>`'s glyphs in its user units, laid out as SVG lays out text: each absolute
 * x starts a chunk that `text-anchor` aligns, `dx` and `dy` move the characters, kerning and
 * `letter-spacing` space them.
 */
export function textOutlines(input: TextRun[], options: TextOptions): { subs: Sub[]; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (w: string) => warnings.includes(w) || warnings.push(w);
  const fonts: Fonts = new Map(registry);
  for (const [family, bytes] of Object.entries(options.fonts ?? {})) {
    try {
      const font = fontOf(bytes);
      const entry = fonts.get(family.toLowerCase()) ?? { family, variants: {} };
      const sub = (nameOf(font, "preferredSubfamily") ?? nameOf(font, "fontSubfamily") ?? "").toLowerCase();
      fonts.set(family.toLowerCase(), { family, variants: { ...entry.variants, [variantOf(/bold|black|heavy/.test(sub), /italic|oblique/.test(sub))]: font } });
    } catch (error) {
      warn(`the font given for "${family}" can't be read: ${(error as Error).message}`);
    }
  }
  if (!fonts.size) return { subs: [], warnings: ["no font is loaded, so its text isn't drawn"] };
  const runs = whiteSpace(input);
  const placed: Sub[] = [];
  let chunk: { anchor: string; start: number; end: number; items: Sub[] } | undefined;
  const chunks: NonNullable<typeof chunk>[] = [];
  let pen: Point = [0, 0];
  let previous: { glyph: Glyph; font: Font } | undefined;
  const missing = new Map<string, Set<string>>();
  for (const run of runs) {
    const s = run.style;
    const size = options.fontSize(s);
    const weight = s["font-weight"] ?? "normal";
    const bold = weight === "bold" || weight === "bolder" || (/^\d+$/.test(weight) && Number(weight) >= 600);
    const italic = s["font-style"] === "italic" || s["font-style"] === "oblique";
    const chosen = choose(fonts, s["font-family"] ?? "serif", variantOf(bold, italic));
    if (!chosen) continue;
    if (chosen.note) warn(chosen.note);
    const spacing = s["letter-spacing"] && s["letter-spacing"] !== "normal" ? options.length(s["letter-spacing"], s) : 0;
    const wordSpacing = s["word-spacing"] && s["word-spacing"] !== "normal" ? options.length(s["word-spacing"], s) : 0;
    const anchor = s["text-anchor"] ?? "start";
    const shift = baselineShift(s["dominant-baseline"], chosen.font, size) ?? 0;
    if (baselineShift(s["dominant-baseline"], chosen.font, size) === undefined) warn(`dominant-baseline ${JSON.stringify(s["dominant-baseline"])} is drawn as alphabetic`);
    [...run.text].forEach((ch, i) => {
      const x = run.x[i];
      const y = run.y[i];
      if (x !== undefined || y !== undefined || !chunk) {
        if (chunk) chunks.push(chunk);
        chunk = { anchor, start: x ?? pen[0], end: x ?? pen[0], items: [] };
        previous = undefined;
      }
      pen = [(x ?? pen[0]) + (run.dx[i] ?? 0), (y ?? pen[1]) + (run.dy[i] ?? 0)];
      // A character the font lacks is drawn in another registered font that has it, as browsers do.
      let font = chosen.font;
      if (!has(font, ch) && ch.trim()) {
        const other = [...fonts.values()].flatMap((e) => Object.values(e.variants)).find((f) => has(f, ch));
        if (other) font = other;
        else {
          const set = missing.get(chosen.family) ?? new Set();
          missing.set(chosen.family, set.add(ch));
        }
      }
      const glyph = font.charToGlyph(ch);
      if (previous && previous.font === font) pen[0] += font.getKerningValue(previous.glyph, glyph) * (size / font.unitsPerEm);
      if (has(font, ch) || !ch.trim())
        for (const sub of outline(glyph, pen[0], pen[1] + shift, size)) {
          placed.push(sub);
          chunk!.items.push(sub);
        }
      pen[0] += (glyph.advanceWidth ?? 0) * (size / font.unitsPerEm) + spacing + (ch === " " ? wordSpacing : 0);
      chunk!.end = pen[0];
      previous = { glyph, font };
    });
  }
  if (chunk) chunks.push(chunk);
  for (const [family, chars] of missing) warn(`${[...chars].map((c) => JSON.stringify(c)).join(", ")} ${chars.size === 1 ? "isn't" : "aren't"} in ${family} or any other font, and ${chars.size === 1 ? "isn't" : "aren't"} drawn`);
  // Each chunk aligned by its anchor.
  for (const c of chunks) {
    const width = c.end - c.start;
    const dx = c.anchor === "middle" ? -width / 2 : c.anchor === "end" ? -width : 0;
    if (dx) for (const sub of c.items) Object.assign(sub, moved(sub, dx));
  }
  return { subs: placed, warnings };
}

/** How far down the alphabetic baseline lies from the one `dominant-baseline` names; undefined for one that isn't drawn. */
function baselineShift(value: string | undefined, font: Font, size: number): number | undefined {
  const em = size / font.unitsPerEm;
  const os2 = (font.tables as Record<string, { sxHeight?: number } | undefined>)["os2"];
  switch (value) {
    case undefined:
    case "auto":
    case "alphabetic":
    case "baseline":
      return 0;
    case "middle":
      return ((os2?.sxHeight ?? font.unitsPerEm / 2) / 2) * em;
    case "central":
      return ((font.ascender + font.descender) / 2) * em;
    case "hanging":
    case "text-before-edge":
    case "text-top":
      return font.ascender * em;
    case "text-after-edge":
    case "text-bottom":
    case "ideographic":
      return font.descender * em;
    default:
      return undefined;
  }
}

const moved = (s: Sub, dx: number): Sub => {
  const m = (p: Point): Point => [p[0] + dx, p[1]];
  return {
    start: m(s.start),
    closed: s.closed,
    curves: s.curves.map((c): Curve => (c.kind === "line" ? { kind: "line", to: m(c.to) } : c.kind === "bezier" ? { kind: "bezier", controls: c.controls.map(m), to: m(c.to) } : { ...c, center: m(c.center) })),
  };
};

/** A glyph's contours at `x`, `y` (its baseline), `size` units to the em, y pointing down as in SVG. */
function outline(glyph: Glyph, x: number, y: number, size: number): Sub[] {
  const subs: Sub[] = [];
  let sub: Sub | undefined;
  for (const c of glyph.getPath(x, y, size).commands) {
    if (c.type === "M") {
      if (sub?.curves.length) subs.push(sub);
      sub = { start: [c.x, c.y], curves: [], closed: false };
    } else if (c.type === "Z") {
      if (sub) {
        const at = sub.curves.length ? endPoint(sub.curves.at(-1)!) : sub.start;
        if (at[0] !== sub.start[0] || at[1] !== sub.start[1]) sub.curves.push({ kind: "line", to: [...sub.start] });
        sub.closed = true;
        if (sub.curves.length) subs.push(sub);
      }
      sub = undefined;
    } else if (sub) {
      if (c.type === "L") sub.curves.push({ kind: "line", to: [c.x, c.y] });
      else if (c.type === "Q") sub.curves.push({ kind: "bezier", controls: [[c.x1, c.y1]], to: [c.x, c.y] });
      else if (c.type === "C") sub.curves.push({ kind: "bezier", controls: [[c.x1, c.y1], [c.x2, c.y2]], to: [c.x, c.y] });
    }
  }
  if (sub?.curves.length) subs.push(sub);
  return subs;
}

const endPoint = (c: Curve): Point => (c.kind === "arc" ? [c.center[0] + c.u[0] * Math.cos(c.to) + c.v[0] * Math.sin(c.to), c.center[1] + c.u[1] * Math.cos(c.to) + c.v[1] * Math.sin(c.to)] : c.to);
