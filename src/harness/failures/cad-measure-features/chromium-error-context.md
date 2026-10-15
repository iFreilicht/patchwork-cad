# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cad-measure-features.spec.ts >> rebuild cost of models written with the feature library
- Location: e2e/tests/cad-measure-features.spec.ts:17:1

# Error details

```
Test timeout of 600000ms exceeded.
```

```
Error: locator.click: Target page, context or browser has been closed
Call log:
  - waiting for locator('.cm-content').first()
    - locator resolved to <div translate="no" role="textbox" autocorrect="off" spellcheck="false" class="cm-content" autocapitalize="off" aria-multiline="true" contenteditable="true" writingsuggestions="false" data-language="javascript">…</div>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
    - <div class="comments-empty">No comments yet</div> from <div class="sidebar" data-side="right">…</div> subtree intercepts pointer events
  - retrying click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
    - <canvas width="266" height="513" data-engine="three.js r186"></canvas> from <div class="cad-editor__stage">…</div> subtree intercepts pointer events
  - retrying click action
    - waiting 20ms
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
    - <div class="cm-gutterElement">15</div> from <div aria-hidden="true" class="cm-gutters cm-gutters-before">…</div> subtree intercepts pointer events
  2 × retrying click action
      - waiting 100ms
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="comments-empty">No comments yet</div> from <div class="sidebar" data-side="right">…</div> subtree intercepts pointer events
  284 × retrying click action
        - waiting 500ms
        - waiting for element to be visible, enabled and stable
        - element is visible, enabled and stable
        - scrolling into view if needed
        - done scrolling
        - <canvas width="266" height="513" data-engine="three.js r186"></canvas> from <div class="cad-editor__stage">…</div> subtree intercepts pointer events
      - retrying click action
        - waiting 500ms
        - waiting for element to be visible, enabled and stable
        - element is visible, enabled and stable
        - scrolling into view if needed
        - done scrolling
        - <div class="cm-gutterElement">15</div> from <div aria-hidden="true" class="cm-gutters cm-gutters-before">…</div> subtree intercepts pointer events
      - retrying click action
        - waiting 500ms
        - waiting for element to be visible, enabled and stable
        - element is visible, enabled and stable
        - scrolling into view if needed
        - done scrolling
        - <div class="comments-empty">No comments yet</div> from <div class="sidebar" data-side="right">…</div> subtree intercepts pointer events
      - retrying click action
        - waiting 500ms
        - waiting for element to be visible, enabled and stable
        - element is visible, enabled and stable
        - scrolling into view if needed
        - done scrolling
        - <div class="comments-empty">No comments yet</div> from <div class="sidebar" data-side="right">…</div> subtree intercepts pointer events
  - retrying click action
    - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=e5]:
  - complementary [ref=e6]: research grade software. do not share links. sharing a doc is sharing your account.
  - generic [ref=e11]:
    - button "Hide sidebar" [pressed] [ref=e12] [cursor=pointer]:
      - img [ref=e13]
    - generic [ref=e15]:
      - generic [ref=e16]:
        - complementary [ref=e21]:
          - tree [ref=e22]:
            - generic [ref=e23]:
              - button "create new" [ref=e25]:
                - img [ref=e26]
              - generic [ref=e29]:
                - img [ref=e30]
                - textbox "Filter by title" [ref=e33]
            - group [ref=e35]:
              - treeitem "Examples" [ref=e36]:
                - button "expand Examples" [ref=e37] [cursor=pointer]:
                  - img [ref=e38]
                - generic [ref=e40]: Examples
            - treeitem "CAD Model" [selected] [ref=e42]:
              - generic [ref=e43]: CAD Model
        - contentinfo [ref=e45]:
          - button "Account" [ref=e46] [cursor=pointer]:
            - img [ref=e51]
          - button "Packages" [ref=e54] [cursor=pointer]
          - button "Settings" [ref=e55] [cursor=pointer]
      - button "Toggle or resize sidebar" [ref=e56]
    - 'button "Theme: lychee" [ref=e62] [cursor=pointer]'
    - generic [ref=e68]:
      - generic [ref=e69]:
        - generic [ref=e70]:
          - generic "Rename" [ref=e72]: CAD Model
          - generic [ref=e74]:
            - button "Add to sidebar" [ref=e78] [cursor=pointer]
            - button "Open with…" [ref=e82] [cursor=pointer]
            - button [ref=e86] [cursor=pointer]:
              - img [ref=e87]
        - generic [ref=e93]:
          - toolbar [ref=e94]:
            - button "Sketch" [ref=e95] [cursor=pointer]
            - button "Extrude" [ref=e96] [cursor=pointer]
            - button "Fillet" [ref=e97] [cursor=pointer]
            - button "Chamfer" [ref=e98] [cursor=pointer]
            - button "Code" [pressed] [ref=e100] [cursor=pointer]
          - generic [ref=e108]:
            - generic [ref=e110]:
              - generic [ref=e111]: "1"
              - generic [ref=e112]: "2"
              - generic [ref=e113]: "3"
              - generic [ref=e114]: "4"
              - generic [ref=e115]: "5"
              - generic [ref=e116]: "6"
              - generic [ref=e117]: "7"
              - generic [ref=e118]: "8"
              - generic [ref=e119]: "9"
              - generic [ref=e120]: "10"
              - generic [ref=e121]: "11"
              - generic [ref=e122]: "12"
              - generic [ref=e123]: "13"
              - generic [ref=e124]: "14"
              - generic [ref=e125]: "15"
              - generic [ref=e126]: "16"
              - generic [ref=e127]: "17"
              - generic [ref=e128]: "18"
            - textbox [active] [ref=e129]:
              - generic [ref=e130]: "// M1 from research/03: a block with a through notch, the notch's top arc filleted, the front-top"
              - generic [ref=e131]: // edge right of the notch chamfered, and a boss on the front face right of the notch.
              - generic [ref=e132]: "import { sketch, plane, rect, circle, extrude, fillet, chamfer, edge } from \"@patchwork-cad/features\";"
              - generic [ref=e134]: "export const defaultParams = { w: 60, d: 40, h: 20, a: 30, r: 8 };"
              - generic [ref=e136]: "export default function main({ w, d, h, a, r }) {"
              - generic [ref=e137]: "const sketch1 = sketch({ plane: plane(\"XY\"), profile: rect({ from: [0, 0], to: [w, d] }) });"
              - generic [ref=e138]: "const extrude1 = extrude({ sketch: sketch1, distance: h });"
              - generic [ref=e139]: "const sketch2 = sketch({ plane: plane(\"XY\"), profile: circle({ center: [a, 0], radius: r }) });"
              - generic [ref=e140]: "const notch = extrude({ sketch: sketch2, operation: \"cut\", target: extrude1, extent: \"through\" });"
              - generic [ref=e141]: "const fillet1 = fillet({ body: notch, edges: [edge(extrude1.end, notch.side.c)], radius: 1.5 });"
              - generic [ref=e142]: "const chamfer1 = chamfer({ body: fillet1, edges: [edge(extrude1.end, extrude1.side.front).piece(notch, 1, { near: [49.75, 0, 20] })], distance: 1 });"
              - generic [ref=e143]: "const sketch3 = sketch({ body: chamfer1, plane: extrude1.side.front.piece(notch, 2, { near: [49.501, 0, 9.499] }), profile: circle({ center: [w - 6, h / 2], radius: 2 }) });"
              - generic [ref=e144]: "const extrude2 = extrude({ sketch: sketch3, distance: 4, operation: \"join\", target: chamfer1 });"
              - generic [ref=e145]: return extrude2;
              - generic [ref=e146]: "}"
          - navigation "Timeline" [ref=e148]:
            - button "✎︎ sketch1" [ref=e149] [cursor=pointer]:
              - generic [ref=e150]: ✎︎
              - generic [ref=e151]: sketch1
            - button "⬆︎ extrude1" [ref=e152] [cursor=pointer]:
              - generic [ref=e153]: ⬆︎
              - generic [ref=e154]: extrude1
            - button "✎︎ sketch2" [ref=e155] [cursor=pointer]:
              - generic [ref=e156]: ✎︎
              - generic [ref=e157]: sketch2
            - button "⬆︎ notch" [ref=e158] [cursor=pointer]:
              - generic [ref=e159]: ⬆︎
              - generic [ref=e160]: notch
            - button "◜︎ fillet1" [ref=e161] [cursor=pointer]:
              - generic [ref=e162]: ◜︎
              - generic [ref=e163]: fillet1
            - button "◸︎ chamfer1" [ref=e164] [cursor=pointer]:
              - generic [ref=e165]: ◸︎
              - generic [ref=e166]: chamfer1
            - button "✎︎ sketch3" [ref=e167] [cursor=pointer]:
              - generic [ref=e168]: ✎︎
              - generic [ref=e169]: sketch3
            - button "⬆︎ extrude2" [ref=e170] [cursor=pointer]:
              - generic [ref=e171]: ⬆︎
              - generic [ref=e172]: extrude2
          - status [ref=e173]:
            - generic [ref=e174]: "OCCT: compile 126 ms, init 67 ms · build 48 ms"
      - generic [ref=e175]:
        - button "Toggle or resize sidebar" [ref=e176]
        - generic [ref=e177]:
          - generic [ref=e178]:
            - tablist [ref=e179]:
              - tab "Comments" [ref=e180] [cursor=pointer]
              - tab "Drafts" [ref=e181] [cursor=pointer]
              - tab "History" [ref=e182] [cursor=pointer]
              - tab "Watercooler" [ref=e183] [cursor=pointer]
            - button "Hide context sidebar" [ref=e184] [cursor=pointer]:
              - img [ref=e185]
          - generic [ref=e189]:
            - generic [ref=e190]:
              - generic [ref=e191]: Comments
              - button "Add comment" [ref=e192] [cursor=pointer]
            - generic [ref=e193]: No comments yet
```

