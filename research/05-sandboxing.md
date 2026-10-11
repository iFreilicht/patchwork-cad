# Sandboxing Model Code

> [!WARNING]
> **To be done.** This document only records the threat model and the planned approach. Nothing in it has been prototyped or measured yet.

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

1. **Test harness:** real browsers (Chromium, Firefox, WebKit) driving a local Patchwork instance against a local sync server, with a recorder for every network request that leaves the browser. This harness is also the base for later multi-user and tool tests.
2. **Sandbox runner prototype:** model code and OCCT together in a worker inside an opaque-origin iframe. OCCT has to be inside, because replicad calls the kernel far too often for each call to cross the boundary. Network access is locked down with a Content-Security-Policy, and imports are resolved by our tool through a host-side loader, as in Patchwork's isolation.
3. **Measurements and tests:**
   - **Escapes:** attack scripts try network access (fetch, image beacons, WebSockets, `sendBeacon`, WebRTC), storage, reaching the parent page, navigating the top window, popups, and nested frames or workers. Each must fail in every browser, verified against the request recorder rather than against what the sandbox claims to block.
   - **Denial of service:** infinite loops and memory bombs; time until the worker is killed, and main-thread responsiveness meanwhile. The watchdog must tell a stuck script from a slow kernel operation.
   - **OCCT load cost:** the opaque origin has no Cache API or IndexedDB, and a compiled `WebAssembly.Module` probably can't be passed into it. Measure cold and warm load times and whether compiled wasm can be reused.
   - **Multi-threaded OCCT:** whether its cross-origin-isolation requirement can be met inside the sandbox.
   - **Determinism:** whether `Math.random`, `Date` etc. must be made deterministic so that all collaborators compute the same geometry.
   - **End to end:** M1 from the [naming prototype](03-topological-naming/prototype/) running in the sandbox, with an `automerge:` import resolved through the loader, and meshes and selection data passed out efficiently.

   Every failure is explained before it counts as a result, as in 03.
