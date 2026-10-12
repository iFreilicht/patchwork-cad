// Model sources for the experiment. Each counts its top-level runs in
// globalThis.__topLevelRuns. `build` makes each source unique, as an edit would.

const count = "globalThis.__topLevelRuns = (globalThis.__topLevelRuns ?? 0) + 1;";

/** M1 from research/03, as in the CAD tool's e2e specs (src/harness/e2e/cad.ts). */
const m1Body = `
  const w = 60, d = 40, h = 20, a = 30, r = 8;
  let s = drawRectangle(w, d).translate(w / 2, d / 2).sketchOnPlane("XY").extrude(h);
  s = s.cut(drawCircle(r).translate(a, 0).sketchOnPlane("XY").extrude(h));
  s = s.fillet(1.5, (e) => e.ofCurveType("CIRCLE").inPlane("XY", h));
  s = s.chamfer(1, (e) => e.ofCurveType("LINE").containsPoint([w - 2, 0, h]));
  s = s.fuse(drawCircle(2).translate(w - 6, h / 2).sketchOnPlane("XZ").extrude(4));`;

export const models = {
  /** All kernel work inside main: the top level only defines things. */
  inMain: (build: number) => `import { drawRectangle, drawCircle } from "replicad";
${count}
export default function main() {${m1Body}
  return s;
}
// build ${build}
`,
  /** The same work at the top level; main returns the result. */
  topLevel: (build: number) => `import { drawRectangle, drawCircle } from "replicad";
${count}
${m1Body}
export default function main() {
  return s;
}
// build ${build}
`,
};
export type ModelName = keyof typeof models;
