---
name: working-with-automerge
description: >-
  Model, read, and mutate Automerge documents when building Patchwork tools.
  Covers the JSON-ish data model and its JavaScript type mapping, reading and
  writing through a DocHandle, the fine-grained mutation rules that make
  changes merge well, collaborative text (splice / updateText /
  ImmutableString), counters, timestamps, conflicts and merge semantics, and
  how to split app state across documents linked by AutomergeUrl. Includes
  warnings about outdated Automerge APIs (the Text class, the `next` import,
  docSync/whenReady, non-awaited repo.find) that older docs and LLM training
  data still suggest.
---

# Working with Automerge documents

Automerge is the CRDT library underneath every Patchwork document. A document is like a
combination of a JSON object and a git repository: a map from strings to values (which can
be nested maps, arrays, text, or scalars) that carries its full change history, so any two
copies can always be merged deterministically with no central server.

In a Patchwork tool you never set up Automerge yourself — the host provides a configured
`Repo` (`window.repo`) and hands your tool a `DocHandle`. **Do not create your own `Repo`,
storage/network adapters, or initialize WASM; that is host plumbing.** This skill is about
the part you do own: the shape of the data and how you change it. (For the render contract,
globals, and ephemeral messaging, see the `writing-patchwork-tools` skill.)

## 1. Reading and writing through a DocHandle

```js
const doc = handle.doc()             // synchronous snapshot (a plain JS object)
handle.change(d => { d.count = 1 })  // ALL writes go through change()
handle.on("change", onChange)        // fires on local AND remote edits
handle.off("change", onChange)

const other = await repo.find(url)   // Promise<DocHandle>, resolved handle is ready
const fresh = repo.create(initialContents)
```

Snapshots are immutable: `handle.doc()` returns the state at one point in time, and every
change produces a new state. Never mutate a snapshot directly — mutations only count inside
the `change()` callback, where Automerge records them as operations. Reassigning into a
stale snapshot silently does nothing (or worse, throws).

### ⚠ Outdated API patterns — do not copy these

Automerge's API changed across versions, and older docs, blog posts, and LLM training data
are full of the old shapes. If you catch yourself writing any of the left column, use the
right column instead:

| Outdated (do NOT use) | Current |
| --- | --- |
| `const h = repo.find(url); await h.whenReady()` | `const h = await repo.find(url)` |
| `handle.docSync()` | `handle.doc()` (synchronous) |
| `handle.doc()` as an async method to await | `handle.doc()` is sync; nothing to await |
| `new Automerge.Text()` + `.insertAt()` | plain `string` + `Automerge.splice` |
| `import { next as Automerge } from "@automerge/automerge"` | `import * as Automerge from "@automerge/automerge"` |

Even the official Automerge docs are not fully consistent — older cookbook pages still show
`useHandle`/`docSync()`/`whenReady()`. When in doubt, the patterns in this skill and in
`writing-patchwork-tools` are the ground truth for Patchwork.

## 2. The data model and its JavaScript mapping

A document is a root map. Values can be:

| Automerge type | In JavaScript | Notes |
| --- | --- | --- |
| Map | plain object | string keys |
| List | `Array` | `push`, `unshift`, `splice`, `insertAt`, `deleteAt`, index assignment all work |
| Text | plain `string` | **every plain string is collaborative text** — see section 4 |
| Non-collaborative string | `new Automerge.ImmutableString("…")` | atomic replace-only strings (URLs, ids, enum values) |
| Integer / float | `number` | `Number.isInteger(x)` → stored as int, else float |
| Boolean, null | `boolean`, `null` | `undefined` is NOT allowed — see section 3 |
| Timestamp | `Date` | milliseconds since epoch |
| Counter | `new Automerge.Counter(n)` | merges by summing increments — see section 5 |
| Bytes | `Uint8Array` | |

For helpers like `Automerge.splice`, `Automerge.updateText`, and `Automerge.mark`, use
`import * as Automerge from "@automerge/automerge"` (it's in Patchwork's importmap). Keep
that import out of a tool's `plugins` entry module — the entry
module runs in a worker with no importmap; import it in the tool/datatype module loaded via
`load()`.

## 3. Mutation rules — write so your changes merge

These rules are the heart of working with Automerge. Break them and the tool will *seem*
to work single-user, then merge badly or clobber data in multiplayer.

- **Make changes at the finest grain possible.** Don't replace a container to change one
  thing inside it. From Automerge's point of view, `d.cards = [...d.cards, newCard]`
  replaces the *entire* array with a brand-new object — concurrent edits to the old array
  are lost as a conflict on `d.cards`. Instead: `d.cards.push(newCard)`,
  `d.cards[i].title = "x"`, `d.entities[id] = item`. **Never use spread/immutable idioms
  inside `change()`.**
- **No `undefined`, ever.** To remove a field: `delete d.prop`. To signal absence:
  `d.prop = null`. Assigning `undefined` throws.
- **Keep the model JSON-shaped and flat-ish.** Plain objects, arrays, strings, numbers.
  Define the schema by example in the datatype's `init(doc)` — the fields you set there
  *are* the schema.
