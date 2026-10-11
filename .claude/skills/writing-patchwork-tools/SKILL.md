---
name: writing-patchwork-tools
description: >-
  Build, scaffold, or modify a Patchwork tool, datatype, or action.
  Use whenever creating a new tool from scratch, porting something into Patchwork,
  adding a datatype/tool/action plugin, wiring an automerge document model, or
  setting up the build/sync (vite + pushwork). House style: Solid + TypeScript with a
  vite bundle by default; if the user asks
  for a specific framework (React, Svelte, …), build with that. Covers the plugin
  registration shape, the (handle, element) => cleanup render contract, the datatype
  lifecycle, bundleless vs bundled builds, multiplayer/ephemeral messaging, the
  importmap, and the common gotchas (undefined assignment, Solid click delegation,
  light-DOM CSS).
---

# Writing Patchwork Tools

A Patchwork tool is a **plugin module** that registers one or more plugins and renders a
view into a host-provided DOM element. The host (Patchwork) supplies the automerge `repo`,
the document `DocHandle`, and the element to render into. You ship an ES module; Patchwork
loads it.

There is **no shadow DOM** — tools render into the **light DOM** inside a `<patchwork-view>`.
Namespace your CSS class names and inject styles with the JS bundle (see Build).

## 1. House style

These are the defaults for **new** tools. Follow them unless the user says otherwise.

- **Default to Solid + TypeScript with a vite bundle.** That's what most real tools are:
  `src/` with `.ts`/`.tsx`, `solid-js` with JSX, built by vite (section 12) and synced with
  pushwork. Solid gives fine-grained reactivity over the doc signal (section 4) without a virtual
  DOM.
- **Other frameworks are opt-in.** Don't reach for React, Svelte, Vue, etc. by default — but if
  the user asks for a specific framework, build with that framework. The host supports anything
  that bundles to an ES module and renders into a DOM element (see sections 4 and 12). When editing an
  existing tool, match its framework and style rather than rewriting it.
- **Learn from real tools before writing one.** Checkouts of patchwork-base (reusable core
  tools) and patchwork-experiments (a wide corpus of examples) ship with this skill under
  `reference/` (see section 15). Before building a new tool, read one or two tools that
  solve a similar problem and copy their patterns. Also check whether an existing tool can be reused.

Rule of thumb: **Solid + TypeScript (vite bundle) by default; another framework only when the user asks for one,
or when modifying a tool that already uses it.**

## 2. Plugin registration — `export const plugins`

Every tool module exports `plugins`, an array of plugin objects. Three plugin `type`s:

```js
export const plugins = [
  {
    type: "patchwork:datatype", // describes a document shape
    id: "tic-tac-toe",
    name: "Tic Tac Toe",
    icon: "Grid3x3", // a lucide-react icon NAME
    // unlisted: true,              // hide from "new document" menus (e.g. "file")
    async load() {
      return TicTacToeDatatype; // the datatype object (see section 3)
    },
  },
  {
    type: "patchwork:tool", // a view/editor for a datatype
    id: "tic-tac-toe", // ⚠ referenced from docs/embeds — keep it stable (see `id` rule below)
    name: "Tic Tac Toe",
    icon: "Grid3x3",
    supportedDatatypes: ["tic-tac-toe"], // or ["*"] for any doc (e.g. inspectors)
    async load() {
      return Tool; // a render function (see section 4)
    },
  },
];
```

- `load()` is **async** and lazy — `import()` the heavy code inside it so the registry stays
  cheap. Bundleless tools often `return SomeObject` directly; bundled tools
  `const { X } = await import("./x"); return X`.
- **Split the datatype and the tool into separate files and `import()` each inside its own
  `load()`.** The entry module that exports `plugins` should contain only the plugin metadata
  (`type`, `id`, `name`, `icon`, `supportedDatatypes`) plus thin `load()` functions — no
  datatype object, no render function, no heavy deps in the top-level scope. Put the datatype
  in e.g. `datatype.js` and the tool in `tool.js`, then:

  ```js
  export const plugins = [
    {
      type: "patchwork:datatype",
      id: "counter",
      name: "Counter",
      icon: "Hash",
      async load() {
        return (await import("./datatype.js")).CounterDatatype;
      },
    },
    {
      type: "patchwork:tool",
      id: "counter",
      name: "Counter",
      icon: "Hash",
      supportedDatatypes: ["counter"],
      async load() {
        return (await import("./tool.js")).default;
      },
    },
  ];
  ```

  The tool file should **`export default`** its render function so `load()` can grab `.default`
  without caring what it's named. (The datatype file can do the same, or use a named export.)

  Why: Patchwork reads the `plugins` array up front just to list tools/datatypes (names,
  icons, supported types). If the datatype and render code live in the entry module, that whole
  payload — codemirror, solid, audio/wasm, etc. — gets parsed just to show a description.
  Keeping each `load()` as a one-line dynamic import means the entry module is tiny, descriptions
  load instantly, and a heavy file is only fetched when that specific plugin is actually used.

  **Concrete threshold:** the minimal bundleless shape (section 14 — a thin entry plus one
  implementation file) is fine while the tool is one datatype + one tool, has no npm
  dependencies, and the implementation stays around ~200 lines. Move to the bundled
  Solid + TypeScript layout (`src/` + vite, section 12) as soon as any of that stops being true —
  you pull in a dependency, add more plugins, or the file keeps growing.

