/** The models of the experiment: M1, M3 and M4 (src/features/examples) and research/23's slow plate. */
import type { Body } from "@patchwork-cad/features";

export type Params = Record<string, unknown>;
export interface Model {
  name: string;
  defaults: Params;
  main: (p: Params) => unknown;
}

type Module = { default: (p: Params) => unknown; defaultParams: Params };
const load = async (name: string, path: string): Promise<Model> => {
  const m = (await import(path)) as Module;
  return { name, defaults: m.defaultParams, main: m.default };
};

export const models = {
  m1: await load("m1", "../../../../src/features/examples/m1.js"),
  m3: await load("m3", "../../../../src/features/examples/m3.js"),
  m4: await load("m4", "../../../../src/features/examples/m4.js"),
  plate: await load("plate", "../../../23-build-progress/experiment/src/plate.js"),
};

/** The bodies a build returned, as the worker finds them: one, a list, or an object of outputs. */
export function returnedBodies(value: unknown, isBody: (v: unknown) => v is Body): Body[] {
  const values = Array.isArray(value) ? value : value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && !isBody(value) ? Object.values(value) : [value];
  return values.filter(isBody);
}