# Test source

```ts
  1   | import { readFileSync } from "node:fs";
  2   | import { join } from "node:path";
  3   | import type { Page } from "@playwright/test";
  4   | import { HARNESS_DIR } from "./stack.ts";
  5   | import { createViaMenu, editor, pressMod } from "./ui.ts";
  6   | 
  7   | /** The CAD tool package (src/cad), served as a static module. Build it first (`pnpm --filter patchwork-cad build`). */
  8   | export const CAD_DIR = join(HARNESS_DIR, "..", "cad");
  9   | export const CAD_MODULES = { cad: CAD_DIR };
  10  | 
  11  | /**
  12  |  * M1 from the naming benchmark (research/03), written with replicad: a block
  13  |  * with a through notch on its front face, the notch's top arc filleted, the
  14  |  * front-top edge right of the notch chamfered, and a boss on the front face.
  15  |  */
  16  | export const M1_SOURCE = (a: number) => `import { drawRectangle, drawCircle } from "replicad";
  17  | 
  18  | export default function main() {
  19  |   const w = 60, d = 40, h = 20, a = ${a}, r = 8;
  20  |   let s = drawRectangle(w, d).translate(w / 2, d / 2).sketchOnPlane("XY").extrude(h);
  21  |   s = s.cut(drawCircle(r).translate(a, 0).sketchOnPlane("XY").extrude(h));
  22  |   s = s.fillet(1.5, (e) => e.ofCurveType("CIRCLE").inPlane("XY", h));
  23  |   s = s.chamfer(1, (e) => e.ofCurveType("LINE").containsPoint([w - 2, 0, h]));
  24  |   return s.fuse(drawCircle(2).translate(w - 6, h / 2).sketchOnPlane("XZ").extrude(4));
  25  | }
  26  | `;
  27  | 
  28  | export const cadView = (page: Page) => page.locator(".cad-model");
  29  | 
  30  | /** Vertices of the shown mesh, or 0 before the first one. */
  31  | export async function vertices(page: Page): Promise<number> {
  32  |   return Number((await page.locator(".cad-model__viewer").getAttribute("data-vertices")) ?? 0);
  33  | }
  34  | 
  35  | /** Replaces the whole model source by typing into the editor (one undoable edit per key). */
  36  | export async function replaceSource(page: Page, source: string): Promise<void> {
> 37  |   await editor(page).click();
      |                      ^ Error: locator.click: Target page, context or browser has been closed
  38  |   await pressMod(page, "a");
  39  |   await page.keyboard.press("Delete");
  40  |   // insertText skips CodeMirror's auto-indent and bracket closing, so the text arrives verbatim.
  41  |   await page.keyboard.insertText(source);
  42  | }
  43  | 
  44  | export type EntityKind = "face" | "edge";
  45  | export interface Entity {
  46  |   body: string;
  47  |   kind: EntityKind;
  48  |   index: number;
  49  | }
  50  | 
  51  | interface ViewerHook {
  52  |   cadViewer: { screenPoint(e: Entity): { x: number; y: number } | undefined; entities(kind: EntityKind): Entity[] };
  53  | }
  54  | 
  55  | /** The open document's URL fragment parameters. */
  56  | const hashParams = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
  57  | 
  58  | /** Switches the open document to another tool, as the tool picker does (`#doc=…&tool=…`). */
  59  | export async function openWithTool(page: Page, toolId: string): Promise<void> {
  60  |   const params = hashParams(page);
  61  |   params.set("tool", toolId);
  62  |   await page.evaluate((hash) => (location.hash = hash), params.toString());
  63  | }
  64  | 
  65  | /** Opens the code pane of the editor (the default tool), unless it is open. */
  66  | export async function openCode(page: Page): Promise<void> {
  67  |   const toggle = page.locator(".cad-editor__toolbar").getByRole("button", { name: "Code" });
  68  |   if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  69  |   await page.locator(".cad-model__code .cm-content").waitFor();
  70  | }
  71  | 
  72  | /** Creates a CAD model through the create-new menu; it opens in the default tool, or then in `tool`. */
  73  | export async function createModel(page: Page, tool?: string): Promise<void> {
  74  |   await createViaMenu(page, "CAD Model");
  75  |   if (tool) await openWithTool(page, tool);
  76  | }
  77  | 
  78  | /** The path that opens the current document, in `tool` if given. */
  79  | export function docPathWith(page: Page, tool?: string): string {
  80  |   const params = hashParams(page);
  81  |   if (tool) params.set("tool", tool);
  82  |   else params.delete("tool");
  83  |   return `/#${params.toString()}`;
  84  | }
  85  | 
  86  | /** The open document's automerge URL. */
  87  | export const docUrl = (page: Page) => hashParams(page).get("doc")!;
  88  | 
  89  | /** The model source, read from the tab's repo. */
  90  | export async function modelSource(page: Page): Promise<string> {
  91  |   return page.evaluate(async (url) => {
  92  |     const repo = (window as unknown as { repo: { find(u: string): Promise<{ doc(): { source: string } }> } }).repo;
  93  |     return (await repo.find(url)).doc().source;
  94  |   }, docUrl(page));
  95  | }
  96  | 
  97  | /**
  98  |  * Changes the model source through the tab's repo. By default with `updateText`, which splices only
  99  |  * the changed characters, as typing them would; "replace" assigns the string, which replaces the
  100 |  * whole text object, as a tool rewriting the file might.
  101 |  */
  102 | export async function setModelSource(page: Page, source: string, how: "splice" | "replace" = "splice"): Promise<void> {
  103 |   await page.evaluate(
  104 |     async ([url, text, mode]) => {
  105 |       const repo = (window as unknown as { repo: { find(u: string): Promise<{ change(fn: (d: { source: string }) => void): void }> } }).repo;
  106 |       // The page's importmap provides the same automerge as the repo's.
  107 |       const specifier = "@automerge/automerge";
  108 |       const { updateText } = (await import(specifier)) as { updateText(d: unknown, path: string[], text: string): void };
  109 |       (await repo.find(url!)).change((d) => (mode === "replace" ? (d.source = text!) : updateText(d, ["source"], text!)));
  110 |     },
  111 |     [docUrl(page), source, how],
  112 |   );
  113 | }
  114 | 
  115 | const viewer = (page: Page) => page.locator(".cad-model__viewer").first();
  116 | 
  117 | /** The pickable entities the viewer shows. */
  118 | export async function entities(page: Page, kind: EntityKind): Promise<Entity[]> {
  119 |   return viewer(page).evaluate((el, k) => (el as unknown as ViewerHook).cadViewer.entities(k), kind);
  120 | }
  121 | 
  122 | /** Clicks the pixel where the viewer's raycasting finds the entity, as a user would. */
  123 | export async function clickEntity(page: Page, entity: Entity): Promise<void> {
  124 |   const point = await viewer(page).evaluate((el, e) => (el as unknown as ViewerHook).cadViewer.screenPoint(e), entity);
  125 |   if (!point) throw new Error(`entity ${JSON.stringify(entity)} is not visible`);
  126 |   await page.mouse.click(point.x, point.y);
  127 | }
  128 | 
  129 | /** Whether an entity is visible and clickable. */
  130 | export async function isVisible(page: Page, entity: Entity): Promise<boolean> {
  131 |   return viewer(page).evaluate((el, e) => (el as unknown as ViewerHook).cadViewer.screenPoint(e) !== undefined, entity);
  132 | }
  133 | 
  134 | export const editorView = (page: Page) => page.locator(".cad-model--editor");
  135 | export const timelineEntry = (page: Page, name: string) => page.locator(`.cad-editor__entry[data-name="${name}"]`);
  136 | export const dialog = (page: Page) => page.locator(".cad-editor__dialog");
  137 | 
```