import { CAD_MODULES, CODE_TOOL, cadView, createModel, replaceSource, vertices } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

// The CAD tool, served as a static module, renders its seed model, re-renders
// edits, and reports each kind of error next to the code while the last good
// shape stays visible.
test("a CAD model renders, re-renders edits and reports errors", async ({ users }) => {
  const [a] = await users(1);
  if (!a) throw new Error("users(1) returned no user");
  const { page } = a;
  await bootToFrame(page);
  await createModel(page, CODE_TOOL);

  const view = cadView(page);
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  const seed = await vertices(page);
  expect(seed).toBeGreaterThan(0);

  await replaceSource(page, `import { drawCircle } from "replicad";\nexport default function main() {\n  return drawCircle(20).sketchOnPlane().extrude(30);\n}\n`);
  await expect.poll(() => vertices(page)).not.toBe(seed);
  await expect(view).toHaveAttribute("data-state", "ready");
  const good = await vertices(page);

  const status = page.locator(".cad-model__status");
  const cases: [string, RegExp][] = [
    [`import { drawCircle } from "replicad";\nexport default function main() {\n  return drawCircle(20).sketchOnPlane(.extrude(30);\n}\n`, /syntax error on line 3/],
    [`import { drawCircle } from "replicad";\nexport default function main() {\n  throw new Error("boom");\n}\n`, /runtime error on line 3: boom/],
    [`import { x } from "https://example.com/x.js";\nexport default function main() {}\n`, /import error on line 1/],
    // A fillet larger than the part fails inside OCCT.
    [`import { drawRectangle } from "replicad";\nexport default function main() {\n  return drawRectangle(10, 10).sketchOnPlane().extrude(5).fillet(20);\n}\n`, /kernel error: StdFail_NotDone/],
  ];
  for (const [source, message] of cases) {
    await replaceSource(page, source);
    await expect(view).toHaveAttribute("data-state", "error");
    await expect(status).toContainText(message);
    expect(await vertices(page)).toBe(good);
    await expect(page.locator(".cad-model__error-line")).toHaveCount(message.source.includes("line") ? 1 : 0);
  }
});
