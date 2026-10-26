/**
 * tldraw on PB's `tldraw5` documents, undone with the document's history instead of tldraw's
 * (research/16-undo-redo.md, "tldraw"). The store binding follows PB's tldraw5 (`lith/`): user
 * changes of document records go into `doc.store`, other changes come back record by record.
 */
import type { Patch } from "@automerge/automerge";
import type { DocHandle, DocHandleChangePayload } from "@automerge/automerge-repo";
import { bindUndo } from "@patchwork-cad/undo";
import { createTLStore, defaultShapeUtils, Tldraw, type Editor, type RecordsDiff, type SerializedSchema, type TLRecord, type TLUiOverrides } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { createRoot } from "react-dom/client";

type TLDrawDoc = { store: Record<string, TLRecord>; schema: SerializedSchema };

/** Writes `next` into the document value `into` key by key and element by element, as PB's `deepCompareAndUpdate`. */
function update(into: any, next: any) {
  const nested = (a: unknown, b: unknown) => a !== null && typeof a === "object" && b !== null && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (Array.isArray(next)) {
    next.forEach((value, i) => {
      if (i >= into.length) into.push(structuredClone(value));
      else if (nested(into[i], value)) update(into[i], value);
      else if (into[i] !== value) into[i] = structuredClone(value);
    });
    if (into.length > next.length) into.splice(next.length);
    return;
  }
  for (const [key, value] of Object.entries(next)) {
    if (nested(into[key], value)) update(into[key], value);
    else if (into[key] !== value) into[key] = structuredClone(value);
  }
  for (const key of Object.keys(into)) if (!(key in next)) delete into[key];
}

function write(doc: TLDrawDoc, changes: RecordsDiff<TLRecord>) {
  for (const record of Object.values(changes.added)) doc.store[record.id] = structuredClone(record);
  for (const [, record] of Object.values(changes.updated)) update(doc.store[record.id], record);
  for (const record of Object.values(changes.removed)) delete doc.store[record.id];
}

export default function mount(handle: DocHandle<TLDrawDoc>, element: HTMLElement): () => void {
  const doc = handle.doc();
  // tldraw's shape utils don't type-check under exactOptionalPropertyTypes (their `meta?` returns).
  const store = createTLStore({ shapeUtils: defaultShapeUtils as never });
  store.loadStoreSnapshot({ store: structuredClone(doc.store) as never, schema: doc.schema });
  let writing = false;
  const stopListening = store.listen(
    ({ changes }) => {
      writing = true;
      handle.change((d) => write(d, changes));
      writing = false;
    },
    { source: "user", scope: "document" },
  );
  const onChange = ({ patches, doc }: DocHandleChangePayload<TLDrawDoc>) => {
    if (writing || !doc) return;
    const ids = new Set(patches.flatMap((p: Patch) => (p.path[0] === "store" && p.path.length > 1 ? [String(p.path[1])] : [])));
    const put = [...ids].flatMap((id) => (doc.store[id] ? [structuredClone(doc.store[id])] : []));
    const removed = [...ids].filter((id) => !doc.store[id]) as TLRecord["id"][];
    store.mergeRemoteChanges(() => {
      if (removed.length) store.remove(removed);
      if (put.length) store.put(put);
    });
  };
  handle.on("change", onChange);

  // groupDelayMs: tldraw's marks end steps; a drag is one step however long it pauses. tldraw keeps
  // a record of the user (`user:…`) in the document, which it puts back as soon as an undo deletes it.
  const undo = bindUndo(element, handle, { groupDelayMs: Infinity, ignore: (path) => path[0] === "store" && String(path[1]).startsWith("user:") });
  const overrides: TLUiOverrides = {
    actions: (_editor, actions) => ({
      ...actions,
      undo: { ...actions["undo"]!, onSelect: () => void undo.manager.undo() },
      redo: { ...actions["redo"]!, onSelect: () => void undo.manager.redo() },
    }),
  };
  const onMount = (editor: Editor) => {
    // Every mark (markHistoryStoppingPoint, and tldraw's own) ends a step.
    const history = (editor as unknown as { history: { _mark(id: string): void } }).history;
    const mark = history._mark.bind(history);
    history._mark = (id) => {
      undo.manager.checkpoint();
      mark(id);
    };
  };

  element.style.position = "relative";
  element.style.height = "100%";
  const root = createRoot(element);
  root.render(
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw store={store} overrides={overrides} onMount={onMount} />
    </div>,
  );
  return () => {
    root.unmount();
    undo.unbind();
    stopListening();
    handle.off("change", onChange);
  };
}