- **`id` rule:** a tool's `id` is a public identifier that other places reference: docs and
  embeds can "pin" a tool — record a `toolId` saying "open this document with that specific
  tool" (e.g. `openDocument(element, url, toolId)` in section 8, a doc-link's or embed's tool field,
  a sidebar pin). Those references resolve by exact string match against the registered `id`,
  so always use the id the tool registers with, and don't rename an id once docs reference
  it — existing pins would silently stop resolving.
- `icon` is a [lucide](https://lucide.dev) icon name (`"Music"`, `"Database"`, `"File"`,
  `"Sparkles"`, `"Cat"`, `"Grid3x3"`…).
- A package can register **many** plugins (a datatype + its tool, or several datatypes).

### ⚠ The entry module runs in a worker — every plugin field must be serializable

Patchwork loads the module that exports `plugins` **inside a Web Worker**, reads the array,
and **`structuredClone`s each plugin entry to the main thread**. Two hard consequences:

1. **No functions as top-level plugin fields (except `load`).** The host clones every field of
   a plugin _except_ `load` (which it strips and reconstructs on the main side). Any other
   function-valued field throws `DataCloneError: (…) => … could not be cloned` and the whole
   module fails to import. So a plugin entry may only carry **JSON-ish metadata** at the top
   level (`type`, `id`, `name`, `icon`, `tier`, strings, numbers, arrays, plain objects, and
   `RegExp`/`Date`/`Map`/`Set` — all clone-safe). **All "fancy code" — every function, and any
   behaviour object — must live behind `async load()`**, which returns it (the registry exposes
   the loaded result under the plugin's `.module`). This is exactly why the `patchwork:tool`
   render function and the datatype object go behind `load()`, and it applies equally to any
   **custom-typed** plugins you register (e.g. `chat:slash`, `chat:messageaction`,
   `sketchy:*`). If you have an array of behaviour-bearing descriptors, register them as
   metadata-only descriptions and defer the code:

   ```js
   // WRONG — `transform` is a top-level function → DataCloneError in the worker
   { type: "chat:slash", id: "me", cmd: "/me", transform: (arg) => ({ text: arg }) }

   // RIGHT — metadata only at the top level; the fn is returned by load()
   { type: "chat:slash", id: "me", cmd: "/me",
     async load() { return { transform: (arg) => ({ text: arg }) } } }
   ```

   (A tool can still keep the inline-function version in a _separate_ module it imports on the
   main thread for its own use — that copy is never cloned. Only what goes into the exported
   `plugins` array crosses the worker boundary.)

2. **No bare external imports in the entry module's static graph.** The worker has **no
   importmap**, so a top-level `import … from "@inkandswitch/patchwork-plugins"` (or any other
   importmap-provided / bootloader-external specifier) fails with _"Failed to resolve module
   specifier"_ — even transitively, and even if the imported binding is unused (marked-external
   modules can't be tree-shaken, so bundlers keep a bare side-effect `import`). Keep such
   imports **inside `load()`** (dynamic `import()`), which runs on the main thread where the
   importmap exists. If a data-only helper module (e.g. your plugin metadata) accidentally pulls
   in an external via one stray import, split that import out so the entry graph stays clean.

## 3. The datatype contract

A datatype object describes a document type and how to title it:

```js
export const TicTacToeDatatype = {
  init(doc) {
    // seed a brand-new doc (runs inside a change)
    doc.title = "Tic Tac Toe";
    doc.board = [null, null, null, null, null, null, null, null, null];
    doc.currentPlayer = "X";
    doc.status = "playing";
    doc.winner = null;
  },
  getTitle(doc) {
    // string shown in the UI / file lists
    return doc.title || "Tic Tac Toe";
  },
  setTitle(doc, title) {
    // rename (called inside a handle.change)
    doc.title = title;
  },
};
```

- `init` defines your **document schema** by example — the fields you set here are your data
  model. Keep it flat and automerge-friendly (plain objects/arrays/strings/numbers). The host
  calls it inside a `change()` when a document of this type is created (e.g. from the
  "new document" menu, section 12), passing the repo as a second argument (`init(doc, repo)`) in
  case you need to create linked docs.
- `getTitle`/`setTitle` are required for a doc to show a name. `markCopy` is optional.
- Datatypes can carry richer helpers/exports too (type guards, content getters).

## 4. The tool render contract — `(handle, element) => cleanup`

A tool's `load()` resolves to a **render function**. It receives the document `DocHandle` and
the host `element`, mounts UI into `element`, and **returns a cleanup function**.

**Solid (the default).** Use `solid-js` with JSX in a vite bundle, or `solid-js/html` tagged
templates without a build step — both give the same fine-grained updates. The pattern is the
same either way: wrap the doc in a signal you push to from the `change` event; write dynamic
expressions as functions so they stay reactive. `render()` returns a disposer — return it from
cleanup. The `solid-js/html` version:

```js
import { render } from "solid-js/web";
import html from "solid-js/html";
import { createSignal } from "solid-js";

function CounterTool(handle, element) {
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);

  const dispose = render(
    () =>
      html`<button
        onClick=${() =>
          handle.change((d) => {
            d.count++;
          })}
      >
        count: ${() => doc().count}
      </button>`,
    element,
  );
  return () => {
    handle.off("change", onChange);
    dispose();
  };
}
```

With JSX in a bundle, the same tool is `render(() => <Counter handle={handle} />, element)`
with the signal living inside the component.

**Other frameworks (when the user asks for one, or in existing tools that use one).** Any
framework that renders into a DOM element fits the same contract — mount in the render function,
tear down in cleanup. React, for example:

```js
import { createRoot } from "react-dom/client";
export function Tool(handle, element) {
  const root = createRoot(element);
  root.render(<App handle={handle} element={element} />);
  return () => root.unmount();
}
```

(Some existing tools have no framework at all and just rebuild the DOM inside
`handle.on("change", …)` — fine to read for their behavior, but don't start new tools that
way; use Solid.)

The cleanup function is **mandatory** — Patchwork calls it when the tool unmounts. Remove
listeners, dispose roots, cancel intervals/animation frames, close audio contexts.

## 5. Reading & writing the automerge document

```js
const doc = handle.doc(); // synchronous snapshot of current state
handle.change((d) => {
  d.foo = 1;
}); // ALL writes go through change()
handle.on("change", render); // fires on local + remote edits
handle.off("change", render);
```

**Automerge gotchas:**

- You **cannot assign `undefined`** to a doc property. To remove a field, `delete d.prop`
  inside a `change()`; to nullify, set `d.prop = null`.
- Always mutate inside `handle.change(d => …)`. Never mutate `handle.doc()` directly.
- Keep the model JSON-shaped. For collaborative **text**, prefer
  [`@automerge/automerge-codemirror`](https://github.com/automerge/automerge-codemirror)
  plus Automerge cursors over naive string replacement. Note that it is **not on the
  importmap** (section 9): using it means the **bundled** flavor, with the package as a normal npm
  dependency (the `@automerge/automerge` and `@codemirror/*` packages it imports stay
  external and resolve through the importmap). A bundleless tool is limited to the raw
  `@codemirror/*` packages the importmap provides.

For the data model in depth — how collaborative text edits work, counters, conflict
semantics, splitting state across linked documents — read the sibling skill
**`working-with-automerge`** rather than working from memory; the bullets above are only
the tool-facing gotchas.

## 6. Globals & the repo

Patchwork exposes globals — use them directly, don't dig through handles:

```js
window.repo; // the automerge Repo
window.accountDocHandle; // current user's account DocHandle
window.hive; // tool/datatype registry

const handle = await repo.find(url); // ⚠ returns a Promise<DocHandle>, already ready
const fresh = repo.create(initial); // create a new doc (synchronous, handle is ready)
```

`repo.create(initial)` takes the complete initial document as a plain object and does **not**
run any datatype's `init` — the host runs `init` only when it creates a doc of that type
itself (e.g. from the "new document" menu, see section 12). So when your tool creates docs, either
pass the full initial shape to `create`, or call your datatype's `init` inside a
`handle.change()` afterwards. Also set the `@patchwork` metadata (e.g.
`{ type: "my-datatype" }`) if the doc should be recognized as your datatype.

**Current automerge-repo API** (do not use the old patterns):

```js
// WRONG — old API
const handle = repo.find(url);
await handle.whenReady();
// CORRECT — current API
const handle = await repo.find(url);
```

Get the user's name:
`(await repo.find(window.accountDocHandle.doc().contactUrl)).doc().name`.

## 7. Multiplayer & ephemeral messaging

`DocHandle` has a built-in broadcast channel for **non-persisted** peer-to-peer messages —
ideal for presence, cursors, typing indicators, "now playing" state, WebRTC signaling:

```js
handle.broadcast({ type: "play", playing: true }); // to all peers with this doc open
handle.on("ephemeral-message", (payload) => {
  const msg = payload.message; // the wrapped payload
});
handle.off("ephemeral-message", handler);
```

Messages reach only **currently-connected** peers and are never stored. For persisted shared
state, write to the doc with `handle.change()`.

## 8. Custom DOM events & embedding other tools

Patchwork events bubble and are `composed` (defined in `@inkandswitch/patchwork-elements`):

```js
import { openDocument } from "@inkandswitch/patchwork-elements";
openDocument(element, url, toolId); // navigate Patchwork to another document

// or manually:
element.dispatchEvent(
  new CustomEvent("patchwork:open-document", {
    detail: { url, toolId },
    bubbles: true,
    composed: true,
  }),
);

element.addEventListener("patchwork:mounted", () => {
  /* inner tool is ready */
});
```

### Embedding other tools — `<patchwork-view>`

A tool can render another document with another tool inline by mounting the
`<patchwork-view>` custom element:

```js
const view = document.createElement("patchwork-view");
view.setAttribute("doc-url", docUrl); // automerge URL of the (sub)document
view.setAttribute("tool-id", "comment-thread"); // which registered tool renders it
element.append(view);
```

This is how tools compose: split your document into linked sub-documents and let existing
editors edit them — e.g. embed a `codemirror-markdown` view for a notes field or a
`contact-avatar` for an author — instead of rebuilding those editors inside your tool. The
`embed` tool in patchwork-base wraps a nested patchwork-view in a shared frame (title bar,
tool picker, open button) if you want chrome around it.

**Depend only on patchwork-base.** Its tools are safe to depend on — embed them by tool id,
reuse their datatypes. Never depend on anything from patchwork-experiments; those tools are
unsupported and can change or disappear.

## 9. The importmap (bare imports — no CDN needed)

Patchwork provides an importmap, so both flavors can `import` these by bare specifier:

- `@automerge/automerge` (and `/slim`), `@automerge/automerge-repo` (and `/slim`)
- `@automerge/automerge-repo-keyhive`, `@keyhive/keyhive`
- `@inkandswitch/patchwork-bootloader`, `-elements`, `-filesystem`, `-plugins`, `-providers`,
  and `@inkandswitch/patchwork`
- `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/commands`
- `solid-js` and its subpaths (`solid-js/web`, `/store`, `/html`, `/h`, `/jsx-runtime`)

That list is the whole importmap (it mirrors the bootloader's externals list). **Anything not
on it — `@automerge/automerge-codemirror`, leaflet, d3, lodash, React, … — is a normal npm
dependency and requires the bundled flavor**: vite bundles it into your `dist/index.js` while
the importmap packages stay external. There is no way to bare-import such packages from a
bundleless tool.

Use direct imports (`import("@codemirror/view")`) — never esm.sh / unpkg URLs for these.
In bundleless tools, load your own static assets with `new URL("./x.flac", import.meta.url)`.

**Network access:** the host sets no Content-Security-Policy, so tools can `fetch()`
third-party APIs and load remote images/tiles directly; ordinary browser CORS rules are the
only constraint.

**Third-party CSS** (e.g. `leaflet/dist/leaflet.css`): `import` it from your **tool module**
(not the worker-parsed entry module — see section 12) so `vite-plugin-css-injected-by-js` ships it
with the JS. Vendor stylesheets carry their own namespaced class names (`.leaflet-*`), which
is fine — the "scope all CSS under a root class" rule (section 13) applies to CSS **you write**, not
to a vendored library's own classes. Don't try to rewrite vendor CSS. One trap: vendor CSS
that references sibling assets by relative URL (leaflet's default marker PNGs, icon fonts)
breaks once the CSS is inlined into JS — those URLs no longer resolve. Prefer the library's
DOM/inline alternatives (e.g. leaflet `divIcon`s), or import the assets yourself and point
the library at the bundled URLs.

## 10. Working with files & assets

From `@inkandswitch/patchwork-filesystem`:

```ts
type FolderDoc = { title: string; docs: DocLink[] };
type DocLink = {
  name: string;
  type: string;
  url: AutomergeUrl;
  icon?: string;
  copyOf?: AutomergeUrl;
};
type UnixFileEntry = {
  content: string | Uint8Array | ImmutableString;
  extension: string;
  mimeType: string;
  name: string;
};
```

- `automergeUrlToServiceWorkerUrl(url)` → a URL usable as `<img src>` / `<audio src>` for a
  doc's bytes. Import from `@inkandswitch/patchwork-filesystem`.
- Docs may carry a `@patchwork` metadata field: `{ type: "file", suggestedImportUrl: "…" }`.
- Load a datatype at runtime: `await getRegistry("patchwork:datatype").load(id)`.

## 11. Styling & theming

**Do NOT use Tailwind, DaisyUI, or any CSS framework.** Write plain CSS following the
CUBE CSS methodology (cube.fyi). The theming system provides CSS custom properties for
colors, fonts, spacing, radius, and shadows.

### CUBE CSS methodology

We structure CSS using **Composition, Utility, Block, Exception** layers:

1. **Composition** — layout primitives that control how elements flow and relate to each
   other. These are generic and reusable (e.g. a `.flow` class that adds vertical rhythm,
   a `.cluster` for inline groups with gap). Composition classes never apply visual
   treatments — only spacing and layout.

2. **Block** — the namespaced component. A block is a skeletal container for one
   contextual piece of UI (e.g. `.history-panel`, `.sideboard`, `.comments-thread`).
   Blocks define their appearance using local CSS variables derived from the theme.
   Child elements use simple descendant selectors: `.my-tool .header`, `.my-tool .title`.

3. **Exception** — a state deviation from a block, applied via **data attributes** (not
   class modifiers). E.g. `data-selected`, `data-state="reversed"`, `data-expanded`.

```html
<!-- Block with exception via data attribute -->
<div class="history-item" data-selected>…</div>

<!-- Composition + Block together -->
<div class="flow comments-panel">…</div>
```

```css
/* Composition — generic layout */
.flow > * + * {
  margin-top: var(--flow-space, var(--studio-space, 0.75rem));
}

/* Block — the component */
.history-item {
  display: flex;
  gap: var(--studio-space-sm, 0.5rem);
  padding: var(--studio-space-xs, 0.375rem);
  border-radius: var(--studio-radius-sm, 4px);
  cursor: pointer;
}

/* Exception — state via data attribute */
.history-item[data-selected] {
  background: var(--history-accent);
  color: var(--history-accent-fg);
}
```

### `--editor-*` vs `--studio-*`: which to derive from

The theme exposes two families of surface variables:

- **`--editor-*`** — the surface a _tool/editor_ paints on (the document content area). **Most
  tools should derive their fill, line, and typography from `--editor-*`.** The editor surface
  can be themed independently of the studio chrome (e.g. a document with its own paper colour),
  and `--editor-*` defaults to the matching `--studio-*` value, so deriving from editor is
  always at least as correct as deriving from studio.
- **`--studio-*`** — the studio's own **chrome**: the top bar, bottom bar, and sidebar. These
  belong to `patchwork-frame` (the studio shell). Only UI that _is_ the studio chrome should
  derive its fill/line from `--studio-*`.

Rule of thumb: if you're building a tool, derive fill/line/typography from `--editor-*`. Reach
for `--studio-*` only when you're styling the studio frame itself.

Accent colours (`--studio-primary` etc.), spacing, radius, shadow, and transition tokens are
**studio-global** — the accent itself has no `--editor-*` equivalent, so use `--studio-*`
everywhere. The one exception is the accent `-text` variant (accent used _as ink on a
surface_), which does fan out per surface — see the accent section below.

### CSS variables

Use these variables (with fallbacks) instead of hardcoded values:

**Colors (derive from `--editor-*` in tools):**

- `var(--editor-fill, white)` / `var(--editor-line, black)` — background/foreground
- `var(--editor-fill-offset-10)` through `-50` — tinted backgrounds (mix of fill + line)
- `var(--editor-line-offset-10)` through `-50` — muted text (mix of line + fill)
- `var(--editor-selection-fill)` / `var(--editor-selection-line)`, `var(--editor-cursor-fill)`

**Accent colors:**

- `var(--studio-primary, #35f7ca)`, `--studio-secondary`, `--studio-danger`, `--studio-warning`
- `var(--studio-added)`, `--studio-deleted`, `--studio-modified`, `--studio-link`

Each of `primary`/`secondary`/`danger`/`warning` also ships as a **Bulma-style contrast pair**
plus a text variant — pick by how you're using the accent:

- **`--studio-{accent}-fill`** — the accent used as a _surface_ (a button/pill/badge
  background). Same value as the bare `--studio-{accent}`, but says "I'm a surface".
- **`--studio-{accent}-line`** — the _invert_: ink (text/icons) placed **on** that fill, e.g.
  the label inside a primary button. Legible on the accent regardless of light/dark theme.
- **`--studio-{accent}-fill-offset-10..50`** — a hover/border ramp for the fill (like
  `--studio-chrome-fill-offset-*`). `-10` == the fill itself; the first visible step is `-20`.
- **`--studio-{accent}-text`** — the accent used **as ink on the ambient background** (a
  primary-coloured heading/link on the normal page). This is the one that fans out per surface:
  use **`--editor-{accent}-text`** on the editor surface and **`--text-editor-{accent}-text`**
  in a text editor, since legibility depends on which background the text sits on.

Rule of thumb: painting a surface the accent → `-fill` (+ `-line` for text on it, `-fill-offset-*`
for its hover). Writing text _in_ the accent on a normal background → `-text` (surface-matched).

**Typography (derive from `--editor-*` in tools):**

- `var(--editor-family-sans, system-ui, sans-serif)` — UI text
- `var(--editor-family-code, ui-monospace, monospace)` — code/mono
- `var(--editor-font-size, 16px)`, `var(--editor-line-height, 1.5)`, `var(--editor-font-weight)`

**Spacing:**

- `var(--studio-space-2xs)` (4px) through `var(--studio-space-2xl)` (48px)

**Border radius:**

- `var(--studio-radius-sm, 4px)` through `var(--studio-radius-xl, 16px)`
- `var(--studio-radius-round, 9999px)` for pills

**Shadows:**

- `var(--studio-shadow-sm)` through `var(--studio-shadow-lg)`

**Transitions:**

- `var(--studio-transition-fast, 0.1s ease)` through `var(--studio-transition-slow, 0.25s ease)`

### CSS file structure

Every tool's CSS follows this structure:

1. **Define local variables in a `@layer package` block targeting `:root, :host, [theme]`** so
   they re-evaluate when a theme is applied (the theme system sets a `[theme]` attribute on
   `<html>`) and sit at the right cascade priority (see "CSS cascade layers" below). The
   `@layer package { … }` wrapper is **required** — do NOT define these variables in your
   top-level/root rule or any other unlayered block:

```css
@layer package {
  :root,
  :host,
  [theme] {
    --my-tool-bg: var(--editor-fill, white);
    --my-tool-fg: var(--editor-line, black);
    --my-tool-muted: var(--editor-line-offset-50, #999);
    --my-tool-border: var(--editor-fill-offset-20, #ccc);
    --my-tool-accent: var(--studio-primary, #35f7ca);
    --my-tool-hover: color-mix(
      in oklch,
      var(--editor-fill),
      var(--editor-line) 5%
    );
    --my-tool-family: var(--editor-family-sans, system-ui, sans-serif);
    --my-tool-family-code: var(--editor-family-code, ui-monospace, monospace);
  }
}
```

Note fill/line/typography derive from `--editor-*` (this is a tool), while the accent comes from
`--studio-primary` (accents have no editor equivalent). The `@layer package` wrapper is the one
place every host var your tool consumes is mapped to a `--my-tool-*` token; style rules below
reference only those tokens.

**Important:** Global `--editor-*` and `--studio-*` variables must NEVER be used directly in CSS
rules. They should ONLY appear inside `:root, :host, [theme]` derivation blocks. The derived
`--my-tool-*` variables are what you use in actual rules. This ensures themes re-evaluate
correctly when the `[theme]` attribute changes (e.g. switching between light/dark mode).

This holds for **every** tool, even one that only touches a couple of globals — a tool whose
CSS is just `color: var(--editor-line)` and one `font-family` still needs a derivation block
with `--my-tool-fg` / `--my-tool-family` rather than referencing the globals inline. If you find
a global `var(--editor-*)`/`var(--studio-*)` (color, font, or background) anywhere in a style
rule, lift it into a `--my-tool-*` variable in the derivation block and reference that instead.

2. **Composition classes** (if needed) for layout patterns:

```css
.my-tool .flow > * + * {
  margin-top: var(--flow-space, var(--studio-space-sm, 0.5rem));
}
```

Note: spacing (`--studio-space-*`), radius (`--studio-radius-*`), and transition
(`--studio-transition-*`) vars are layout concerns and may be used directly in rules with
their fallbacks — only color, font, and background vars need to be derived.

3. **Block classes** using the local variables:

```css
.my-tool {
  background: var(--my-tool-bg);
  color: var(--my-tool-fg);
  font-family: var(--my-tool-family);
}

.my-tool .header {
  border-bottom: 1px solid var(--my-tool-border);
  color: var(--my-tool-muted);
}
```

4. **Exception rules** via data attributes:

```css
.my-tool .card[data-selected] {
  background: var(--my-tool-accent);
}

.my-tool .card[data-state="editing"] {
  outline: 2px solid var(--my-tool-accent);
}
```

### Derive your colors from the theme

**Never introduce new hex color values.** Derive all colors from the theme using
`color-mix()`:

```css
/* Good — derived from theme (editor surface for a tool) */
background: color-mix(in oklch, var(--editor-fill), var(--editor-line) 5%);
border-color: color-mix(in oklch, var(--studio-primary), transparent 50%);
color: color-mix(in oklch, var(--editor-line), var(--editor-fill) 40%);

/* Bad — hardcoded */
background: #f5f5f5;
border-color: rgba(53, 247, 202, 0.5);
color: #666;
```

When you need "lighter" or "darker", mix with `var(--editor-fill)` or `var(--editor-line)`
respectively (or the `--studio-*` equivalents if you're styling the studio chrome) — **not**
literal `white`/`black` — so the derivations invert correctly in dark themes.

When you **tint an accent** toward the surface (e.g. a soft-filled badge), keep the accent as
`--studio-*` but anchor the mix on the editor surface so it still inverts with the document:

```css
/* Good — studio accent, editor-surface anchor */
--my-tool-badge: color-mix(
  in oklch,
  var(--studio-secondary),
  var(--editor-fill) 60%
);

/* Bad — anchoring the tint on the studio surface inside a tool */
--my-tool-badge: color-mix(
  in oklch,
  var(--studio-secondary),
  var(--studio-fill) 60%
);
```

### Do not handle dark mode

Never add `@media (prefers-color-scheme: dark)` blocks. The theme system handles
light/dark by swapping the CSS variable values. Your tool just uses the variables.

### Plugin type: patchwork:theme

Register a theme plugin to contribute a color scheme:

```js
{ type: "patchwork:theme", id: "my-theme", name: "My Theme",
  style: new URL("./my-theme.css", import.meta.url).href,
  async load() { return {} } }
```

The CSS file should use **only** `[theme="my-theme"]` as its selector — **not** `:root, :host`.
Theme CSS targets the specific `[theme]` attribute value so multiple themes can coexist in the
document simultaneously (the theming system includes all theme CSS files and switches by setting
`[theme]` on `<html>`). The default theme (`theme.css`) uses `:root, :host, [theme]` to provide
base values; individual themes override with `[theme="name"]` only.

### CSS cascade layers

Only **CSS custom property definitions** are wrapped in `@layer package { }`. Actual style
rules live **outside** any layer (unlayered) so they can't be overridden by unlayered resets
or normalise stylesheets.

| CSS type                            | Layer              | Priority                |
| ----------------------------------- | ------------------ | ----------------------- |
| Base system variables (`theme.css`) | `@layer patchwork` | lowest                  |
| Tool variable defaults              | `@layer package`   | middle                  |
| Tool style rules                    | unlayered          | high                    |
| Theme CSS (lychee, gloom, custom)   | unlayered          | high (specificity wins) |

**Variable definitions go in `@layer package`; style rules stay unlayered:**

```css
@layer package {
  :root,
  :host,
  [theme] {
    --my-tool-bg: var(--editor-fill, white);
  }
}

.my-tool {
  background: var(--my-tool-bg);
}
```

If a tool CSS file has **no** variable definitions, it should have **no** `@layer` wrapper at all.

Theme CSS files (`lychee.css`, `gloom.css`, custom themes) must **not** be wrapped in any
layer — they stay unlayered so they reliably override everything.

## 12. Build & sync

**Bundleless:** no build step or toolchain. From the tool dir:
`npx pushwork@latest sync`. `package.json` is minimal:

```json
{ "type": "module", "main": "index.js" }
```

**Bundled (when you want Solid+JSX, TypeScript, npm deps, or a multi-file tree):** mark Patchwork
deps external via the bootloader, output a single ES entry, and inject CSS into the JS (because
there's no shadow DOM, styles must ship with the bundle). A `.jsx`/`.js` or `.tsx`/`.ts` entry
both work — vite compiles them:

```ts
// vite.config.ts — this is the canonical config (copied from a real tool)
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import externals from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  plugins: [solid(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],

  build: {
    sourcemap: true,
    cssCodeSplit: true,
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      external: externals,
      input: "./src/index.ts",
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
      preserveEntrySignatures: "strict",
    },
  },
});
```

The essentials are `format: es`, `external` from the bootloader, and CSS-in-JS. For another
framework, swap `vite-plugin-solid` for that framework's vite plugin (e.g. `vite-plugin-react`);
everything else stays the same.

⚠ **`relativeCSSInjection: true` is not optional.** The entry module is parsed in a Web Worker
(section 2), and with the plugin's default settings the CSS injector — which touches `document` —
lands in the entry chunk and throws there. `relativeCSSInjection: true` (with
`cssCodeSplit: true`) injects each chunk's CSS in the chunk that imports it, so styles load
with the tool code behind `load()` on the main thread. Corollary: import your CSS from the
tool/datatype modules, never from the entry module.

Use **npm** for installs and scripts.

`package.json`: `"main": "./dist/index.js"`, scripts `"build": "vite build"`,
`"push": "npm run build && npx pushwork@latest sync"`, and
`"register": "pw-modules add \"$MODULE_SETTINGS_DOC_URL\" \"$(npx pushwork@latest url)\""`.
After ANY change to a bundled tool: **`cd` into the tool dir, `npm run build`, then
`npx pushwork@latest sync`.**

### First run — from empty directory to running tool

There is no scaffolding generator; you create the files by hand. Publishing uses the
[`pushwork`](https://github.com/inkandswitch/pushwork) CLI — run it as `npx pushwork@latest …`;
don't assume it's installed globally. Registration additionally needs
the `pw-modules` CLI (from the patchwork-next repo, `scripts/module-settings`) plus
`MODULE_SETTINGS_DOC_URL` in the environment — the automerge URL of the
**module-settings doc** the Patchwork site boots from (its `modules` array lists every tool
module the site loads). Neither CLI needs an account or auth; they talk to the public sync
server.

**Check the prerequisites before writing any code:**
`command -v pw-modules && echo "$MODULE_SETTINGS_DOC_URL"`. If something is missing,
ask the user up front how publishing works in their setup — don't build the whole tool first
and discover at the end that you can't ship it.

1. **Scaffold by hand:** create the directory with `package.json` (+ source, + vite config
   if bundled). Section 14 is a complete bundleless example.
2. **`npx pushwork@latest init .`** (first time only): initializes sync for the folder — creates
   `.pushwork/` (local, untracked state: config + automerge storage). From then on
   `npx pushwork@latest url` prints the tool's `automerge:` URL. That URL lives in
   `.pushwork/config.json`; some tools also mirror it in `package.json` under
   `pushwork.url`, but the config is the source of truth.
3. **Publish:** build first if bundled, then `npx pushwork@latest sync`. It prints what it pushed and
   ends with a `SYNCED` verdict once the server has confirmed everything.
4. **Register** (first time only): `npm run register` — i.e.
   `pw-modules add "$MODULE_SETTINGS_DOC_URL" "$(npx pushwork@latest url)"` — appends the tool's URL to
   the settings doc. Idempotent; re-running is a no-op. If `pw-modules` isn't installed or
   you don't know the settings-doc URL, ask the user how tools get registered in their
   setup rather than improvising.
5. **See it in Patchwork:** open (or reload) the Patchwork site booted with that
   `MODULE_SETTINGS_DOC_URL`. A registered `patchwork:datatype` appears in the
   "new document" menu (unless `unlisted: true`); create a document of your type there —
   that runs your `init` — and the matching tool renders it. Later syncs don't
   need re-registering: the running site watches the module doc and reloads the tool when a
   new version lands (reload the page if in doubt).
6. **Verify / debug in the browser:** module-load failures (`DataCloneError`, unresolved
   import specifiers) and render errors land in the devtools console. If the tool doesn't
   appear at all, check the console first — a failed entry-module import rejects the whole
   plugin list (section 2).

## 13. Gotchas checklist

- **No shadow DOM.** Tools render into the light DOM. Namespace CSS classes; don't rely on
  scoped styles. Bundle CSS into the JS (`vite-plugin-css-injected-by-js`).
- **Scope all CSS under a root class.** Put a unique-enough class (the tool id is ideal,
  e.g. `class="my-tool-id"`) on your root element, and nest every selector under it (e.g.
  `.my-tool-id .message { ... }`). Otherwise your styles leak into the rest of Patchwork and
  other tools' styles bleed into yours, since everything shares the light DOM.
- **Size your outermost container; handle scrolling internally.** The host renders tools
  with `layout: contain`, so your tool is a bounded box that won't grow the page or scroll
  itself. Give the outermost container you mount `height: 100%`, then make whichever part
  should scroll handle its own overflow (`overflow: auto`) — that may be the root, or just
  an inner pane (e.g. a message list under a fixed header). Without this the tool clips or
  overflows instead of scrolling within its pane.
- **Never `stopPropagation()` on `click`.** Solid (and other frameworks) delegate `click` to
  `document`; stopping it kills their `onClick`. Only stop propagation on
  `pointerdown`/`pointerup` (what tldraw uses).
- **No `undefined` in automerge.** Use `delete d.x` (inside `change`) or `null`.
- **`repo.find` returns a Promise** that resolves to a ready handle — no `whenReady()`.
  `repo.create` is synchronous.
- **Tool ids are referenced from docs.** Anywhere a `toolId` is recorded (openDocument calls,
  doc links/embeds pinning a tool) it must exactly match the registered tool `id`, and
  renaming an id breaks existing references. See the `id` rule in section 2.
- **The `plugins` entry module runs in a worker and each entry is `structuredClone`d.** So a
  plugin may carry only serializable metadata at the top level — **all functions/behaviour go
  behind `async load()`** (the host strips `load` before cloning; any other top-level function
  throws `DataCloneError`). And **no bare external imports in that module's static graph** (the
  worker has no importmap) — keep them inside `load()`'s dynamic `import()`. See section 2.
- **Always return a cleanup function** from the render function and actually tear down
  (listeners, roots, intervals, rAF, AudioContext, workers).
- **New tools: default to Solid + TypeScript with a vite bundle** (`solid-js/html` bundleless
  for tiny tools); if the user asks for a specific framework (React, Svelte, …), use that one.
  Existing tools may be vanilla/React/Solid — match the existing tool's style when editing
  one.

## 14. Minimal complete example (bundleless Solid)

Two files: a thin entry (parsed in the worker — metadata and `load()`s only, no external
imports) and the implementation (loaded on the main thread, where the importmap provides
`solid-js`).

```js
// index.js  →  package.json: { "type": "module", "main": "index.js" }
export const plugins = [
  {
    type: "patchwork:datatype",
    id: "counter",
    name: "Counter",
    icon: "Hash",
    async load() {
      return (await import("./counter.js")).CounterDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "counter",
    name: "Counter",
    icon: "Hash",
    supportedDatatypes: ["counter"],
    async load() {
      return (await import("./counter.js")).default;
    },
  },
];
```

```js
// counter.js — datatype + tool
import { render } from "solid-js/web";
import html from "solid-js/html";
import { createSignal } from "solid-js";

export const CounterDatatype = {
  init(doc) {
    doc.title = "Counter";
    doc.count = 0;
  },
  getTitle(doc) {
    return doc.title || "Counter";
  },
  setTitle(doc, t) {
    doc.title = t;
  },
  markCopy(doc) {
    doc.title = "Copy of " + this.getTitle(doc);
  },
};

export default function CounterTool(handle, element) {
  const [doc, setDoc] = createSignal(handle.doc());
  const onChange = () => setDoc(handle.doc());
  handle.on("change", onChange);

  const style = document.createElement("style");
  style.textContent = `.my-counter button {
    font: 600 2rem var(--editor-family-sans, system-ui, sans-serif);
    padding: 0.5rem 1rem;
  }`;
  element.append(style);

  const dispose = render(
    () =>
      html`<div class="my-counter">
        <button onClick=${() => handle.change((d) => d.count++)}>
          count: ${() => doc().count}
        </button>
      </div>`,
    element,
  );

  return () => {
    handle.off("change", onChange);
    dispose();
    style.remove();
  };
}
```

Then from the tool's directory: `npx pushwork@latest init .` (first time only), `npx pushwork@latest sync`, and
register it against the module-settings doc (section 12 "First run"). Done.

## 15. Reference examples — the bundled checkouts

The best documentation is real tools. The installer ships checkouts of two repos with this
skill, next to this SKILL.md:

- **`reference/patchwork-base/`** —
  [patchwork-pkg-base](https://github.com/inkandswitch/patchwork-pkg-base), the polished core
  tools. This is the place to look for **utility tools you can reuse** instead of rebuilding:
  folder-shaped data (`folder`), embedding documents (`embed`), collaborative text editing
  (`codemirror-base`), files (`file`), and more.
- **`reference/patchwork-experiments/`** —
  [patchwork-experiments](https://github.com/inkandswitch/patchwork-experiments), a wide
  corpus of **reference examples**: many more tools showing many more patterns. These are
  experimental and unsupported — read them for their patterns, but never depend on them;
  only patchwork-base tools are safe to depend on.

Before building a new tool, read one or two tools that solve a similar problem and copy
their patterns. **Which tools to read:** open `AGENTS.md` at each checkout root — it's
maintained alongside the tools and indexes the good reference examples and reusable
building blocks in that repo.

(Exception: if you are already working inside a checkout of one of these repos, use that
directly; it's fresher. Don't go hunting for checkouts anywhere else on disk.)

The checkouts are for **reading**, not building or running — don't install their
dependencies.

Prefer reading these sources over improvising research — don't reconstruct APIs from memory
or from npm tarballs when a real, working tool in a checkout already demonstrates the
pattern.
