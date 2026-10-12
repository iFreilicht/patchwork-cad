import type { Expression } from "acorn";
import type { Span } from "./analyze.ts";

/** A step into an expression: an object property (of an object, or of a call's first argument) or an array element. */
export type Step = string | number;

/** The sub-expression at `path`, e.g. `rect({ from: [0, 0] })` at `["from", 1]` is the second `0`. */
export function at(node: Expression | undefined, path: readonly Step[]): Expression | undefined {
  let current = node;
  for (const step of path) {
    if (!current) return undefined;
    if (typeof step === "number") {
      const element = current.type === "ArrayExpression" ? current.elements[step] : undefined;
      current = element && element.type !== "SpreadElement" ? element : undefined;
      continue;
    }
    const object = current.type === "CallExpression" ? current.arguments[0] : current;
    if (object?.type !== "ObjectExpression") return undefined;
    const property = object.properties.find(
      (p) => p.type === "Property" && !p.computed && ((p.key.type === "Identifier" && p.key.name === step) || (p.key.type === "Literal" && p.key.value === step)),
    );
    current = property?.type === "Property" ? (property.value as Expression) : undefined;
  }
  return current;
}

export const span = (node: { start: number; end: number }): Span => ({ start: node.start, end: node.end });

/** The callee name of a call expression: `rect` for `rect({…})`. */
export const calleeName = (node: Expression | undefined): string | undefined => (node?.type === "CallExpression" && node.callee.type === "Identifier" ? node.callee.name : undefined);

/** The value of a string literal. */
export const stringValue = (node: Expression | undefined): string | undefined => (node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined);

/** Keys of an object expression (or of a call's first argument), in order. */
export function keys(node: Expression | undefined): string[] {
  const object = node?.type === "CallExpression" ? node.arguments[0] : node;
  if (object?.type !== "ObjectExpression") return [];
  return object.properties.flatMap((p) => (p.type === "Property" && !p.computed ? [p.key.type === "Identifier" ? p.key.name : String((p.key as { value: unknown }).value)] : []));
}
