# Sandboxing Model Code

> [!WARNING]
> **In progress.** The [test harness](#test-harness) is done; the sandbox runner has not been prototyped or measured yet.

Opening a model executes its code ([02](02-model-storage.md#consequences)). That code is document content: written or merged by any collaborator, and executed automatically for everyone who opens the model, including read-only viewers and embeds. It must therefore run sandboxed ([review, risk 3](01-basic-idea-and-literature.md#problems-and-risks)).

## Threat model

The attacker is anyone who can edit a model or get a user to open one. Model code must not be able to:

- **access documents** the user did not hand to the model, e.g. through our tool's repo access
- **exfiltrate data** to the network. Network access exists only through explicit user choices, such as embedding another document or enhancing a document with Patchwork cards, and then only to what the user chose.
- **break the editor**, e.g. by freezing the UI with an infinite loop or exhausting memory

Outside our tool, e.g. when a model file is run directly ([portable models](02-model-storage.md#design-goal-portable-models)), there is no sandbox; that is like running any other script.

## Prior art

Patchwork's [`isolation`](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/isolation/ISOLATION.md) package isolates third-party *tools*. Its design is directly reusable:
- **Opaque origin:** tool code runs in "an `<iframe sandbox="allow-scripts">` without `allow-same-origin`", which "prevents it from accessing the host's DOM, cookies, localStorage, IndexedDB, or service workers".
- **Imports:** every module import goes through an es-module-shims source hook that asks the host via RPC, and the host only serves allowlisted modules.
- **Workers:** tools can still spawn workers inside the boundary, without gaining any new authority.

It differs from our needs:
- **Exfiltration is out of scope there:** "Preventing data exfiltration (sending data to external servers)" is explicitly excluded.
- **Different attacker:** it targets tool authors, whose code users choose to install, not document content.
- **Unaudited:** its own pending work starts with "Security audits. Run this implementation through security review and adversarial testing."

Our tool may itself run inside that boundary while holding access to the model and its imports, so model code needs a second boundary of its own.

## Approach

1. **Test harness:** real browsers (Chromium, Firefox, WebKit) driving a local Patchwork instance against a local sync server, with a recorder for every network request that leaves the browser. This harness is also the base for later multi-user and tool tests. Done, see [below](#test-harness).
2. **Sandbox runner prototype:** model code and OCCT together in a worker inside an opaque-origin iframe. OCCT has to be inside, because replicad calls the kernel far too often for each call to cross the boundary. Network access is locked down with a Content-Security-Policy, and imports are resolved by our tool through a host-side loader, as in Patchwork's isolation.
3. **Measurements and tests:**
   - **Escapes:** attack scripts try network access (fetch, image beacons, WebSockets, `sendBeacon`, WebRTC), storage, reaching the parent page, navigating the top window, popups, and nested frames or workers. Each must fail in every browser, verified against the request recorder rather than against what the sandbox claims to block.
   - **Denial of service:** infinite loops and memory bombs; time until the worker is killed, and main-thread responsiveness meanwhile. The watchdog must tell a stuck script from a slow kernel operation.
   - **OCCT load cost:** the opaque origin has no Cache API or IndexedDB, and a compiled `WebAssembly.Module` probably can't be passed into it. Measure cold and warm load times and whether compiled wasm can be reused.
   - **Multi-threaded OCCT:** whether its cross-origin-isolation requirement can be met inside the sandbox.
   - **Determinism:** whether `Math.random`, `Date` etc. must be made deterministic so that all collaborators compute the same geometry.
   - **End to end:** M1 from the [naming prototype](03-topological-naming/prototype/) running in the sandbox, with an `automerge:` import resolved through the loader, and meshes and selection data passed out efficiently.

   Every failure is explained before it counts as a result, as in 03.

## Test harness

[src/harness/](../src/harness/) runs Chromium, Firefox and WebKit (Playwright 1.59.1, browsers from Patchwork's nixpkgs) against a local copy of the Patchwork site and a local `subduction_cli`, with fresh storage per worker. Its self-tests pass in all three browsers, 150 of 150 runs over ten repetitions: full UI boot, a markdown doc synced between two profiles, concurrent edits converging, and a module published with pushwork that installs, renders and syncs. During every run, nothing tried to leave the machine.

### Local-only Patchwork

- **Modules:** the current site serves the base modules same-origin from the npm package `@inkandswitch/patchwork-pkg-base` (`packageListURL: "/modules.json"`). No module bundle or default-modules document comes from the network anymore, which outdates [patchwork-e2e](https://github.com/inkandswitch/patchwork-system/tree/main/packages/e2e)'s "the base module bundle comes from netlify" and "rendering the default frame needs the production Subduction server to fetch the default-modules doc". New modules are published to the local server with pushwork (`PUSHWORK_SUBDUCTION_SERVER`) and added to the account's module-settings doc.
- **Remote URLs in the base modules:** `threepane` (pkg-base 0.0.72) seeds a new account's Examples folder by importing `https://patchwork-tools.netlify.app/init.js`, plus `https://patchwork-base.netlify.app/init.js` when no static bundle is configured. The harness build rewrites both to a local 404, which threepane already handles ("init script unavailable or failed"). No other remote request occurred.
- **Sync servers** are compile-time defines. `syncServers.classic: false` does *not* disable the classic server; it only drops the preconnect hint, and the URL falls back to the default ([`config-plugin.ts`](https://github.com/inkandswitch/patchwork-system/blob/main/core/patchwork/src/vite/config-plugin.ts): `options.syncServers && typeof options.syncServers.classic === "string" ? options.syncServers.classic : DEFAULT_SYNC_SERVERS.classic`). The harness points it at a local sink. No browser sent a request there; WebKit honours the preconnect hint and opens empty connections.
- **One automerge:** `automerge-repo` pins `@automerge/automerge` 3.3.2 and `@inkandswitch/patchwork` pins 3.5.0. Without the public site's override to 3.4.1, the served `automerge.wasm` doesn't match the bundled glue, and boot fails with a `LinkError`.

### Network recorder

The ground truth is an HTTP proxy that records and refuses every request. Each browser context uses it, and loopback bypasses it. It caught all ten probes in all three browsers: fetch, image, `sendBeacon` and WebSocket from a page, and fetch and WebSocket from a dedicated, a shared and a service worker. Traffic that ignores HTTP proxies, such as WebRTC, is not covered yet; the escape tests need that.

Playwright's own events are only used for attribution, because they miss traffic:

| probe | Chromium | Firefox | WebKit |
|---|---|---|---|
| page fetch, image, beacon | ✓ | ✓ | ✓ |
| page WebSocket | –¹ | ✓ | ✓ |
| dedicated worker fetch / WebSocket | ✓ / – | ✓ / ✓ | ✓ / ✓ |
| shared worker fetch / WebSocket | – / – | – / – | – / – |
| service worker fetch / WebSocket | ✓ / – | – / – | – / – |

¹ Chromium reports a local WebSocket but not one the proxy refuses.

### Browsers

All three browsers are viable for full-UI and multi-user tests. Only Chromium ran patchwork-e2e's full-UI suites because "Playwright's Firefox fails cors fetches made from inside a service worker", and its WebKit "is too flaky on SW timing and emulation". With same-origin modules, the first reason disappears, and a cross-origin CORS fetch from a service worker to another local origin also works in Playwright's Firefox (their case, HTTPS to netlify, can't be tested without egress). WebKit passed 50 of 50 runs. Offline emulation and multi-tab sync, where patchwork-e2e saw WebKit and relay flakes, are not covered by the harness.

### Pitfalls

- Saving a Playwright trace of a booted Patchwork page stalls until the test timeout, even with plain Playwright fixtures, so traces are off.
- The desktop Chrome and Firefox devices emulate `navigator.platform = "Win32"`, so CodeMirror's `Mod` is Ctrl, but Playwright's `ControlOrMeta` follows the host OS. On macOS, `ControlOrMeta+End` is therefore a no-op in those browsers; patchwork-e2e's `typeAtEnd` only works because the click already lands at the end.
- Concurrent typing at the same position interleaves the two users' keystrokes, because CodeMirror maps a cursor past a remote insert at its position. The texts still converge.
