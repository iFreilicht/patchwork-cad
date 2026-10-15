/**
 * The ViewCube (research/07, "The ViewCube"): clicking a face, edge or corner looks from it, Home
 * returns to the first view, the projection toggles, and an edit that reframes the model keeps the
 * direction.
 */
import { CAD_MODULES, cameraDirection, clickHome, clickViewCube, createModel, editorView, setModelSource, type Region } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";
import type { Page } from "@playwright/test";

test.use({ siteModules: CAD_MODULES });

const box = (size: number) => `import { drawRectangle } from "replicad";

export default function main() {
  return drawRectangle(${size}, ${size}).sketchOnPlane("XY").extrude(${size});
}
`;

async function expectDirection(page: Page, expected: [number, number, number]): Promise<void> {
  const length = Math.hypot(...expected);
  const actual = await cameraDirection(page);
  expected.forEach((c, i) => expect(actual[i]).toBeCloseTo(c / length, 2));
}

test("the ViewCube looks from faces, edges and corners", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const home = await cameraDirection(page);

  // Each region faces the camera in the view before it.
  const regions: Region[] = [[0, -1, 0], [1, -1, 1], [0, 0, 1], [1, 0, 1], [-1, -1, 1], [0, -1, 1]];
  for (const region of regions) {
    await clickViewCube(page, region);
    await expectDirection(page, region);
  }

  await clickHome(page);
  await expectDirection(page, home);

  const viewer = page.locator(".cad-model__viewer");
  const ortho = viewer.getByRole("button", { name: "Orthographic" });
  await ortho.click();
  await expect(viewer).toHaveAttribute("data-projection", "orthographic");
  await expect(ortho).toHaveAttribute("aria-pressed", "true");
  await clickViewCube(page, [1, 0, 0]);
  await expectDirection(page, [1, 0, 0]);
  await ortho.click();
  await expect(viewer).toHaveAttribute("data-projection", "perspective");
  await expectDirection(page, [1, 0, 0]);
});

test("reframing a grown model keeps the camera's direction", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page);
  const view = editorView(page);
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const builds = async () => Number(await view.getAttribute("data-builds-executed"));
  const before = await builds();
  await setModelSource(page, box(10), "replace");
  await expect.poll(builds).toBeGreaterThan(before);
  await expect(view).toHaveAttribute("data-state", "ready");

  await clickViewCube(page, [1, -1, 0]);
  await expectDirection(page, [1, -1, 0]);
  const executed = await builds();
  await setModelSource(page, box(1000), "replace");
  await expect.poll(builds).toBeGreaterThan(executed);
  await expect(view).toHaveAttribute("data-state", "ready");
  await expectDirection(page, [1, -1, 0]);
});
