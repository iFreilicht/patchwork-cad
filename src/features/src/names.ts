/**
 * History names of faces and edges (research/03, S4/S5), rooted in feature-semantic origin names.
 * A name's canonical print is the JS reference expression that selects it, and also its key.
 */

export type Name =
  /** A side face swept from sketch segment `seg`: `extrude1.side.front`. */
  | { t: "side"; feature: string; seg: string }
  /** An extrude's start or end cap: `extrude1.start`, `extrude1.end`. */
  | { t: "cap"; feature: string; cap: "start" | "end" }
  /** The face a fillet or chamfer creates from an edge, given as the edge's names: `fillet1.face(edge(…))`. */
  | { t: "blend"; feature: string; edge: Name[] }
  /** A face a fillet or chamfer creates at a vertex: `fillet1.corner`. */
  | { t: "corner"; feature: string }
  /** An edge without history, named by the names of its adjacent faces (one side for seams); `n` tells apart several edges between the same faces. */
  | { t: "edge"; sides: Name[][]; n: number }
  /** Piece `k` (1-based, in OCCT's order) of a name that feature `op` split into several pieces. */
  | { t: "piece"; of: Name; op: string; k: number }
  /**
   * A face of a shape adopted with `body()`, which has no history: named by its centroid when it
   * was adopted, `cut_plate.faceAt([50, 20, 12])`. It resolves to the nearest such face (research/11).
   */
  | { t: "at"; feature: string; near: Vec };

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A feature name through the `ref` namespace: `ref.rib0`, `ref["extrude@L12#1"]`. */
export const refForm = (feature: string) => (IDENT.test(feature) ? `ref.${feature}` : `ref[${JSON.stringify(feature)}]`);

/**
 * How feature names are printed. By default through `ref`; the editor's runtime prints features
 * that have a variable as that variable, so references stay plain, portable JS (`extrude1.side.front`).
 */
let printFeature: (feature: string) => string = refForm;

export function setFeaturePrinter(printer: (feature: string) => string): void {
  printFeature = printer;
}

const printSegment = (seg: string) => (IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`);

/** `a` or `any(a, b)` for a set of names. */
const printSet = (names: readonly Name[]): string => (names.length === 1 ? print(names[0]!) : `any(${names.map((n) => print(n)).sort().join(", ")})`);

export type Vec = readonly [number, number, number];

export const printVec = (v: Vec) => `[${v.map((x) => +x.toFixed(3)).join(", ")}]`;

/** The canonical expression; `hint` is printed on the outermost piece only and is not part of the key. */
export function print(n: Name, hint?: Vec): string {
  switch (n.t) {
    case "side":
      return `${printFeature(n.feature)}.side${printSegment(n.seg)}`;
    case "cap":
      return `${printFeature(n.feature)}.${n.cap}`;
    case "blend":
      return `${printFeature(n.feature)}.face(${printSet(n.edge)})`;
    case "corner":
      return `${printFeature(n.feature)}.corner`;
    case "edge": {
      const sides = n.sides.map(printSet).sort();
      return `edge(${sides.join(", ")})${n.n > 1 ? `.nth(${n.n})` : ""}`;
    }
    case "piece":
      return `${print(n.of)}.piece(${printFeature(n.op)}, ${n.k}${hint ? `, { near: ${printVec(hint)} }` : ""})`;
    case "at":
      return `${printFeature(n.feature)}.faceAt(${printVec(n.near)})`;
  }
}

/** Key of a name: its print without hint, with every feature through `ref`, so it doesn't depend on the printer. */
export function key(n: Name): string {
  const saved = printFeature;
  printFeature = refForm;
  try {
    return print(n);
  } finally {
    printFeature = saved;
  }
}

/** Prints several names as one expression, factoring out a common last split: `any(a, b).piece(op, 1)`. */
export function printAll(names: readonly Name[], hint?: Vec): string {
  if (names.length === 1) return print(names[0]!, hint);
  const first = names[0]!;
  if (first.t === "piece" && names.every((n) => n.t === "piece" && n.op === first.op && n.k === first.k)) {
    const inner = printAll(names.map((n) => (n as Extract<Name, { t: "piece" }>).of));
    return `${inner}.piece(${printFeature(first.op)}, ${first.k}${hint ? `, { near: ${printVec(hint)} }` : ""})`;
  }
  return `any(${names.map((n) => print(n)).sort().join(", ")})`;
}

export const piece = (of: Name, op: string, k: number): Name => ({ t: "piece", of, op, k });

/** The base name and its split levels, outermost last. */
export function chain(n: Name): { base: Name; levels: { op: string; k: number }[] } {
  const levels: { op: string; k: number }[] = [];
  while (n.t === "piece") {
    levels.unshift({ op: n.op, k: n.k });
    n = n.of;
  }
  return { base: n, levels };
}

const share = (a: readonly Name[], b: readonly Name[]) => {
  const keys = new Set(a.map(key));
  return b.some((x) => keys.has(key(x)));
};

function sameBase(a: Name, b: Name): boolean {
  if (key(a) === key(b)) return true;
  // Edges also match when their adjacent faces overlap, because a merge adds names to a face.
  if (a.t !== "edge" || b.t !== "edge" || a.n !== b.n || a.sides.length !== b.sides.length) return false;
  const [a0, a1] = a.sides;
  const [b0, b1] = b.sides;
  if (!a1 || !b1) return share(a0!, b0!);
  return (share(a0!, b0!) && share(a1, b1)) || (share(a0!, b1) && share(a1, b0!));
}

/** `n` equals `of` or descends from it through further splits. */
export function isDescendant(n: Name, of: Name): boolean {
  const cn = chain(n);
  const co = chain(of);
  if (co.levels.length > cn.levels.length) return false;
  if (!co.levels.every((l, i) => cn.levels[i]!.op === l.op && cn.levels[i]!.k === l.k)) return false;
  return sameBase(cn.base, co.base);
}

/** The last split level of a name: its parent and piece index. */
export function lastLevel(n: Name): { parent: Name; op: string; k: number } | undefined {
  return n.t === "piece" ? { parent: n.of, op: n.op, k: n.k } : undefined;
}

/** The features that own an entity of this name (research/12): the one that created it, and those that split it. */
export function owningFeatures(n: Name): string[] {
  const { base, levels } = chain(n);
  return [...("feature" in base ? [base.feature] : []), ...levels.map((l) => l.op)];
}
