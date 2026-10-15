# View State

Where the tools keep per-user UI state: what the editor and the viewer remember about how a user last looked at a model. Implementation: [`uiState.ts`](../src/cad/src/components/uiState.ts); test: [`cad-ui-state.spec.ts`](../src/harness/e2e/tests/cad-ui-state.spec.ts).

## Storage

UI state belongs to one user, not to the model: one collaborator opening the code pane must not open it for everyone, and the model doc stays the portable model ([02](02-model-storage.md#design-goal-portable-models)). It should still follow the user across devices, which rules out `localStorage`.

The account doc is the place for that, but tools don't get its handle anymore. Patchwork 0.3.0 ([CHANGELOG](../src/harness/node_modules/@inkandswitch/patchwork/CHANGELOG.md)): "stop exposing the account handle as `window.accountDocHandle`". The `writing-patchwork-tools` skill still documents `window.accountDocHandle`. Instead, the frame answers `patchwork:tool-storage` subscriptions ([`ToolStorageProvider.ts`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/providers/src/ToolStorageProvider.ts)) with "a private, per-tool doc scoped to the current account — created lazily on first request and remembered under `accountDoc.toolStorage[toolId]`". threepane and the tiling frame mount this provider, and so does the harness, which runs threepane.

Both tools subscribe with the tool-storage id `patchwork-cad`, so they share one doc ([`UiStorageDoc`](../src/cad/src/types.ts)), keyed by model URL:

```ts
{ docs: { [modelUrl]: { codeOpen?: boolean } } }
```

The editor remembers whether the code pane was open. Without a provider, e.g. outside Patchwork, the state is kept in memory only.
