---
name: setting-up-automerge-repo
description: >-
  Set up an automerge-repo outside of Patchwork — for standalone scripts, CLI
  tools, tests, servers, or apps that need to sync with the Patchwork
  ecosystem via Subduction. Covers the subduction fork of automerge-repo and
  how to pin its versions, creating a Repo with subductionWebsocketEndpoints,
  wasm initialization order in Node and the browser, storage adapters,
  waiting for confirmed server sync before exiting (getSyncInfo /
  containsHeads, push confirmation, resync nudges), bounded flush/shutdown
  for short-lived scripts, and the subduction-specific Repo surface
  (connection state, remote heads, resync). Not needed inside a Patchwork
  tool, where the host provides window.repo.
---

# Setting up an automerge-repo (outside Patchwork)

Inside a Patchwork tool you never create a `Repo` — the host provides `window.repo`. This
skill is for everything _outside_ that: a Node script that reads or migrates documents, a
test suite, a server-side integration, or a standalone app that syncs with the same
documents Patchwork uses.

## 1. The packages — this is a fork, pin it

Ink & Switch runs a **subduction fork of automerge-repo**, published to npm as prerelease
versions like `2.6.0-subduction.46`. Subduction is the sync protocol/server the Patchwork
ecosystem uses (default public server: `wss://subduction.sync.inkandswitch.com`), and it is
built directly into this fork's `Repo` — there is no separate subduction network adapter to
install.

Pin exact versions, and pin them _together_ — the repo package and every
`@automerge/automerge-repo-*` adapter must be the same `-subduction.N` build, or you get
two copies of automerge and baffling errors. Check pushwork's `package.json` for a
currently working set; at the time of writing:

```jsonc
{
  "@automerge/automerge": "3.3.2",
  "@automerge/automerge-repo": "2.6.0-subduction.46",
  "@automerge/automerge-repo-storage-nodefs": "2.6.0-subduction.46", // Node
  "@automerge/automerge-repo-storage-indexeddb": "2.6.0-subduction.46", // browser
  "@automerge/automerge-subduction": "0.16.0",
}
```

Add these as `overrides` in `package.json` so no transitive dependency drags in the
upstream (non-subduction) automerge-repo alongside the fork.

## 2. The simple case: a Node script

```ts
import {
  Repo,
  initSubduction,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";

await initSubduction(); // initialize the subduction wasm BEFORE constructing a Repo

const repo = new Repo({
  storage: new NodeFSStorageAdapter("./automerge-repo-data"),
  subductionWebsocketEndpoints: ["wss://subduction.sync.inkandswitch.com"],
});

await repo.networkSubsystem.whenReady();

const handle = await repo.find<MyDoc>("automerge:..." as AutomergeUrl);
console.log(handle.doc());
handle.change((d) => {
  d.lastSyncAt = Date.now();
});

const fresh = repo.create<MyDoc>({ title: "new doc" });
console.log(fresh.url);
```

**⚠ Wasm initialization order.** The fork's `Repo` imports from
`@automerge/automerge-subduction/slim` internally, and the slim entry assumes the wasm is
already initialized — so subduction wasm init must happen **before** the `Repo` is
constructed. `await initSubduction()` (re-exported by `@automerge/automerge-repo`, used by
pushwork) is the cleanest way. A side-effect import of the fat entry
(`import "@automerge/automerge-subduction"`) also works, as long as it runs first. If you
see errors about wasm not being initialized, this ordering is almost always the cause.

For scripts that only _read_, storage is optional — a `Repo` with just
`subductionWebsocketEndpoints` works, it just refetches everything each run. For Node,
`@automerge/automerge-repo-storage-lmdb` (a single-file transactional LMDB database, what
pushwork uses) is an alternative to `NodeFSStorageAdapter`'s chunk-file tree.

## 3. Waiting for sync, and shutting down

`repo.find()` resolving tells you a document arrived; it does **not** tell you your local
changes reached the server. A short-lived script that writes and exits immediately can
lose its push. Pushwork's `src/repo.ts` is the reference implementation for doing this
properly (`waitForConnection`, `waitForSync`, `waitForServerSync`, `safeShutdown`) — copy
from it. The patterns, simplest first:

**Wait for the connection** before judging anything sync-related — bounded, because a
dead network would otherwise hang you:

```ts
if (!repo.isSubductionConnected()) {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 15_000); // give up, check state later
    repo.on("subduction-connection", ({ connected }) => {
      if (connected) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}
```

**Local settle (good enough for reads / low stakes):** poll `handle.heads()` until it
stops changing for an idle window (~1.5s), with a hard deadline (~15s). This only proves
things went _quiet_, not that the server has your changes.

**Confirmed server sync (what `pushwork sync` does before printing SYNCED):** judge
against the server's advertised heads, in both directions:

```ts
const [serverPeerId] = await repo.connectedSubductionPeerIds();
const info = handle.getSyncInfo(serverPeerId); // { lastHeads } — what the server advertises

const pullComplete = handle.containsHeads(info.lastHeads); // nothing left to fetch
const advertised = new Set(info.lastHeads);
const pushConfirmed = handle.heads().every((h) => advertised.has(h)); // server echoed our frontier
```

