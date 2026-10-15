# View State

Where the tools keep how a model is looked at: per user, what the editor and the viewer remember about how a user last looked at a model, and per view document, a camera that everyone shares. Implementation: [`uiState.ts`](../src/cad/src/components/uiState.ts), [`viewer.tsx`](../src/cad/src/tools/viewer.tsx); tests: [`cad-ui-state.spec.ts`](../src/harness/e2e/tests/cad-ui-state.spec.ts), [`cad-view-doc.spec.ts`](../src/harness/e2e/tests/cad-view-doc.spec.ts).

## Storage

UI state belongs to one user, not to the model: one collaborator opening the code pane must not open it for everyone, and the model doc stays the portable model ([02](02-model-storage.md#design-goal-portable-models)). It should still follow the user across devices, which rules out `localStorage`.

The account doc is the place for that, but tools don't get its handle anymore. Patchwork 0.3.0 ([CHANGELOG](../src/harness/node_modules/@inkandswitch/patchwork/CHANGELOG.md)): "stop exposing the account handle as `window.accountDocHandle`". The `writing-patchwork-tools` skill still documents `window.accountDocHandle`. Instead, the frame answers `patchwork:tool-storage` subscriptions ([`ToolStorageProvider.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/providers/src/ToolStorageProvider.ts)) with "a private, per-tool doc scoped to the current account — created lazily on first request and remembered under `accountDoc.toolStorage[toolId]`". threepane and the tiling frame mount this provider, and so does the harness, which runs threepane.

Both tools subscribe with the tool-storage id `patchwork-cad`, so they share one doc ([`UiStorageDoc`](../src/cad/src/types.ts)), keyed by model URL:

```ts
{ docs: { [modelUrl]: { codeOpen?: boolean; views?: { [toolId]: CameraState } } } }
```

The editor remembers whether the code pane was open. Without a provider, e.g. outside Patchwork, the state is kept in memory only.

## Camera

Each tool remembers the camera it last showed a model with ([`CameraState`](../src/cad/src/types.ts): direction, orbit target, distance, projection, orthographic zoom), written after an orbit, a ViewCube turn, Home or a projection switch, not per frame. A stored camera counts as framed, so a build only reframes the model if it doesn't fit ([07](07-poc-modelling-ui.md#the-viewcube)). A tool applies the stored camera when it mounts, not when the stored one changes later, so that two views of one model in the same tool don't move each other.

The numbers are rounded to 9 decimals, because Automerge 3.4.1 stores `0.9999999999999999` (the largest double below 1, e.g. the x of a direction along +X) as `0` in a list, while a map field keeps it, and so does `1.9999999999999998`; wrapping it in `Float64` doesn't help. A direction of `[0.9999999999999999, -3e-16, 6e-17]` came back as almost the zero vector, which the next device normalised into an arbitrary direction. [`automerge-floats.test.ts`](../src/cad/test/automerge-floats.test.ts) fails once Automerge fixes this.

## Instance identity

The camera is per user, model and tool, not per tool instance, because a tool can't tell its instances apart. Patchwork mounts a tool with the document handle and a fresh content element only ([`legacy-impl.ts`](../node_modules/.pnpm/@inkandswitch+patchwork-elements@6.0.3_@automerge+automerge-repo@2.6.0-subduction.48_@i_9d33da6ea60b875700fada3a96960a72/node_modules/@inkandswitch/patchwork-elements/src/legacy-impl.ts): `this.#tool.module(this.#handle, this.#content as ToolElement)`), and `<patchwork-view>` observes no attribute that names an instance (`patchwork-view.ts`: `return [ATTRS.component, ATTRS.url, ATTRS.docUrl, ATTRS.toolId];`). The tiling frame keys a panel's view by its leaf, but only for React: `<patchwork-view key={leaf.id} className="tile-panel__view" doc-url={resolvedUrl} tool-id={effectiveToolId} />` ([`PatchworkFrame.tsx`](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/patchwork-frame-tiling/src/PatchworkFrame.tsx)). So two panels of one model in the viewer share one stored camera: whichever moved last decides the camera of both on the next mount.

A tool could guess an instance from its position in the DOM (the chain of enclosing views, its index among views of the same document and tool), but closing, reordering or moving panels would shift those keys. Views that need their own camera, e.g. an embedding or several viewers in a tiled layout, get it from a view document instead.

## View documents

A `cad-model-view` document ([`CadModelViewDoc`](../src/cad/src/types.ts)) holds a title, the model's URL and a camera. The datatype is unlisted, as it can't be created without a model, and only the viewer opens it.

- **Creating one:** dragging a ViewCube region out of either tool creates a view of the model from that region, with the current target, distance and projection, titled e.g. "CAD Model – Front Right Top". The drag carries Patchwork's document payload (`text/x-patchwork-urls`, `text/x-patchwork-dnd`, `text/plain`, as the pandoc tool's); the spec drops it into the sidebar's document list, other drop targets are untested. It must allow every drop effect: the list sets `dropEffect = "move"` (sideboard: `"all" keeps move/copy dropEffects … valid so the drop event actually fires`). So a click on the cube turns the view, a drag creates a view; the cube can't be dragged to orbit.
- **Viewing one:** the viewer shows the model with the document's camera. Orbiting is local; "Save view" writes the current camera to the document, and other open views of it follow. "Open model" opens the model.
- **Open:** the document is created when the drag starts, so a cancelled drag leaves an orphan view. Where views are listed, and how to rename one or point it at another model, is to be discussed.
