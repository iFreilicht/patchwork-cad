# Collaboration: Presence and Comments

How Patchwork syncs where collaborators are (cursors, selections) and how comments point into a document, what that supports, where it breaks, and what it means for the CAD tools. Covers two items of the [status](00-status.md#not-started): collaborators' cursors, highlights, selections and timeline markers in their colour, and comments on code, faces, edges and features.

AM = [`@automerge/automerge-repo` 2.6.0-subduction.48](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src), the version we bundle; PB = the vendored [patchwork-base](../.claude/skills/writing-patchwork-tools/reference/patchwork-base).

## Presence

### Transport

Presence is ephemeral messaging on a document handle: `handle.broadcast(message)` and the `ephemeral-message` event. Nothing is stored ([`DocHandle.ts`](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src/DocHandle.ts): "It has no guarantee of delivery, and is not persisted to the underlying automerge doc in any way"). With Subduction, each document is a pub/sub topic on the sync server (`subscribeEphemeral` / `publishEphemeral` in [`subduction/source.ts`](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src/subduction/source.ts)), so presence works between any two clients that have the document open, but only through the server. All handles of a document, including sub-handles, share one channel (`dispatchEphemeral` in [`handle-registry.ts`](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src/subdoc-handles/handle-registry.ts) emits to every handle).

### The `Presence` class

AM's [`Presence`](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src/presence/Presence.ts) builds peer state on top:

```ts
const presence = new Presence<{ selection: Sel | null }>({ handle, userId: contactUrl });
presence.start({ initialState: { selection: null }, heartbeatMs, peerTtlMs }); // defaults 15 s, 45 s
presence.broadcast("selection", sel);           // one channel; peers merge it into our state
presence.on("update" | "snapshot" | "goodbye" | "pruned", refresh);
presence.getPeerStates().peers;                  // [{ peerId, userId, lastActiveAt, value }]
presence.stop();                                 // sends "goodbye"
```

- **A peer is a repo, i.e. a browser tab**, keyed by the sender's `PeerId`. Patchwork runs one `Repo` per tab, and every tool in the tab uses it ([`setup.ts`](../node_modules/.pnpm/@inkandswitch+patchwork-bootloader@0.8.1_@automerge+automerge-repo-keyhive@0.6.0-alpha._85e8251069e5e5e4df9c8c5d655fd21f/node_modules/@inkandswitch/patchwork-bootloader/src/setup.ts) about its shared worker: "Tabs don't sync through it — each tab is its own node"). Two tabs of the same user are two peers; `userId` is whatever the sender claims ("this is unverified; peers can send anything"). Tools put the contact URL there and dedupe by it.
- **State is a map of channels.** An `update` sets one channel, a `snapshot` all of them, and receivers merge both into the peer's existing state. On seeing a new peer, `Presence` re-sends its snapshot after a fixed 500 ms ("waiting some arbitrary amount of time is brittle").

### Users in PB

| Tool | Broadcasts | Notes |
|---|---|---|
| `doc-presence` ([doc-presence.js](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/doc-presence/doc-presence.js)), the faces in the title bar | `contactUrl`, `name`, `color`, `avatarUrl`, `focused` | heartbeat 2 s, TTL 10 s; one `Presence` per document for the whole page |
| `codemirror-base` ([presence.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/codemirror-base/src/lib/extensions/presence.ts)) | `selection: { start, end }` as Automerge cursors, `null` while blurred | "as a pair of automerge cursors rather than plain offsets, so every receiver resolves it against its *own* view of the document"; rAF-throttled; carets labelled with the `contact-cursor` tool |
| `tldraw4`/`tldraw5` ([useAutomergeStore.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/tldraw4/src/lith/useAutomergeStore.ts)) | tldraw's `TLInstancePresence` (pointer in page coordinates, selected shapes, camera) | cursor cleared "when blurred or pointer leaves" |
| `chat` ([PresenceContext.tsx](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/chat/src/context/PresenceContext.tsx)), `call` ([call-session.js](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/call/src/call-session.js)) | their own messages with `handle.broadcast`, not `Presence` | `chat` keys peers by name and drops them after 30 s; `call` gives each session a random id (`this.peerId = crypto.randomUUID();`) and sends `join` as heartbeat and `leave` on close |

None of these share a `Presence` between tools: `doc-presence` shares one within its own bundle, codemirror-base and tldraw (via `usePresence`) stop theirs on unmount, and `space-time`'s "Fallback publish while idle" ([use-playhead-presence.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-experiments/space-time/src/presence/use-playhead-presence.ts)) skips unchanged state, so it doesn't prevent the pruning below. Yjs solves both problems with one `Awareness` per document, owned by the provider: bindings only set their field (y-codemirror.next: `awareness.setLocalStateField('cursor', null)` on blur), every update refreshes a peer, and a client renews its whole state after half of the 30 s timeout ([awareness.js](https://github.com/yjs/y-protocols/blob/master/awareness.js): `outdatedTimeout / 2 <= now - … lastUpdated` → "renew local clock"). Patchwork has no such shared owner; the frame provides `patchwork:focus`, but nothing for presence.

**Identity and colour.** A tool asks the frame for the user's contact with the `patchwork:contact` provider ([AccountProvider.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/providers/src/AccountProvider.ts)). The contact doc has a `name` and an optional `color`, but both cursor renderers ignore `color` and hash the contact URL into a 12-colour palette ([ContactCursor.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/account/src/contact/ContactCursor.ts): `const color = generateColorFromString(handle.url);`), while `doc-presence` uses `c.color`. The hash sums the URL's character codes, so two collaborators share a colour with a probability of about 1 in 12.

### Limitations

Checked with scripts that wire two tabs' `Presence` instances together through stub handles (scratch experiments, not committed):

- **Idle peers flicker.** Heartbeats don't refresh the timestamp that pruning checks (`markSeen` sets `lastUpdateAt`, `prune` keeps `state.lastActiveAt >= threshold`). An idle peer is pruned at the TTL and comes back with the next announce. Sampled every 50 ms with heartbeat 200 ms, TTL 1000 ms: `###################################..####…`. In `doc-presence` (TTL 10 s), a face that hasn't changed state blinks out every 10 s. Upstream fixed this in [#556](https://github.com/automerge/automerge-repo/pull/556) (2026-01-24, `lastSeenAt`); the subduction fork branched before it and before the API change to cohorts in [#555](https://github.com/automerge/automerge-repo/pull/555) (both still have `userId`/`deviceId`), and its newest release 2.6.0-subduction.49 has neither.
- **One `Presence` per document per tab.** All `Presence` instances in the same tab share its `PeerId`, so receivers merge them into one state: two of our views broadcasting `camera` overwrite each other, and a channel name another tool uses (`selection`, `focused`) collides. Worse, `stop()` of any one instance sends a `goodbye`, and receivers delete the whole peer: after one of two `Presence` instances in tab B stopped, tab A saw nothing of B until announces restored it 0.7 s later (heartbeat 200 ms); afterwards both sides kept re-sending snapshots at heartbeat rate. `goodbye` handling is the same on upstream `main`, and no issue reports it. The related [#652](https://github.com/automerge/automerge-repo/issues/652) (open) describes peers that stay known with only the channels of a partial update after asymmetric pruning; its fix [#764](https://github.com/automerge/automerge-repo/pull/764) was closed unmerged. So whenever another tool on the same document stops its `Presence`, e.g. `doc-presence` when the user navigates away or a closed pane, the tab's other presence state disappears from its peers for up to a heartbeat interval plus 500 ms.
- **Messages can arrive before the change they refer to.** codemirror-base: "A cursor can briefly fail to resolve when a presence message races ahead of doc sync -- the peer is skipped and picked up again on the next change."

### A presence provider

The limitations come from several `Presence` instances per document and tab, which the class doesn't expect: like Yjs's `Awareness`, it holds one state per peer. A different `PeerId` per editor is no way out, because the `PeerId` belongs to the tab's `Repo` and all its sync traffic. Instead, the frame should own one `Presence` per document and tab and hand it to tools with a provider, as it shares `patchwork:focus` and `patchwork:tool-storage` across separately bundled tools:

```ts
subscribe(element, { type: "patchwork:presence", url: docUrl }, (presence) => {
  presence.set({ selection, camera }); // this subscription's state
  presence.peers;                      // [{ contactUrl, name, color, focused, views: { [subscriptionId]: state } }]
});
```

- **Each subscription is a view.** The provider files a subscription's state under its own key, so two views of one tab can't overwrite each other, and tools need no instance identity, which Patchwork doesn't give them ([10](10-view-state.md#instance-identity)).
- **Closing a view** sets its key to `null`. The provider sends `goodbye` only when the last subscription for the document ends, or on `pagehide`, i.e. when the tab really leaves.
- **The provider broadcasts identity once per tab**, name, colour and focus, as `doc-presence` does today; `doc-presence` becomes a consumer, and every tool shows a user in the same colour.
- **Tools don't depend on the `Presence` class**, so upstream fixes or another transport, e.g. `call`'s own messages, only change the provider.

It only helps once every tool on a document uses it (`doc-presence`, codemirror-base, tldraw), since one tool with its own `Presence` still wipes the shared one with its `goodbye`. Outside a frame there is no provider, so tools fall back to their own instance. The providers so far answer with plain values (a URL, a list), not objects with methods; the provider could instead answer with peer states and take writes through an event. [#652](https://github.com/automerge/automerge-repo/issues/652) remains, just less likely with fewer instances.

## Comments

### Data model

Threads are stored in the commented document itself, under `@comments` ([comments.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/comments-view/src/comments.ts)):

```ts
type DocWithComments = { "@comments"?: { threads: CommentThread[] } };
type CommentThread = { id: string; refs: AutomergeUrl[]; isResolved: boolean; comments: Comment[]; "@patchwork"?: { type: "comment-thread" } };
type Comment = { id: string; content?: string; draftContent?: string; contactUrl: AutomergeUrl; timestamp: number };
```

A ref is a **sub-handle URL**: a document URL plus a path into it ([parser.ts](../node_modules/.pnpm/@automerge+automerge-repo@2.6.0-subduction.48/node_modules/@automerge/automerge-repo/src/subdoc-handles/parser.ts): keys, `@0` indices, `{"id":"alice"}` matches and `[start-end]` cursor ranges). The text editor anchors a comment with `handle.sub("content", cursor(from, to)).url` ([codemirror-base comments.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/codemirror-base/src/lib/extensions/comments.ts)), a document-level comment with the bare document URL. A thread itself is addressed as `handle.sub("@comments", "threads", { id })`.

### The frame's providers

- **`patchwork:comments`** ([CommentsProvider.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/providers/src/CommentsProvider.ts)) watches every mounted document's `@comments` and answers `{ targetUrl, threadUrl }` entries per target document. Resolved threads are left out (`if (thread.isResolved) continue;`).
- **`patchwork:focus`** ([FocusProvider.ts](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/providers/src/FocusProvider.ts)) is a shared local doc of sub-handle URLs: "`selection`: single active range, owned by the cursor producer (the active editor)" and "`highlight`: auxiliary emphasis any view may contribute". The Comments panel shows the threads overlapping `selection` first and writes the focused thread's refs into `highlight`; clicking a thread writes them into `selection`. The editor renders and scrolls to both.
- **The Comments panel** ([CommentsView.tsx](../.claude/skills/writing-patchwork-tools/reference/patchwork-base/comments-view/src/CommentsView.tsx)) is a context tool ([09](09-patchwork-26-features.md#how-a-tool-gets-into-the-right-sidebar)) that renders each thread with the `comment-thread` tool. It **only lists a thread whose target is a non-empty text range or the whole document**: "Targets that resolve to an empty string (a collapsed range) or an undefined value (an anchor that no longer resolves) are excluded". A ref to a non-text path, e.g. a feature object, has no range and is never shown. Overlap with the selection uses `DocHandle.overlaps`, which also requires ranges on the same path.

### Anchors under edits

What a cursor range on a statement in `source` resolves to (Automerge 3.4.1, scratch experiment):

| Edit | Range |
|---|---|
| none | `"const notch = cut(a);"` |
| variable renamed inside the range | `"const slot = cut(a);"` |
| statement deleted | `""` (collapsed) |
| deleted, then the same text inserted again, which is what an undo does | `""` (collapsed, after the new text) |
| `source` reassigned instead of spliced | `getCursorPosition` throws |

So a comment survives edits to and around its text, but not a delete, even an undone one. Patchwork then hides the thread; nothing deletes it.

### Prior art for deleted targets

- **Google Docs** keeps the comment and says so: comments show "Original content deleted" when their text is gone ([googleworkspace/cli#169](https://github.com/googleworkspace/cli/issues/169), which hits the same label through the API). Drive's own anchors are worse: "Anchors are immutable, and their position relative to the content of a document cannot be guaranteed between revisions" ([Manage comments](https://developers.google.com/workspace/drive/api/guides/manage-comments)).
- **WordPress block comments** copy that: "Original block deleted" ([gutenberg#71868](https://github.com/wordpress/gutenberg/issues/71868)).
- **Figma** detaches: "If you cut a layer or frame and paste this in a new location, Figma disconnects the comment from that layer. You can still view and respond to that comment from the right sidebar" ([Move or edit comments](https://help.figma.com/hc/en-us/articles/360041547853-Move-or-edit-comments)). Users ask to reattach them, as "it's too difficult to tell what the original comment was referencing" ([forum](https://forum.figma.com/suggest-a-feature-11/make-it-possible-to-reattach-unattached-comments-33090)).
- **Onshape** tags a comment with one entity, "part, edge, face, sketch, sketch dimension, etc.", and "A comment icon appears next to the feature in the list or on the entity in the graphics area" ([Commenting](https://cad.onshape.com/help/Content/Collaboration/comments_on_workspaces.htm)). The tag can be replaced ([forum](https://forum.onshape.com/discussion/25157/can-you-move-comments-tag-more-than-one-entity)). Its help doesn't say what happens to a tag whose entity is deleted.
- **Fusion** links a comment to a body or a point on an edge ([Autodesk](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Using-Comments-in-Fusion-360.html)); users report such comments vanishing ([forum](https://forums.autodesk.com/t5/fusion-support-forum/is-it-intentional-that-comments-just-disappear/td-p/9359987)).

Presence in Onshape is "Follow Mode": the follower sees "The collaborator's cursor movements (shown as a hand in the social cue icon color)", "Selections made in the graphics area", "Selections made in the Feature list" and the dialogs they edit in ([Follow Mode](https://cad.onshape.com/help/Content/Collaboration/follow_mode.htm)).

## Impact on the CAD tools

### Presence

- **We build the provider's interface ourselves now:** a module-level singleton per model document, shared by the editor and the viewer (one package, so one module instance), with a key per view, so per-view state such as a camera needs no view identity. Its channel is prefixed (`cad:…`) against other tools on the same document, and it re-sends its snapshot periodically, not only on change, so that other tools' `goodbye`s and the idle pruning cost at most a heartbeat interval. Once Patchwork has a [presence provider](#a-presence-provider), the singleton becomes a `subscribe` call.
- **What to broadcast**, and in which form so a peer can resolve it against its own build, which may be of another version of `source`:

  | State | Form | Shown as |
  |---|---|---|
  | code selection | Automerge cursors into `source`, as codemirror-base | carets and tints in the code pane |
  | timeline marker | its cursor and variable ([`TimelineMarker`](../src/cad/src/types.ts)) | a marker in their colour in the timeline |
  | hovered and selected faces, edges, features | canonical reference names ([03](03-topological-naming.md#references-in-code)), not mesh indices, which a rebuild renumbers ([12](12-hover-highlighting.md#open)) | see-through highlights in their colour, also in the timeline |
  | pointer | the world-space point under it on the model, or none | a marker in 3D; screen positions mean nothing under another camera |
  | camera | [`CameraState`](../src/cad/src/types.ts) | a follow mode like Onshape's, later |

  A name that doesn't resolve in the local build, e.g. a feature the peer has added and we haven't received yet, is skipped until the next build, like codemirror's cursors.
- **Colour** comes from the contact URL hash, as codemirror-base's carets, so a user has the same colour in both; collisions are 1 in 12.
- **Highlight cost:** each peer's selection is one more highlight overlay ([12](12-hover-highlighting.md#design)), and a name costs a `pick` request to the worker. Hover names change often, so they should be rate-limited.

### Comments

`@comments` lives in the model document next to `source`. That keeps the model portable ([02](02-model-storage.md#design-goal-portable-models)): the module is `source` alone.

| Target | Ref | Works in the Comments panel |
|---|---|---|
| code | `sub("source", cursor(from, to))` | yes, as in any text document |
| feature | the cursor range of its statement in `source` | yes; hovering the thread highlights its code, our editor maps it to the entry |
| face, edge | the range of its owner's statement ([12](12-hover-highlighting.md#design)), plus the reference itself in an extra thread field, e.g. `"@cad": { entity: "edge(extrude1.end, notch.side.c)" }` | listed, but the `comment-thread` tool shows neither the entity nor a pin; our tools draw the pin and highlight the entity |

- **Every target is a range in `source`** because the panel hides anything else. A comment on an entity that is not a range would need our own list of threads, or a change upstream.
- **Our tools have to join the focus protocol:** write the selected feature's or entity's statement range to `selection`, so the panel brings its threads up, and highlight the entities of the threads in `highlight` and `selection`.
- **Deleted targets:** Patchwork hides the thread; Google Docs, WordPress and Figma keep it and say so. A deleted feature in a CAD model is often undone or retyped, which collapses the range for good (see above), so we should store a fallback with the thread, the variable name and the quoted statement, as the timeline marker keeps `next` ([07](07-poc-modelling-ui.md#feature-identity-across-re-parses)), re-anchor when the name reappears, and otherwise list the thread as "Feature deleted". For a face or edge whose reference breaks, the thread shows the broken reference and the suggestion the feature library already makes ([03](03-topological-naming.md#recommendation)), and lets the user re-tag the entity as in Onshape.

## Open

- Whether patchwork-base would accept non-range targets, or an "Original content deleted" state, in the Comments panel, instead of us listing threads ourselves.
- A [presence provider](#a-presence-provider) in patchwork-base, and getting the pruning fix into the subduction releases.
- What the viewer tool shows of collaborators: it has no code pane and no timeline.
- Comments outside Patchwork (standalone): no provider, so the tools would need their own panel.
