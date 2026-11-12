# Model Storage

How models are stored, addressing [risk 2 in the review](01-basic-idea-and-literature.md#problems-and-risks).

## Design goal: portable models

No walled garden and no DSL: a thin library and a feature-rich editor. A model file is plain JS that runs without our tool, given only the feature library. Editor conveniences, such as injecting feature names before execution, happen in memory and never change the stored file. The library must not depend on them; they may only improve things like error messages. Depending on modules loaded from `automerge:` URLs is the model author's choice; the same modules can be loaded from anywhere else.

## Decision: the model is code

A model is stored as one collaborative code text in an automerge document. Every view is derived from that text.

- **Character-level merges are acceptable.** They only produce invalid code when people edit the same spot at the same time. The result is visible and can be fixed, like a git conflict.
- **GUI edits work because the API has a fixed shape.** Each built-in feature is one function call in a flat sequence, e.g. `const extrude1 = extrude({ sketch: sketch1, distance: width / 2 })`. A GUI edit finds the call and replaces only the source span of the changed argument. Such a minimal splice merges well with concurrent typing and keeps comments and formatting.
- **Edits read the AST and write text.** The editor parses the text to an AST and splices only the changed node's span back into it; this keeps concurrent edits and formatting intact, while printing the program from the AST does not ([07](07-poc-modelling-ui.md#text-vs-ast-editing)). Storing the AST itself in automerge is ruled out, because it would make typing code the hard part.

## The timeline is a view

The WYSIWYG timeline is derived from the text and never owns any state. Any code the parser does not recognize as a feature call, such as a loop around a feature, becomes a "Custom Script" entry. Such an entry spans everything up to the next recognizable feature. In the worst case the whole timeline collapses into one Custom Script. An explicit "eject" step is therefore not needed. This follows Patchwork's Raw Editor philosophy: any edit is allowed, but there is no guarantee that it leads to a valid result. A Custom Script entry lists the feature calls the last build ran inside it ([07](07-poc-modelling-ui.md#collapsed-timelines)).

## Consequences

- **Parameters are JS expressions** (`width / 2`), so no separate expression evaluator is needed. Still open: which names an expression may refer to (only global parameters, or anything in scope).
- **Order is text order.** Moving a feature means cutting and pasting text, so two people moving the same feature at once can duplicate it. This is accepted.
- **Sandboxing is a day-one requirement**, because opening a model executes its code.
- **Features need a stable identity across re-parses**, so that open dialogs and selections survive concurrent edits elsewhere in the text: an automerge cursor anchored at the call, with the variable name as a fallback ([07](07-poc-modelling-ui.md#feature-identity-across-re-parses)).
- **The timeline must show references into unrecognized regions,** e.g. a fillet that refers to a variable defined inside a loop.

## Feature types

Built-in and user-defined feature types use the same mechanism. A feature type is a function wrapped together with a parameter schema and metadata such as its UI icon, comparable to a React function component:

```ts
export const extrude = defineFeature({
  icon: "extrude",
  params: { sketch: sketchRef(), distance: length() },
  build: ({ sketch, distance }) => …,
});
```

Onshape does the same: "The feature types in Onshape's default toolbar (like extrude and helix) are defined as functions in the Onshape Standard Library" ([FeatureScript intro](https://cad.onshape.com/FsDoc/intro.html)). The built-ins are therefore just a standard-library document.

- **Recognizing a call is syntactic:** `const x = someName({ … })` with `someName` imported. Rendering its form needs the schema. The built-ins' schemas are a kernel-free module the editor imports ([07](07-poc-modelling-ui.md#the-feature-library)); a user-defined feature's module would be loaded inside the sandbox. If loading fails, the call is shown as a Custom Script.
- **JSX is not used.** Features refer to each other by variable, forming a graph rather than a tree. Sketches and assemblies are nested and could revisit this later.

### Versioning

A model imports a feature type either **pinned** to a specific revision (the default, with an explicit "update" action) or **following a branch**, so that changes arrive reactively. Following a branch can break the model's geometry, but it is useful for prototyping and testing. Onshape has the same two modes: imports into the same workspace "will update automatically when the imported tab is changed", while imports from other documents are pinned, and "you can click the link icon to update to the latest version" ([FeatureScript imports](https://cad.onshape.com/FsDoc/imports.html)).

### Imports: prior art

**Patchwork already serves documents as ES modules.** Tools import modules from other documents through service-worker URLs of the form `/${encodeURIComponent(automergeUrl)}/<path>` ([sequencer](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/sequencer/src/components/SequencerGrid.tsx), [page-extractor card](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/cards/cards/page-extractor/src/card.tsx)): "The service-worker path a package-relative module is importable at".

**Pinned document dependencies exist.** [`call/package.json`](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/call/package.json) declares `"@chee/patchwork-transcript": "automerge:2AdvAyQ85NfazBA4TtDyRYCqfvYb#RUCq…"`, i.e. a document URL plus heads. Its build plugin "Rewrites `automerge:`-versioned deps … to a shared service-worker URL" ([options.js](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/call/esbuild/options.js)). So the same URL format can express both modes: without heads for following a branch, with `#heads` for pinning.

**Imports declared outside the code:** the [openscad tool](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/openscad/README.md) keeps a list of dragged-in documents in `doc.imports` and prepends a generated line, `<name> = import("imports/<name>.json");`, to the source before compiling. This was needed because OpenSCAD code cannot load documents itself. The tradeoff it reports: "reported error/warning line numbers are off by exactly one".

**Code stored in Automerge, other Ink & Switch work:**
- [Livelymerge](https://www.inkandswitch.com/livelymerge/notebook/lm-01/) represents a live system's "entire state — classes, methods, objects, and all — as an Automerge document". Its note ["Convergence Is Not Enough"](https://www.inkandswitch.com/livelymerge/notebook/lm-02/) confirms the merge caveat from the review: "replaying B's _writes_ after A's is not the same as performing B's _intent_ after A's."
- The [Tenfold Playground](https://www.inkandswitch.com/project/tenfold/playground/) syncs unsandboxed JS through Automerge and names the resulting risk: an infinite loop "would sync to everyone".

- [Hazel](https://hazel.org/) "is a live functional programming environment that is able to typecheck, manipulate, and even run incomplete programs, i.e. programs with holes", and "There are no meaningless editor states." It has been integrated into Patchwork in unpublished experiments, shown briefly in [this talk](https://www.youtube.com/watch?v=4UxGijnuXEs). Its idea of evaluating programs with holes is relevant to keeping models usable after invalid merges or edits.

Apart from Hazel, I found no Patchwork project that defines a new language with document imports. `geolog` in patchwork-experiments implements an existing language, and the `embed` package embeds views rather than code.

### Verdict: imports in code

Use imports directly in the code, e.g. `import { gear } from "automerge:<id>#<heads>"`:
- It is how Patchwork tools already consume other documents (service-worker URLs, `automerge:` dependencies).
- Onshape's FeatureScript also imports in code, with the version as part of the import.
- It keeps the code self-contained, which fits "the model is code".

The openscad-style drag-and-drop can remain as UX that inserts an import line. The service worker accepts URLs with heads, and redirects one without heads to the document's current heads (`Response.redirect(location, 307)`, [`automerge-protocol-handler-worker.js`](../node_modules/.pnpm/@inkandswitch+patchwork-bootloader@0.8.4_@automerge+automerge-repo-keyhive@0.6.0-alpha._3df521e76561f6a9ee47cd61d96bee70/node_modules/@inkandswitch/patchwork-bootloader/dist/automerge-protocol-handler-worker.js)); it serves a document's `content` as a file and any other document as JSON ([17](17-parameters.md#building-blocks)). Still to verify: whether the sandbox (e.g. a worker) can resolve these service-worker URLs.

### Imports in the prototype

Models import data documents, JS files and any file as text or bytes by their URL; models themselves, and the sandbox ([05](05-sandboxing.md)), are left for later ([`imports.test.ts`](../src/cad/test/imports.test.ts), [`cad-imports.spec.ts`](../src/harness/e2e/tests/cad-imports.spec.ts)). The editor lists the imported documents and edits their imports ([21](21-embedding.md#the-documents-list)):

```js
import { hole_diameter } from "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG";              // follows the document
import { width } from "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG#<heads>";               // pinned to a version
import settings from "automerge:2owYJFe8TQ9krQHCDVJgKfVXggLG/settings/screws";        // a value inside a document
import logo from "automerge:3RtmWqXcDkz8hPvN5sYbJ7uELfAa" with { type: "text" };     // a file's text
```

- **The tool reads the documents, not the service worker.** It finds each URL once with `repo.find`, which also resolves heads and paths ([17](17-parameters.md#building-blocks)); the handle keeps the document in memory as changes sync in, and the tool makes a module of it again only when its heads changed. So it knows when one changes: a URL without heads follows its document, and a change rebuilds the model, unless the new version breaks it, which its lock holds back ([21](21-embedding.md#following-and-pinning)); one with heads never changes. It sends what it read to the kernel worker, which makes a blob-URL module of each and puts that URL in place of the specifier, so every line of the model stays where it was ([`components/imports.ts`](../src/cad/src/components/imports.ts), [`kernel/imports.ts`](../src/cad/src/kernel/imports.ts), [`prepare.ts`](../src/cad/src/kernel/prepare.ts)). Whether the worker could fetch service-worker URLs itself didn't need answering.
- **What a document is, as the service worker has it:** without an attribute, a file document (`content`) of JS is code, which may itself import replicad, the feature library and other documents, one of JSON is its parsed data, and any other file is an import error that names the attributes that import it; a CAD model is refused for now; any other document, or the value a path names, is data as JSON has it. A file's kind comes from its `mimeType`, or its extension where the type is generic, and text from UTF-8 bytes, so files uploaded through the sidebar import too. `with { type: "text" }` and `with { type: "bytes" }` give any file's text or bytes ([21](21-embedding.md#files-as-modules)).
- **Data is a module of its keys:** the whole value is the default export, and each key a named export, as a string name if it isn't an identifier (`import { "hole-depth" as depth } from …`). Imported `with { type: "json" }`, it is a browser's JSON module, with only the default export.
- **Errors point at the model:** a document that can't be loaded or isn't importable is an import error on the line of its import, naming the document; an error thrown in an imported module is on the line of the model that called it. A cycle of imports is an import error.
- **A model without imports costs nothing extra:** without `automerge:` in its code, nothing is parsed or read, and without locks nothing is compared or written. Edit-to-result times were the same as before imports existed, within a few milliseconds of noise (Chromium about 22 ms, Firefox about 50 ms for the seed model).
- **An imported module is evaluated once per content:** its blob URL is kept by its code, so a document that didn't change isn't evaluated again in the next build; an edited one is a new module. A bytes module's code names the document's version, by which the worker keeps its bytes.
- **Feature calls in an imported JS file aren't named,** so their bodies and faces don't show as features of their own in the timeline, and references into them aren't stable.
- **Portable only within the Automerge network:** an `automerge:` URL resolves only where its document can be synced. Exporting such a model needs the imported documents written out next to it, with the specifiers mapped to them, e.g. by an import map.

## Open

- The shape of feature references (edges, faces): [03-topological-naming.md](03-topological-naming.md#recommendation) recommends history-based names rooted in feature variables and sketch segment ids, cross-checked by geometry and written as JS expressions like `edge(f1.end, f1.side.front).piece(notch, 1)`. [PoC 2](07-poc-modelling-ui.md#the-reference-syntax) prototypes them; adopting them for the product is not decided yet.
