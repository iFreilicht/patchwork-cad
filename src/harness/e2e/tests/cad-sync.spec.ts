import { CAD_MODULES, cadView, replaceSource, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu, docPath } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

const cylinder = (height: number) =>
  `import { drawCircle } from "replicad";\nexport default function main() {\n  return drawCircle(20).sketchOnPlane().extrude(${height});\n}\n`;
const box = `import { drawRectangle } from "replicad";\nexport default function main() {\n  return drawRectangle(30, 20).sketchOnPlane().extrude(10);\n}\n`;

// Two profiles on one CAD model: each one's edit re-renders for the other.
test("CAD model edits sync and re-render between two profiles", async ({ users }) => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");

  await bootToFrame(a.page);
  await createViaMenu(a.page, "CAD Model");
  await expect(cadView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await replaceSource(a.page, cylinder(30));
  await expect(cadView(a.page)).toHaveAttribute("data-state", "ready");
  const fromA = await vertices(a.page);

  await bootToFrame(b.page, docPath(a.page));
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await expect.poll(() => vertices(b.page), { timeout: 60_000 }).toBe(fromA);

  await replaceSource(b.page, box);
  await expect.poll(() => vertices(b.page)).not.toBe(fromA);
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready");
  const fromB = await vertices(b.page);
  await expect.poll(() => vertices(a.page), { timeout: 60_000 }).toBe(fromB);
  await expect(a.page.locator(".cm-content")).toContainText("drawRectangle(30, 20)");
});
