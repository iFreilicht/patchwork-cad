import { CAD_MODULES, CODE_TOOL, cadView, createModel, replaceSource, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

// The model's top level runs once per build, not twice (research/08). The
// model counts its top-level runs and returns one box per run so far, so the
// mesh shows the count. Only successful builds evaluate the model a second
// time, so the model must not fail.
const counting = (build: number) => `import { drawRectangle } from "replicad";
globalThis.__runs = (globalThis.__runs ?? 0) + 1;
export default function main() {
  return Array.from({ length: globalThis.__runs }, (_, i) => ({
    name: "box " + i,
    shape: drawRectangle(5, 5).sketchOnPlane().extrude(5).translate(i * 10, 0, 0),
  }));
}
// build ${build}
`;

test("a build evaluates the model once", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  await bootToFrame(a.page);
  await createModel(a.page, CODE_TOOL);
  await expect(cadView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });

  const seed = await vertices(a.page);
  await replaceSource(a.page, counting(1));
  await expect.poll(() => vertices(a.page)).not.toBe(seed);
  const box = await vertices(a.page);
  expect(box).toBeGreaterThan(0);
  for (const build of [2, 3, 4]) {
    await replaceSource(a.page, counting(build));
    // Twice per build would show 2 × build − 1 boxes.
    await expect.poll(() => vertices(a.page)).toBe(build * box);
  }
});