Poll this (waking early on the `subduction-remote-heads` event) until
`pullComplete && pushConfirmed` _and_ local heads have been quiet for the idle window —
or a deadline passes. **⚠ Never compare the advertised heads to `handle.heads()` for
equality**: the server advertises subduction _sedimentree_ heads (loose-commit and
fragment-boundary ids), not the Automerge frontier — the sets never match; only the
containment checks above are meaningful. (Push confirmation can also false-negative
when the server compacts your change into a differently-id'd fragment — treat
"pull-complete but not push-confirmed" as _pending_, not failure.) If a doc stays behind
for more than a few seconds, nudge it once with `repo.resyncSubduction(handle.documentId)`
and keep waiting.

**Shutdown.** `repo.shutdown()` runs its own ~5s quiesce for last-mile delivery, but a
stuck connection can stall it far longer — bound it, then exit explicitly, because
subduction can leave its TLS websocket open and the process would otherwise hang:

```ts
await repo.flush();
await Promise.race([
  repo.shutdown().catch(() => {}), // teardown errors: work is already done
  new Promise((r) => setTimeout(r, 15_000)),
]);
process.exit(0); // required: a lingering wss socket keeps the event loop alive
```

## 4. In the browser (without the Patchwork service worker)

Same shape, two differences: storage is IndexedDB, and you may need to initialize the wasm
yourself. If your bundler handles wasm imports (vite with `vite-plugin-wasm`, webpack with
`asyncWebAssembly`), the fat entry points work as in Node. Otherwise use the `/slim`
entries and feed them the wasm bytes:

```ts
import { initializeWasm } from "@automerge/automerge/slim";
import { initSync as initSubductionSync } from "@automerge/automerge-subduction/slim";
import { Repo } from "@automerge/automerge-repo/slim";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

const [automergeWasm, subductionWasm] = await Promise.all([
  fetch("/automerge.wasm").then((r) => r.bytes()),
  fetch("/subduction.wasm").then((r) => r.bytes()),
]);
await initializeWasm(automergeWasm);
initSubductionSync(subductionWasm);

const repo = new Repo({
  storage: new IndexedDBStorageAdapter(),
  subductionWebsocketEndpoints: ["wss://subduction.sync.inkandswitch.com"],
});
```

(You have to ship the two `.wasm` files as static assets for that fetch to work —
`@automerge/automerge-subduction/wasm` resolves to the subduction one in node_modules.)

Inside a Web/Shared Worker, use `IndexedDBWorkerStorageAdapter` (imported from
`@automerge/automerge-repo-storage-indexeddb/IndexedDBWorkerStorageAdapter`) instead of the
plain adapter.

## 5. Repo options worth knowing

All optional — the defaults are fine for a simple integration:

- `peerId` — a readable id for this peer (`"my-script-" + crypto.randomUUID()`); helps a
  lot when debugging sync.
- `sharePolicy: async (peerId) => boolean` — which peers this repo _announces_ its
  documents to. Default is share-with-everyone; restrict it if your repo holds documents
  that shouldn't be advertised to arbitrary peers.
- `signer` — a signing identity for the subduction wire (`MemorySigner` for throwaway,
  `await WebCryptoSigner.setup()` for a WebCrypto-backed one, both from
  `@automerge/automerge-subduction/slim`). The Repo creates one internally by default,
  and that's all you need. This signing-identity infrastructure exists for **keyhive**,
  Ink & Switch's upcoming access-control/encryption layer — it hasn't landed in Patchwork
  yet, so today a custom signer only matters if you want to display the peer's
  `peerId()`/`verifyingKey()` for debugging.
- `enableRemoteHeadsGossiping: true` — peers relay each other's heads; needed if you want
  the sync-state events below to see server heads through intermediate hops.
- Classic (non-subduction) sync servers still work: construct a `WebSocketClientAdapter`
  from `@automerge/automerge-repo-network-websocket` and pass it in `network: [...]` (or
  add later with `repo.networkSubsystem.addNetworkAdapter(...)`). You can run both at
  once.

## 6. Subduction-specific Repo surface

The fork adds a few members for observing and nudging sync:

```ts
repo.isSubductionConnected()                 // boolean, right now
repo.on("subduction-connection", ({ connected }) => { ... })
await repo.connectedSubductionPeerIds()      // the sync server peers you're talking to
repo.on("subduction-remote-heads", ({ documentId, storageId, heads, timestamp }) => { ... })
repo.resyncSubduction(documentId)            // force a re-sync of one document
handle.getSyncInfo(peerId)                   // { lastHeads } that peer last advertised for this doc
```

**⚠ Careful with `subduction-remote-heads`:** the heads the server advertises are
subduction _sedimentree_ heads (loose-commit and fragment-boundary ids), **not** the
Automerge frontier. Never compare them for equality against `handle.heads()`. To ask "am I
caught up?", use `handle.containsHeads(serverHeads)` — do I already hold every commit the
server advertises?
