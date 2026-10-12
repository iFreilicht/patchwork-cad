import { join } from "node:path";
import type { Page } from "@playwright/test";
import { HARNESS_DIR } from "./stack.ts";
import { editor, pressMod } from "./ui.ts";

/** The CAD tool package (src/cad), served as a static module. Build it first (`pnpm --filter patchwork-cad build`). */
export const CAD_DIR = join(HARNESS_DIR, "..", "cad");
export const CAD_MODULES = { cad: CAD_DIR };

/**
 * M1 from the naming benchmark (research/03), written with replicad: a block
 * with a through notch on its front face, the notch's top arc filleted, the
 * front-top edge right of the notch chamfered, and a boss on the front face.
 */
export const M1_SOURCE = (a: number) => `import { drawRectangle, drawCircle } from "replicad";

export default function main() {
  const w = 60, d = 40, h = 20, a = ${a}, r = 8;
  let s = drawRectangle(w, d).translate(w / 2, d / 2).sketchOnPlane("XY").extrude(h);
  s = s.cut(drawCircle(r).translate(a, 0).sketchOnPlane("XY").extrude(h));
  s = s.fillet(1.5, (e) => e.ofCurveType("CIRCLE").inPlane("XY", h));
  s = s.chamfer(1, (e) => e.ofCurveType("LINE").containsPoint([w - 2, 0, h]));
  return s.fuse(drawCircle(2).translate(w - 6, h / 2).sketchOnPlane("XZ").extrude(4));
}
`;

export const cadView = (page: Page) => page.locator(".cad-model");

/** Vertices of the shown mesh, or 0 before the first one. */
export async function vertices(page: Page): Promise<number> {
  return Number((await page.locator(".cad-model__viewer").getAttribute("data-vertices")) ?? 0);
}

/** Replaces the whole model source by typing into the editor (one undoable edit per key). */
export async function replaceSource(page: Page, source: string): Promise<void> {
  await editor(page).click();
  await pressMod(page, "a");
  await page.keyboard.press("Delete");
  // insertText skips CodeMirror's auto-indent and bracket closing, so the text arrives verbatim.
  await page.keyboard.insertText(source);
}
