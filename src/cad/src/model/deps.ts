/**
 * Dependencies between timeline entries: which entry uses a name another one declares. The editor
 * moves and inserts features Fusion-style, rewriting the chain of bodies (research/07, "Reordering"),
 * so a use is either a version use it may rewrite or a hard dependency that bounds a move.
 */
import type { AnyNode, Pattern, Statement } from "acorn";
import type { Analysis, Span } from "./analyze.ts";
import type { Timeline } from "./timeline.ts";

/**
 * How an entry uses a name:
 * - `consume`: the body a fillet, chamfer or joining/cutting extrude works on (`body:`, `target:`)
 * - `read`: the body a sketch's plane lies on (`body:` of a sketch)
 * - `return`: an identifier `main` returns
 * - `hard`: anything else, e.g. `sketch: sketch1`, `notch.side.c` or Custom Script code
 */
export type Role = "consume" | "read" | "return" | "hard";

export interface Use {
  name: string;
  span: Span;
  role: Role;
  /** Index of the entry that uses it; `entries.length` for the `return`. */
  owner: number;
  /** The property key, if the use is a shorthand property (`{ body }`). */
  shorthand: string | undefined;
}

export interface Graph {
  /** Names each entry declares at the top level of `main`. */
  declares: string[][];
  uses: Use[];
  /** The entry that declares a name. */
  declaredBy: Map<string, number>;
}

/** Feature parameters that name the body a feature consumes or reads. */
const VERSION_PARAMS: Record<string, Record<string, "consume" | "read">> = {
  fillet: { body: "consume" },
  chamfer: { body: "consume" },
  extrude: { target: "consume" },
  sketch: { body: "read" },
};

function children(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const value of Object.values(node)) for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === "object" && typeof (v as AnyNode).type === "string") out.push(v as AnyNode);
  return out;
}

/** Identifiers that a pattern binds. */
export function bound(pattern: Pattern | null | undefined, out: AnyNode[] = []): AnyNode[] {
  if (!pattern) return out;
  if (pattern.type === "Identifier") out.push(pattern);
  else if (pattern.type === "ObjectPattern") for (const p of pattern.properties) bound(p.type === "RestElement" ? p.argument : (p.value as Pattern), out);
  else if (pattern.type === "ArrayPattern") for (const e of pattern.elements) bound(e, out);
  else if (pattern.type === "RestElement") bound(pattern.argument, out);
  else if (pattern.type === "AssignmentPattern") bound(pattern.left, out);
  return out;
}

/** Identifiers in binding positions anywhere inside `node`. */
function bindings(node: AnyNode): Set<AnyNode> {
  const out = new Set<AnyNode>();
  const visit = (n: AnyNode) => {
    if (n.type === "VariableDeclarator") for (const id of bound(n.id)) out.add(id);
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      if (n.id) out.add(n.id);
      for (const p of n.params) for (const id of bound(p)) out.add(id);
    }
    if ((n.type === "ClassDeclaration" || n.type === "ClassExpression") && n.id) out.add(n.id);
    if (n.type === "CatchClause") for (const id of bound(n.param)) out.add(id);
    children(n).forEach(visit);
  };
  visit(node);
  return out;
}

/** Names a statement declares in the scope it is in. */
export function declared(statement: Statement): string[] {
  if (statement.type === "VariableDeclaration") return statement.declarations.flatMap((d) => bound(d.id).map((id) => (id as { name: string }).name));
  if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) return [statement.id.name];
  return [];
}

/** Names that scope `node` declares: a function's name and parameters, a block's declarations, a loop's or a catch clause's variables. */
function scopeNames(node: AnyNode): string[] {
  const names = (ids: AnyNode[]) => ids.map((id) => (id as { name: string }).name);
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return [...(node.type === "FunctionExpression" && node.id ? [node.id.name] : []), ...node.params.flatMap((p) => names(bound(p)))];
    case "BlockStatement":
    case "StaticBlock":
      return node.body.flatMap((s) => declared(s as Statement));
    case "ForStatement":
      return node.init?.type === "VariableDeclaration" ? declared(node.init) : [];
    case "ForInStatement":
    case "ForOfStatement":
      return node.left.type === "VariableDeclaration" ? declared(node.left) : [];
    case "CatchClause":
      return names(bound(node.param));
    default:
      return [];
  }
}

/**
 * Identifiers of `names` that `statement` (one of `main`) reads or writes. Names that a scope inside
 * the statement declares again, e.g. a function's own variable, are other variables and left out.
 */