- **Don't use incrementing numbers as ids.** Two peers will generate the same "next id"
  concurrently. Use `crypto.randomUUID()` (or similar) for entity ids.
- **A `change()` callback is atomic** — all mutations in one call ship as one change, so
  group related mutations. But don't do slow/async work inside the callback.

## 4. Text

**Every plain `string` in a document is collaborative text.** This is an Automerge 3
change worth internalizing: the old `Text` class is gone, strings themselves are the
text CRDT.

The consequence: `d.title = newValue` replaces the whole string — concurrent edits by two
users to the same field won't interleave, one replacement wins. That's often fine for a
short title, but for anything a user *types into*, edit the string instead of replacing it:

```js
import * as Automerge from "@automerge/automerge"

handle.change(d => {
  Automerge.splice(d, ["text"], 5, 0, " wonderful")   // insert at index 5, delete 0 chars
})

// When you only have the whole new value (e.g. an <input>'s oninput):
input.oninput = (e) => {
  handle.change(d => Automerge.updateText(d, ["title"], e.target.value))
}
```

- `Automerge.splice(doc, path, index, deleteCount, insertText)` is the precise tool when
  you know what changed.
- `Automerge.updateText(doc, path, newValue)` diffs old vs new and applies a minimal edit
  script. Call it **on every keystroke** (`input`/`oninput`), not on `change`/blur — if the
  string drifted a lot between calls, the computed diff merges poorly with concurrent edits.
- For real text editors, don't hand-roll this: use the
  [automerge-codemirror](https://github.com/automerge/automerge-codemirror) integration
  (`@automerge/automerge-codemirror` + Automerge cursors), as existing Patchwork text tools
  do.
- If a string should behave atomically (a URL, a color hex, an enum), store an
  `ImmutableString` so nobody accidentally gets character-level merging on it.

### Rich text (marks and blocks)

For rich text, Automerge extends strings with **marks** (formatting spans:
`Automerge.mark(d, path, {start, end, expand}, "bold", true)`, read with
`Automerge.marks()`) and **block markers** (inline maps dividing text into
paragraphs/headings/etc., via `Automerge.splitBlock` / `Automerge.updateBlock`).
`Automerge.spans(d, path)` returns the text grouped by marks and interleaved with block
markers — the practical read API. Mark values must be scalars (serialize complex values to
JSON strings). If you need this level, prefer the existing
[automerge-prosemirror](https://github.com/automerge/automerge-prosemirror) or
[automerge-codemirror](https://github.com/automerge/automerge-codemirror) bindings over
driving these primitives yourself, and note the sharp edge: `Automerge.updateSpans()`
updates **only block structure, not formatting marks** — marks must be reconciled
separately.

## 5. Counters

For numbers that only ever go up/down by increments (votes, clicks), use a `Counter`, not
`d.n += 1`. Two peers doing `+= 1` concurrently both write "4" and the merge result is 4,
not 5; a `Counter` merges by summing all increments, giving 5.

```js
handle.change(d => { d.clicks = new Automerge.Counter() })
handle.change(d => { d.clicks.increment(1) })   // .decrement(n) too
const n = handle.doc().clicks.value
```

## 6. Conflicts and merge behavior — what to expect

You rarely handle conflicts explicitly; you design so they don't matter. The intuition:

- Concurrent edits to **different** fields/elements merge cleanly. This is why fine-grained
  mutation (section 3) matters so much.
- Concurrent **inserts** into the same list position: both survive, in a deterministic
  order (each peer's run of insertions stays contiguous).
- Concurrent **delete vs. update** of the same field or list element: the update wins.
- Concurrent **set of the same field**: one value wins, arbitrarily but deterministically —
  every peer agrees on the winner. The losers aren't gone; `Automerge.getConflicts(doc,
  "field")` returns all concurrently-written values if you want to surface them. The next
  write to the field clears the conflict. Note the "last writer" is picked by internal
  operation id, **not wall-clock time**.

## 7. Modeling data across documents

A document is the unit of sync, sharing, and history — roughly "a thing a small group
collaborates on". Patchwork apps are a web of documents linked by `AutomergeUrl` strings
(`automerge:<base58>`), not one big database: a folder doc holds links to item docs, a
comments doc can point at a text doc, etc. Store the *URL* in the referencing doc and
`await repo.find(url)` when you need the target. Hundreds of documents are fine; loading
thousands at once gets slow — don't give every tiny entity its own doc.

Documents keep their entire history forever (that's what makes merging work), and the
storage format is compact enough that this is normally fine — but don't write huge blobs
or extremely high-frequency state into a doc. For fast-changing session state (cursors,
presence, "now playing") use ephemeral messages (`handle.broadcast`, never persisted) —
see section 7 of `writing-patchwork-tools`.

Schema setup: put initial structure in the datatype's `init(doc)`. Every peer receives that
initial change by syncing, so there's exactly one "create the arrays" change in history.
Never have each peer independently "initialize if missing" a shared schema on documents
that lack common ancestry — same-looking changes from different actors don't merge into
one. For schema evolution, prefer additive changes and tolerate missing fields when
reading old docs.
