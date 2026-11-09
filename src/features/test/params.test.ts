// A model's parameters as JSON Schema (research/17-parameters.md): type and default from
// defaultParams, the rest from paramConfig, whose missing fields are no constraint.
import { expect, test } from "vitest";
import { paramSchema } from "../src/params.ts";

test("paramSchema merges defaults and paramConfig", () => {
  const model = {
    defaultParams: { w: 60, ribs: [30], round: true, label: "A" },
    paramConfig: { w: { title: "Width", minimum: 10, maximum: 200, multipleOf: 5 }, r: { title: "Corner radius", unit: "mm" } },
  };
  expect(paramSchema(model)).toEqual({
    type: "object",
    properties: {
      w: { type: "number", default: 60, title: "Width", minimum: 10, maximum: 200, multipleOf: 5 },
      ribs: { type: "array", default: [30] },
      round: { type: "boolean", default: true },
      label: { type: "string", default: "A" },
    },
  });
  expect(paramSchema({})).toEqual({ type: "object", properties: {} });
});