export function usesIn(statement: AnyNode, names: Set<string>, visit: (id: AnyNode & { name: string }, ancestors: AnyNode[]) => void): void {
  const binding = bindings(statement);
  const walk = (node: AnyNode, ancestors: AnyNode[], shadowed: ReadonlySet<string>) => {
    const declares = scopeNames(node).filter((n) => names.has(n));
    if (declares.length > 0) shadowed = new Set([...shadowed, ...declares]);
    if (node.type === "Identifier" && !binding.has(node) && names.has(node.name) && !shadowed.has(node.name)) {
      const parent = ancestors[ancestors.length - 1];
      const isKey = (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) || (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand);
      // A shorthand property's key and value are two nodes at the same place: count the value only.
      const isShorthandKey = parent?.type === "Property" && parent.shorthand && parent.key === node;
      if (!isKey && !isShorthandKey && !(parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition" || parent?.type === "LabeledStatement" || parent?.type === "BreakStatement" || parent?.type === "ContinueStatement")) visit(node as AnyNode & { name: string }, ancestors);
    }
    for (const child of children(node)) walk(child, [...ancestors, node], shadowed);
  };
  walk(statement, [], new Set());
}

export function graph(analysis: Analysis, tl: Timeline): Graph {
  const statements = analysis.main?.statements ?? [];
  const inEntry = (entryIndex: number) => {
    const span = tl.entries[entryIndex]!.span;
    return statements.filter((s) => s.start >= span.start && s.end <= span.end);
  };
  const declares = tl.entries.map((_, i) => inEntry(i).flatMap(declared));
  const declaredBy = new Map<string, number>();
  declares.forEach((names, i) => names.forEach((n) => declaredBy.has(n) || declaredBy.set(n, i)));
  const names = new Set(declaredBy.keys());

  const uses: Use[] = [];
  tl.entries.forEach((entry, owner) => {
    for (const statement of inEntry(owner))
      usesIn(statement, names, (id, ancestors) => {
        if (declaredBy.get(id.name) === owner) return;
        let role: Role = "hard";
        const parent = ancestors[ancestors.length - 1];
        const object = ancestors[ancestors.length - 2];
        const call = ancestors[ancestors.length - 3];
        let shorthand: string | undefined;
        if (entry.kind === "feature" && parent?.type === "Property" && parent.value === id && !parent.computed && parent.key.type === "Identifier" && object?.type === "ObjectExpression" && call?.type === "CallExpression" && call.start === entry.call.span.start && call.arguments[0] === object) {
          role = VERSION_PARAMS[entry.type]?.[parent.key.name] ?? "hard";
          if (parent.shorthand) shorthand = parent.key.name;
        }
        uses.push({ name: id.name, span: { start: id.start, end: id.end }, role, owner, shorthand });
      });
  });

  const ret = statements.at(-1);
  if (tl.returned && ret?.type === "ReturnStatement" && ret.argument) {
    const arg = ret.argument;
    const direct = new Set<AnyNode>(arg.type === "Identifier" ? [arg] : arg.type === "ArrayExpression" ? arg.elements.filter((e): e is NonNullable<typeof e> => e?.type === "Identifier") : []);
    usesIn(ret, names, (id) => uses.push({ name: id.name, span: { start: id.start, end: id.end }, role: direct.has(id) ? "return" : "hard", owner: tl.entries.length, shorthand: undefined }));
  }
  return { declares, uses, declaredBy };
}

/** The body a feature entry consumes (`body:` of a fillet, `target:` of a joining extrude). */
export const inputOf = (g: Graph, index: number): Use | undefined => g.uses.find((u) => u.owner === index && u.role === "consume");

/** Whether uses of entry `index` as a version can be rewired to its input when it moves. */
const rewirable = (g: Graph, index: number) => inputOf(g, index) !== undefined;

/** The first entry of the chain of bodies that `name` is a version of: the feature that created it, or a Custom Script. */
export function chainRoot(g: Graph, name: string): number | undefined {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    const index = g.declaredBy.get(current);
    if (index === undefined) return undefined;
    const input = inputOf(g, index);
    if (!input || seen.has(input.name)) return index;
    seen.add(current);
    current = input.name;
  }
}

export interface Relation {
  /** The other entry: a dependency (declared earlier, used here) or a dependent (uses what this declares). */
  index: number;
  relation: "dependency" | "dependent";
  /** Whether a move rewrites this link instead of being bounded by it. */
  link: "chain" | "hard";
  /** The names that link them. */
  names: string[];
}

/** The entries that entry `index` depends on and that depend on it. */
export function relations(g: Graph, index: number): Relation[] {
  const out = new Map<string, Relation>();
  const add = (other: number, relation: Relation["relation"], link: Relation["link"], name: string) => {
    const key = `${other}:${relation}`;
    const existing = out.get(key);
    if (existing) {
      if (link === "hard") existing.link = "hard";
      if (!existing.names.includes(name)) existing.names.push(name);
    } else out.set(key, { index: other, relation, link, names: [name] });
  };
  const own = new Set(g.declares[index] ?? []);
  for (const u of g.uses) {
    if (u.owner === index) {
      const d = g.declaredBy.get(u.name);
      if (d !== undefined && d !== index) add(d, "dependency", u.role === "hard" ? "hard" : "chain", u.name);
    } else if (own.has(u.name) && u.owner < g.declares.length) {
      add(u.owner, "dependent", u.role !== "hard" && rewirable(g, index) ? "chain" : "hard", u.name);
    }
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

export interface Range {
  /** Lowest position the entry can move to: before entry `min`. */
  min: number;
  /** Highest position: before entry `max` (`entries.length` is the end). */
  max: number;
  /** The entries that bound the range, if any. */
  minBy: number | undefined;
  maxBy: number | undefined;
}

/**
 * Where entry `index` can move to without using a name before its declaration: after its last hard
 * dependency and the root of the body chains it works on, and before its first hard dependent.
 * Version uses (`body:`, `target:`) don't bound a move because the move rewires them.
 */
export function allowedRange(g: Graph, index: number): Range {
  const n = g.declares.length;
  let min = 0;
  let minBy: number | undefined;
  let max = n;
  let maxBy: number | undefined;
  const after = (d: number | undefined) => {
    if (d !== undefined && d < index && d + 1 > min) [min, minBy] = [d + 1, d];
  };
  for (const u of g.uses) {
    if (u.owner !== index) continue;
    after(u.role === "consume" || u.role === "read" ? chainRoot(g, u.name) : g.declaredBy.get(u.name));
  }
  for (const r of relations(g, index)) if (r.relation === "dependent" && r.link === "hard" && r.index > index && r.index < max) [max, maxBy] = [r.index, r.index];
  return { min, max, minBy, maxBy };
}

/** Whether moving entry `index` to `position` (before entry `position`) changes the order and stays in its range. */
export function canMove(g: Graph, index: number, position: number): boolean {
  const { min, max } = allowedRange(g, index);
  return position !== index && position !== index + 1 && position >= min && position <= max;
}
