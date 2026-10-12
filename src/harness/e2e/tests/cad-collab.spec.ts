/**
 * PoC 2's "done when" (research/07): two users build the benchmark parts M1 and M3 together, one
 * through the WYSIWYG editor's forms and picks (A, tool cad-model-editor), one in code (B, tool
 * cad-model), and the picked references survive upstream edits.
 */
import {
  CAD_MODULES,
  chooseField,
  dialog,
  editorView,
  modelSource,
  docPathWith,
  CODE_TOOL,
  pickNear,
  replaceSource,
  setField,
  setModelSource,
  timelineEntry,
  toolbarButton,
  viewFrom,
  cadView,
} from "../cad.ts";
import { expect, test } from "../fixtures.ts";
import { bootToFrame, createViaMenu, typeAtStart } from "../ui.ts";
import type { Page } from "@playwright/test";

test.use({ siteModules: CAD_MODULES });

const shots = process.env["CAD_SHOTS"];

const M1_BASE = `import { sketch, plane, rect, circle, extrude } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, h: 20, a: 30, r: 8 };

export default function main({ w, d, h, a, r }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const extrude1 = extrude({ sketch: sketch1, distance: h });
  const sketch2 = sketch({ plane: plane("XY"), profile: circle({ center: [a, 0], radius: r }) });
  const notch = extrude({ sketch: sketch2, operation: "cut", target: extrude1, extent: "through" });
  return notch;
}
`;

const M3_BASE = `import { sketch, plane, rect, polygon, extrude } from "@patchwork-cad/features";

export const defaultParams = { w: 60, d: 40, t: 8, H: 50, ribs: [30], ribT: 6 };

export default function main({ w, d, t, H, ribs, ribT }) {
  const sketch1 = sketch({ plane: plane("XY"), profile: rect({ from: [0, 0], to: [w, d] }) });
  const base = extrude({ sketch: sketch1, distance: t });
  const sketch2 = sketch({ plane: plane("XY", t), profile: rect({ from: [0, 0], to: [w, t] }) });
  const upright = extrude({ sketch: sketch2, distance: H - t, operation: "join", target: base });
  let body = upright;
  for (const [i, x] of ribs.entries()) {
    const profile = polygon({ foot: [t, t], hyp: [t + 20, t], web: [t, t + 20] });
    const rib = sketch({ plane: plane("YZ", x - ribT / 2), profile });
    body = extrude({ sketch: rib, distance: ribT, operation: "join", target: body }, { name: \`rib\${i}\` });
  }
  return body;
}
`;

