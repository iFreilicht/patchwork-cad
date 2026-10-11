# Model Storage

How models are stored, addressing [risk 2 in the review](01-basic-idea-and-literature.md#problems-and-risks).

## Decision: the model is code

A model is stored as one collaborative code text in an automerge document. Every view is derived from that text.

- **Character-level merges are acceptable.** They only produce invalid code when people edit the same spot at the same time. The result is visible and can be fixed, like a git conflict.
- **GUI edits work because the API has a fixed shape.** Each built-in feature is one function call in a flat sequence, e.g. `const f3 = extrude({ sketch: f1, distance: width / 2 })`. A GUI edit finds the call and replaces only the source span of the changed argument. Such a minimal splice merges well with concurrent typing and keeps comments and formatting.
- **AST vs. plain text editing is deferred** until implementation, when we can compare the two in practice. Parsing the text to an AST and splicing node spans back into it is the expected approach. Storing the AST itself in automerge is ruled out, because it would make typing code the hard part.

## The timeline is a view

The WYSIWYG timeline is derived from the text and never owns any state. Any code the parser does not recognize as a feature call, such as a loop around a feature, becomes a "Custom Script" entry. Such an entry spans everything up to the next recognizable feature. In the worst case the whole timeline collapses into one Custom Script. An explicit "eject" step is therefore not needed. This follows Patchwork's Raw Editor philosophy: any edit is allowed, but there is no guarantee that it leads to a valid result. The UX for heavily collapsed timelines still needs a mechanism.

## Consequences

- **Parameters are JS expressions** (`width / 2`), so no separate expression evaluator is needed. Still open: which names an expression may refer to (only global parameters, or anything in scope).
- **Order is text order.** Moving a feature means cutting and pasting text, so two people moving the same feature at once can duplicate it. This is accepted.
- **Sandboxing is a day-one requirement**, because opening a model executes its code.
- **Features need a stable identity across re-parses**, so that open dialogs and selections survive concurrent edits elsewhere in the text. Candidates are the variable name or an automerge cursor anchored in the text.
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

- **Recognizing a call is syntactic:** `const x = someName({ … })` with `someName` imported. Rendering its form needs the schema, so the module is loaded inside the sandbox. If loading fails, the call is shown as a Custom Script.
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

The openscad-style drag-and-drop can remain as UX that inserts an import line. Still to verify: whether the sandbox (e.g. a worker) can resolve these service-worker URLs, and whether the service worker accepts URLs with heads.

## Open

- The shape of feature references (edges, faces): [03-topological-naming.md](03-topological-naming.md#recommendation) recommends history-based names rooted in feature variables and sketch segment ids, written as expressions like `edge(f1.end, f1.side.front).piece(notch, 1)`. Not yet decided.
