/**
 * The code editor takes its colors from the user's Patchwork theme: it loads the theming package's
 * `codemirror:extension` like Patchwork's own CodeMirror tool, in light and dark mode.
 */
import { CAD_MODULES, CODE_TOOL, createModel } from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame } from "../ui.ts";

test.use({ siteModules: CAD_MODULES });

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test("the code editor uses the theme's colors", async ({ users }) => {
      const [a] = await users(1);
      if (!a) throw new Error("users(1) returned no user");
      const { page } = a;
      await bootToFrame(page);
      await createModel(page, CODE_TOOL);
      const code = page.locator(".cad-model__code");
      await expect(code.locator(".cm-content")).toContainText("const");

      // Each element's computed color, next to the theme variable it should come from.
      const colors = () =>
        page.evaluate(() => {
          const probe = document.createElement("span");
          document.body.append(probe);
          const variable = (name: string) => {
            probe.style.color = `var(${name})`;
            return getComputedStyle(probe).color;
          };
          const color = (selector: string, property: "color" | "backgroundColor" = "color") => {
            const element = document.querySelector<HTMLElement>(`.cad-model__code ${selector}`);
            return element ? getComputedStyle(element)[property] : "(missing)";
          };
          const token = (text: string) => [...document.querySelectorAll<HTMLElement>(".cad-model__code .cm-line span")].find((s) => s.textContent === text);
          const result = {
            background: [color(".cm-editor", "backgroundColor"), variable("--text-editor-fill")],
            text: [color(".cm-editor"), variable("--text-editor-line")],
            gutter: [color(".cm-gutters", "backgroundColor"), variable("--text-editor-gutter-fill")],
            keyword: [token("const") ? getComputedStyle(token("const")!).color : "(missing)", variable("--syntax-keyword")],
            definition: [token("main") ? getComputedStyle(token("main")!).color : "(missing)", variable("--syntax-definition--variable-name")],
          };
          probe.remove();
          return result;
        });
      // The theme extension loads asynchronously after the editor mounts.
      await expect.poll(async () => Object.values(await colors()).every(([rendered, theme]) => rendered === theme)).toBe(true);
    });
  });
}