/** Both users on one new document: A in the WYSIWYG editor (the default tool), B in code + preview. */
async function twoUsers(users: (n: number) => Promise<{ page: Page }[]>) {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("users(2) returned fewer than two users");
  await bootToFrame(a.page);
  await createViaMenu(a.page, "CAD Model");
  await expect(editorView(a.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  await bootToFrame(b.page, docPathWith(a.page, CODE_TOOL));
  await expect(cadView(b.page)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  return { a: a.page, b: b.page };
}

/** B edits from text read in A's tab, so B must have A's latest changes first; otherwise updateText merges against stale text. */
async function inSync(b: Page, text: string) {
  await expect.poll(() => modelSource(b)).toBe(text);
}

/** Waits until the page has the edited source and has built it. */
async function rebuilt(page: Page, contains: string) {
  await expect.poll(() => modelSource(page)).toContain(contains);
  await expect(editorView(page)).toHaveAttribute("data-state", "ready");
}

const statuses = (page: Page) => page.locator(".cad-editor__entry[data-kind=feature]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-name")}:${e.getAttribute("data-status")}`));

async function allOk(page: Page, names: string[]) {
  await expect.poll(() => statuses(page), { timeout: 30_000 }).toEqual(names.map((n) => `${n}:ok`));
}

test("M1: forms and picks in the editor, code in the code tool, references survive edits", async ({ users }) => {
  const { a, b } = await twoUsers(users);

  // B writes the block and the notch in code.
  await replaceSource(b, M1_BASE);
  await allOk(a, ["sketch1", "extrude1", "sketch2", "notch"]);

  // A fillets the notch's top arc: the fillet opens with edge selection active.
  await toolbarButton(a, "Fillet").click();
  await expect(dialog(a)).toHaveAttribute("data-feature", "fillet1");
  await expect(editorView(a)).toHaveAttribute("data-rolled-back", "true");
  await pickNear(a, "edge", [30, 5.1, 20], "notch");
  await expect(dialog(a).locator(".cad-editor__chip")).toHaveCount(1);
  await setField(a, "Radius", "1.5");
  await dialog(a).getByRole("button", { name: "Done selecting" }).click();

  // While A's chamfer dialog is open, B types a comment above everything.
  await toolbarButton(a, "Chamfer").click();
  await expect(dialog(a)).toHaveAttribute("data-feature", "chamfer1");
  await typeAtStart(b, "// M1: Bidarra's slotted block\n");
  await expect.poll(() => modelSource(a)).toContain("// M1: Bidarra's slotted block");
  await expect(dialog(a)).toHaveAttribute("data-feature", "chamfer1");
  await expect(editorView(a)).toHaveAttribute("data-rolled-back", "true", { timeout: 30_000 });
  await pickNear(a, "edge", [49, 0, 20], "fillet1");
  await expect(dialog(a).locator(".cad-editor__chip")).toHaveCount(1);
  await setField(a, "Distance", "1");

  // A sketches a circle on the front face right of the notch and joins a boss.
  await toolbarButton(a, "Sketch").click();
  await expect(dialog(a)).toHaveAttribute("data-feature", "sketch3");
  await dialog(a).getByRole("button", { name: "Select faces" }).click();
  await pickNear(a, "face", [54, 0, 10], "chamfer1");
  await expect(dialog(a).locator(".cad-editor__chip")).toHaveCount(1);
  await chooseField(a, "Profile kind", "circle");
  await setField(a, "center x", "w - 6");
  await setField(a, "center y", "h / 2");
  await setField(a, "radius", "2");
  await toolbarButton(a, "Extrude").click();
  await expect(dialog(a)).toHaveAttribute("data-feature", "extrude2");
  await setField(a, "Distance", "4");
  await chooseField(a, "Operation", "join");
  await chooseField(a, "Target body", "chamfer1");
  await allOk(a, ["sketch1", "extrude1", "sketch2", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"]);
  await expect.poll(() => modelSource(b)).toContain("return extrude2;");
  await expect(cadView(b)).toHaveAttribute("data-state", "ready");
  if (shots) await a.screenshot({ path: `${shots}/collab-m1-a.png` });
  if (shots) await b.screenshot({ path: `${shots}/collab-m1-b.png` });
  const built = await modelSource(a);
  console.log(built);

  // B moves the notch and makes the block taller in code; every reference still resolves.
  await inSync(b, built);
  await setModelSource(b, built.replace("a: 30", "a: 25").replace("h: 20", "h: 30"));
  await rebuilt(a, "a: 25");
  await allOk(a, ["sketch1", "extrude1", "sketch2", "notch", "fillet1", "chamfer1", "sketch3", "extrude2"]);

  // A deletes the notch. References into it report themselves; the sketch accepts a suggestion.
  await timelineEntry(a, "notch").click();
  await dialog(a).getByRole("button", { name: "Delete", exact: true }).click();
  await dialog(a).getByRole("button", { name: "Delete notch" }).click();
  await expect(timelineEntry(a, "notch")).toHaveCount(0);
  await expect(timelineEntry(a, "fillet1")).toHaveAttribute("data-status", "broken");
  await expect(timelineEntry(a, "sketch3")).toHaveAttribute("data-status", "broken");
  await timelineEntry(a, "sketch3").click();
  if (shots) await a.screenshot({ path: `${shots}/collab-m1-broken.png` });
  await dialog(a).getByRole("button", { name: "use suggestion" }).click();
  await expect(timelineEntry(a, "sketch3")).toHaveAttribute("data-status", "ok");
  console.log(await modelSource(a));
});

test("M3: ribs in a loop are a Custom Script; picks into it survive moving and adding ribs", async ({ users }) => {
  const { a, b } = await twoUsers(users);
  await replaceSource(b, M3_BASE);
  await allOk(a, ["sketch1", "base", "sketch2", "upright"]);
  const script = a.locator(".cad-editor__entry[data-kind=script]");
  // The loop's sketch has no variable, so it gets a fallback name from its line.
  await expect(script.locator(".cad-editor__ran")).toHaveText(["✎ sketch@L13#3", "⬆ rib0"]);

  await toolbarButton(a, "Fillet").click();
  await expect(dialog(a)).toHaveAttribute("data-feature", "fillet1");
  await expect(editorView(a)).toHaveAttribute("data-rolled-back", "true");
  // The inner corner is behind the upright: A orbits to the back.
  await viewFrom(a, [0.4, 0.8, 0.6]);
  await pickNear(a, "edge", [46.5, 8, 8], "rib0");
  await pickNear(a, "edge", [13.5, 8, 8], "rib0");
  await expect(dialog(a).locator(".cad-editor__chip")).toHaveCount(2);
  await setField(a, "Radius", "2");
  await toolbarButton(a, "Chamfer").click();
  await viewFrom(a, [0.55, -0.85, 0.65]);
  await pickNear(a, "edge", [30, 0, 50], "fillet1");
  await setField(a, "Distance", "1");
  await toolbarButton(a, "Sketch").click();
  await dialog(a).getByRole("button", { name: "Select faces" }).click();
  await pickNear(a, "face", [30, 0, 29], "chamfer1");
  await chooseField(a, "Profile kind", "circle");
  await setField(a, "center x", "w / 2");
  await setField(a, "center y", "(t + H) / 2");
  await setField(a, "radius", "4");
  await toolbarButton(a, "Extrude").click();
  await setField(a, "Distance", "5");
  await chooseField(a, "Operation", "cut");
  await chooseField(a, "Target body", "chamfer1");
  const features = ["sketch1", "base", "sketch2", "upright", "fillet1", "chamfer1", "sketch3", "extrude1"];
  await allOk(a, features);
  if (shots) await a.screenshot({ path: `${shots}/collab-m3-a.png` });
  const built = await modelSource(a);
  console.log(built);

  for (const ribs of ["[15]", "[30, 45]"]) {
    await inSync(b, await modelSource(a));
    await setModelSource(b, built.replace("ribs: [30]", `ribs: ${ribs}`));
    await rebuilt(a, `ribs: ${ribs}`);
    await allOk(a, features);
    await expect(a.locator(".cad-editor__entry[data-kind=script] .cad-editor__ran[data-name^=rib]")).toHaveCount(ribs.split(",").length);
  }
});
