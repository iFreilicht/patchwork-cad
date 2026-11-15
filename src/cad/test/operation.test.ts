// An extrusion of a sketch on a body's face joins that body away from the face and cuts into it
// (research/21, "Sketch from a drawing"): the operation a distance implies, and what keeps it fitting.
import { expect, test } from "vitest";
import { operationEdits, operationFor, sketchBody } from "../src/components/editor/operation.ts";
import { analyze } from "../src/model/analyze.ts";
import { applyToText } from "../src/model/splice.ts";

const model = (extrusion: string) => `import { sketch, plane, rect, extrude } from "@patchwork-cad/features";
export default function main() {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [20, 10] }) });
  const plate = extrude({ sketch: sketch1, distance: 5 });
  const other = extrude({ sketch: sketch1, distance: 1 });
  const sketch2 = sketch({ plane: plate.end, body: plate, profile: rect({ from: [5, 2], to: [15, 8] }) });
  const e = extrude({ sketch: ${extrusion} });
  return { e };
}
`;
/** The extrusion's operation after its distance becomes `distance`. */
function after(extrusion: string, distance: string): string | undefined {
  const source = model(extrusion);
  const analysis = analyze(source);
  const call = analysis.calls.find((c) => c.variable === "e")!;
  return /operation: "(\w+)"/.exec(applyToText(source, operationEdits(call, analysis, distance)).split("const e = ")[1]!)?.[1];
}

test("the operation a distance implies", () => {
  expect(["10", " 0.5 ", "-3", "-0.5", "1e2", "0", "", "w", "-w", "2 * 3"].map(operationFor)).toEqual(["join", "join", "cut", "cut", "join", undefined, undefined, undefined, undefined, undefined]);
  const analysis = analyze(model('sketch2, distance: 2, operation: "join", target: plate'));
  expect(sketchBody(analysis, "sketch2")).toBe("plate");
  expect(sketchBody(analysis, "sketch1")).toBeUndefined();
});

test("a distance into the body a sketch lies on cuts it, one away from it joins it", () => {
  expect(after('sketch2, distance: 2, operation: "join", target: plate', "-2")).toBe("cut");
  expect(after('sketch2, distance: -2, operation: "cut", target: plate', "3")).toBe("join");
  expect(after('sketch2, distance: 2, operation: "join", target: plate', "4")).toBe("join");
  // A distance that isn't a number leaves it.
  expect(after('sketch2, distance: 2, operation: "join", target: plate', "w")).toBe("join");
});

test("an extrusion that makes a new body, goes through, or works on another body keeps its operation", () => {
  expect(after('sketch2, distance: 2, operation: "new"', "-2")).toBe("new");
  expect(after('sketch2, distance: 2, operation: "join", target: plate, extent: "through"', "-2")).toBe("join");
  expect(after('sketch2, distance: 2, operation: "join", target: other', "-2")).toBe("join");
  expect(after('sketch1, distance: 2, operation: "join", target: plate', "-2")).toBe("join");
});
