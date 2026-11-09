/**
 * A model's parameters as JSON Schema (research/17-parameters.md, "Kinds, units, ranges"), without
 * any kernel code: `type` from each default's value, `default` from `defaultParams`, and whatever
 * `paramConfig` says, whose fields are JSON Schema's, plus `unit`. A field `paramConfig` leaves
 * out is no constraint. Parameters are inputs, so derived ones `paramConfig` describes aren't in it.
 */

/** JSON Schema of one parameter. */
export interface ParamSchema {
  type?: "number" | "integer" | "boolean" | "string" | "array" | "object" | "null";
  default?: unknown;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enum?: unknown[];
  /** Not JSON Schema's, which validators ignore; lengths are millimetres anyway. */
  unit?: string;
}

export interface ParamsSchema {
  type: "object";
  properties: Record<string, ParamSchema>;
}

/** What a model module exports that describes its parameters. */
export interface ParametrizedModel {
  defaultParams?: Record<string, unknown>;
  paramConfig?: Record<string, ParamSchema>;
}

const typeOf = (value: unknown): ParamSchema["type"] | undefined =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : typeof value === "string" ? "string" : typeof value === "object" ? "object" : undefined;

export function paramSchema(model: ParametrizedModel): ParamsSchema {
  const properties: Record<string, ParamSchema> = {};
  for (const [key, value] of Object.entries(model.defaultParams ?? {})) {
    const type = typeOf(value);
    properties[key] = { ...(type ? { type } : {}), default: value, ...(model.paramConfig?.[key] ?? {}) };
  }
  return { type: "object", properties };
}
