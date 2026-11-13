/**
 * Documents entering the model (research/21, "Dropping, pasting, inserting"): a Patchwork document
 * dragged onto the editor, pasted into it or given to "Insert". Where a drop lands preselects a role:
 * the code pane, the timeline and the documents list Import, which is written at once; a number field
 * a value of the document for it; anywhere else nothing, and the document waits as a pending insert,
 * a selection with the document dialog, until the user chooses. A face preselects Annotation for any
 * document but an image or an SVG, which wait for Decal and Sketch.
 */
import { batch, createSignal, onCleanup, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle, UrlHeads } from "@automerge/automerge-repo";
import { analyze } from "../../model/analyze.ts";
import { documentId, documentStatements, importName, insertImports, valueReference, type NewImport } from "../../model/documents.ts";
import { parameters, setDefault } from "../../model/params.ts";
import { namesIn } from "../../model/refactor.ts";
import { applyToText, apply, setProp, type Edit } from "../../model/splice.ts";
import { timeline } from "../../model/timeline.ts";
import type { CadAnchor, CadModelDoc } from "../../types.ts";
import type { AnnotationStore, AnnotationPlaces } from "../annotations.tsx";
import type { Entity } from "../Viewer.tsx";
import { annotationRowId } from "./documents.ts";

/** The viewer tool, which a CAD model is shown with as an annotation. */
const VIEWER_TOOL_ID = "cad-model-viewer";
import { resolvedFrom } from "../configurations.ts";
import { documentsInText, droppedDocuments, dropEffect, isPatchworkDrag, mayCarryDocuments, type DroppedDocument } from "../dnd.ts";
import type { DocumentInfo } from "../documentInfo.ts";
import { defaultImport, docOf, fileKind, fileText, headsOf, importKinds, isFile, valueAt, valuePath, valueUrl, withHeads, withoutHeads, type ValuePath } from "../imports.ts";
import type { Model } from "../createModel.ts";
import type { Documents } from "./documents.ts";
import type { ParamsController } from "./parameters.ts";
import type { Editor, SelectionFrom } from "./state.ts";

/**
 * A role a document can play in the model (research/21, "Roles"), as "Use as" offers it: whether the
 * document allows it, given its value and whether its URL names a value inside it. Each role has its
 * own preselection rule (`preselects`) and its own fields in the dialog.
 */
export interface Role {
  id: "import" | "annotation";
  label: string;
  title: string;
  allows(value: unknown, path: boolean): boolean;
}

export const ROLES: readonly Role[] = [
  { id: "import", label: "Import", title: "Import it in the code", allows: (value, path) => path || importKinds(value).length > 0 },
  // A view of the whole document, which the embed frame shows (research/21, "Annotation").
  { id: "annotation", label: "Annotation", title: "Show it at a place on the model", allows: (_, path) => !path },
];

/** A number field a value is dropped on: a feature's argument, a parameter's default, or a configuration's value. */
export type ValueTarget = { kind: "argument"; feature: string; param: string; label: string } | { kind: "default"; key: string } | { kind: "override"; configuration: string; name: string; key: string };

/** Where a drop lands, by the `data-drop` of the element under the pointer and its `data-drop-value`. */
export type DropTarget =
  | { kind: "import" | "insert" | "document" | "refuse"; element: Element | undefined }
  | { kind: "value"; element: Element; target: ValueTarget }
  | { kind: "face"; element: Element; face: Entity };

/**
 * The role a drop of a document whose value is `value` on a target preselects (research/21,
 * "Dropping, pasting, inserting"): on a face, Annotation, but for an image or an SVG, which are to be
 * a decal or a sketch.
 */
export const preselects = (target: Pick<DropTarget, "kind">, value: unknown): Role["id"] | undefined => {
  if (target.kind === "import") return "import";
  if (target.kind !== "face") return undefined;
  const kind = isFile(value) ? fileKind(value) : undefined;
  return kind === "image" || kind === "svg" ? undefined : "annotation";
};

/** What a field target is called, in the dialog, the status bar and problems: "Distance of extrude1", "the default of w", "w in Wide". */
export const targetLabel = (t: ValueTarget) => (t.kind === "argument" ? `${t.label} of ${t.feature}` : t.kind === "default" ? `the default of ${t.key}` : `${t.key} in ${t.name}`);

/** How deep a picker looks for values that fit a field: keys per level as the preview shows them, values in all, and paths it opens. */
export const PICK_LIMITS = { keys: 50, nodes: 5000, paths: 20 } as const;

/**
 * Why no value of a document can be picked for a field (research/21, "Dropping, pasting,
 * inserting"), as the pending insert's dialog says it: the document is loading or can't be read, is
 * a CAD model or a file that isn't JSON or JS, is a file a configuration can't link into, or has no number
 * where a search that covered all of it (`complete`) looked. Undefined if a pick may be possible.
 */
export function pickProblem(title: string, info: Pick<DocumentInfo, "status" | "value" | "problem">, target: ValueTarget, search: { paths: readonly unknown[]; complete: boolean } | undefined): string | undefined {
  const field = targetLabel(target);
  if (info.status === "loading") return `${title} is still loading.`;
  if (info.status === "unavailable") return `${title} can't be loaded: ${info.problem ?? "it isn't available"}.`;
  const value = info.value;
  if ((value as { "@patchwork"?: { type?: unknown } } | undefined)?.["@patchwork"]?.type === "cad-model") return `${title} is a CAD model, which has no number to use for ${field}.`;
  if (isFile(value)) {
    const kind = fileKind(value);
    if (target.kind === "override") return `${title} is a file, and ${field} can only link to a number in a data document.`;
    // A JS file's numbers are its exports, which the dialog runs it for.
    if (kind !== "json" && kind !== "js") return `${title} is ${kind === "svg" ? "an SVG" : kind === "image" ? "an image" : fileText(value) === undefined ? "a binary" : "a text"} file, which has no number to use for ${field}.`;
  }
  if (search && search.paths.length === 0 && search.complete) return `${title} has no number to use for ${field}.`;
  return undefined;
}

/** A document waiting for its role: the selection's `insert` item, which names nothing in the model yet. */
export interface PendingInsert {
  id: string;
  /** The document, possibly with a path to a value in it; undefined while "Insert" has none yet. */
  url: AutomergeUrl | undefined;
  /** The number field it was dropped on, which a picked value fills. */
  target: ValueTarget | undefined;
  /** The name the drag gave it, for its import's name. */
  name: string | undefined;
  /** The face it was dropped on, which an annotation is pinned to. */
  anchor?: CadAnchor | undefined;
}

export interface Inserts {
  /** The pending insert, while it is selected. */
  pending: Accessor<PendingInsert | undefined>;
  /** What a drop where a document is dragged would do, for the status bar. */
  status: Accessor<string | undefined>;
  /** Whether a document is dragged over the editor, e.g. to show the documents list as a target. */
  dragging: Accessor<boolean>;
  /** The face a document is dragged over, which a drop pins it to. */
  dropFace: Accessor<Entity | undefined>;
  /** Selects a new pending insert of `url`, or of no document yet. */
  begin(url: AutomergeUrl | undefined, target: ValueTarget | undefined, from: SelectionFrom, name?: string): void;
  /** Gives the pending insert the document of a pasted URL; says why not. */
  setDocument(text: string): string | undefined;
  /** Chooses a role for the pending insert's document. */
  choose(role: Role["id"]): Promise<void>;
  /** Uses the value at `path` of the pending insert's document: fills its field, or imports only that. */
  pick(path: ValuePath): Promise<void>;
  /** The document of the pending insert, its value (at its URL's path), whether that is a file's, and the path. */
  documentOf(p: PendingInsert): { doc: AutomergeUrl; info: DocumentInfo; value: unknown; file: boolean; path: ValuePath | undefined } | undefined;
  /** What a field target is called, e.g. in the dialog. */
  targetLabel(target: ValueTarget): string;
  /** What JS file `doc` exports, as far as it is JSON, at the version the model imports it at, else its current one; rejects with what it threw. */
  exportsOf(doc: AutomergeUrl): Promise<unknown>;
}

/** How long a drag may leave the editor's elements before its highlight goes: Safari's `dragleave` has no `relatedTarget`, and every element boundary looks like leaving. */
const LEAVE_MS = 150;

export function createInserts(props: {
  handle: DocHandle<CadModelDoc>;
  editor: Editor;
  model: Model;
  documents: Documents;
  params: ParamsController;
  annotations: AnnotationStore;
  /** A face's anchor, as a comment on it has. */
  anchorOf: AnnotationPlaces["anchorOf"];
  /** The face at a point on the screen, if the 3D view has one there. */
  faceAt: (x: number, y: number) => Entity | undefined;
  info: (url: string) => DocumentInfo;
  element: HTMLElement;
}): Inserts {
  const { handle, editor, element } = props;
  const [pendingInsert, setPending] = createSignal<PendingInsert>();
  const pending = () => {
    const s = editor.selection();
    const p = pendingInsert();
    return s?.kind === "insert" && p?.id === s.id ? p : undefined;
  };
  let count = 0;
  const begin = (url: AutomergeUrl | undefined, target: ValueTarget | undefined, from: SelectionFrom, name?: string, anchor?: CadAnchor) => {
    const id = String(++count);
    batch(() => {
      setPending({ id, url, target, name, anchor });
      editor.select({ kind: "insert", id }, from);
    });
  };

  /** The code as it is now, with what imports and names it has; undefined while it doesn't parse. */
  const now = () => {
    const source = handle.doc()?.content ?? "";
    try {
      const analysis = analyze(source);
      return { source, analysis, statements: documentStatements(source, analysis.program), taken: namesIn(analysis) };
    } catch {
      editor.setNotice("The code doesn't parse.");
      return undefined;
    }
  };

  /** A document's title for messages and names: the drag's name for it, else its own. */
  const titleOf = (url: string, name?: string) => name ?? props.info(docOf(url) ?? url).title;
  /** The base of an import's name: the title, without a file's extension, or the last key of the path a URL names. */
  const baseName = (url: string, value: unknown, name?: string) => {
    const path = valuePath(url);
    const key = path?.findLast((p) => typeof p === "string");
    if (key !== undefined) return key;
    const title = titleOf(url, name);
    const extension = isFile(value) && typeof value.extension === "string" ? `.${value.extension.replace(/^\./, "")}` : undefined;
    return extension && title.toLowerCase().endsWith(extension.toLowerCase()) ? title.slice(0, -extension.length) : title;
  };

  /** A document as it is now: its value, at its URL's path, and its current version. */
  const load = async (url: AutomergeUrl): Promise<{ value: unknown; root: unknown; heads: UrlHeads }> => {
    const repo = globalThis.repo;
    const doc = docOf(url);
    if (!repo || !doc) throw new Error(repo ? "it isn't a valid automerge URL" : "documents can only be read in Patchwork");
    const root = await repo.find<unknown>((headsOf(url) ? withHeads(doc, headsOf(url)!) : doc) as AutomergeUrl);
    const value = withoutHeads(url) === doc ? root.doc() : (await repo.find<unknown>(url)).doc();
    return { value, root: root.doc(), heads: root.heads() };
  };

  /** The specifier a JS file `doc` is imported with: the model's import of it, else its current version, as Import pins code. */
  const codeSpecifier = async (doc: AutomergeUrl) => {
    const existing = now()?.statements.find((s) => s.id === documentId(doc, undefined) && s.type === undefined)?.specifier;
    return existing ?? withHeads(doc, (await load(doc)).heads);
  };
  const exportsOf = async (doc: AutomergeUrl) => {
    const specifier = await codeSpecifier(doc);
    return props.model.engine.exports(specifier, await props.model.imports(`import * as module from ${JSON.stringify(specifier)};`));
  };

  /** Selects `item` in the same batch as `edits` are made, so that it is there when the selection is checked. */
  const write = (edits: Edit[], select: Parameters<Editor["select"]>[0]) =>
    batch(() => {
      apply(handle, edits);
      editor.select(select, "dialog");
    });

  /**
   * Imports documents as Import does (research/21, "Dropping, pasting, inserting"): each one in the
   * first way it can be imported as a value, code pinned to its current version and everything else
   * following, named after its title, in one change; one imported in the same way already is not
   * imported again. The first one is selected.
   */
  const importDocuments = async (docs: readonly DroppedDocument[]) => {
    const loaded = await Promise.all(docs.map(async (d) => ({ ...d, ...(await load(d.url).catch((error: unknown) => ({ problem: String((error as Error)?.message ?? error) }))) })));
    const code = now();
    if (!code) return;
    const taken = new Set(code.taken);
    const imports: NewImport[] = [];
    const problems: string[] = [];
    let first: string | undefined;
    for (const d of loaded) {
      const title = titleOf(d.url, d.name);
      if ("problem" in d) {
        problems.push(`${title} can't be imported: ${d.problem}`);
        continue;
      }
      const local = importName(baseName(d.url, d.value, d.name), taken);
      const i = defaultImport(d.url, d.value, d.heads, local);
      if (!i) {
        const model = (d.value as { "@patchwork"?: { type?: unknown } } | undefined)?.["@patchwork"]?.type === "cad-model";
        problems.push(model ? `${title} is a CAD model, and models can't be imported yet` : `${title} can't be imported`);
        continue;
      }
      const id = documentId(i.specifier, i.type);
      if (!code.statements.some((s) => s.id === id) && !imports.some((x) => documentId(x.specifier, x.type) === id)) {
        taken.add(local);
        imports.push(i);
      }
      first ??= id;
    }
    if (first) write(insertImports(code.source, code.analysis.program, imports), { kind: "document", id: first });
    editor.setNotice(problems.length ? `${problems.join("; ")}.` : undefined);
  };

  /**
   * Shows document `url`, whose value is `value`, as an annotation pinned to `anchor`, or to the
   * model as a whole, and selects its row; one of the same document on the same place already is
   * selected instead. A CAD model is shown in the viewer, as the editor has no place in a popover;
   * this model can't annotate itself.
   */
  const annotate = (url: AutomergeUrl, anchor: CadAnchor | undefined, value: unknown) => {
    const doc = withoutHeads(url);
    if (docOf(url) === docOf(handle.url)) return editor.setNotice("A model can't annotate itself.");
    // A place by its name: Automerge may give a reference's keys in another order than the worker.
    const place = (anchor: CadAnchor | undefined) => anchor?.entityName ?? anchor?.feature ?? "";
    const same = props.annotations.list().find((a) => withoutHeads(a.doc) === doc && place(a.anchor) === place(anchor));
    const model = (value as { "@patchwork"?: { type?: unknown } } | undefined)?.["@patchwork"]?.type === "cad-model";
    const id = same?.id ?? props.annotations.add(url, anchor, model ? VIEWER_TOOL_ID : undefined);
    editor.select({ kind: "document", id: annotationRowId(id) }, "dialog");
    editor.setNotice(undefined);
  };

  /** A face's anchor, as a comment on it has: its feature, statement and reference (research/13). */
  const faceAnchor = async (face: Entity): Promise<CadAnchor | undefined> => {
    const { code, ref } = await props.model.engine.pick(face.body, "face", face.index).catch(() => ({ code: "", ref: undefined }));
    return ref && code ? props.anchorOf(face, ref, code) : undefined;
  };

  /**
   * A document dropped on a face: Annotation if it is preselected, written at once; otherwise the
   * document waits, and keeps the face for when Annotation is chosen.
   */
  const dropOnFace = async (d: DroppedDocument, face: Entity) => {
    const doc = docOf(d.url);
    if (!doc) return;
    const [anchor, loaded] = await Promise.all([faceAnchor(face), load(d.url).catch(() => undefined)]);
    if (withoutHeads(d.url) === doc && preselects({ kind: "face" }, loaded?.value) === "annotation") return annotate(d.url, anchor, loaded?.value);
    begin(d.url, undefined, "view", d.name, anchor);
  };

  /**
   * Uses the value at `path` of document `doc` (research/21, "Dropping, pasting, inserting"): a
   * configuration's value links to it, a feature's argument or a parameter's default becomes the
   * expression that reads it, with its import, in one change; without a field, only the import is
   * written. The field's owner is selected again, or else the document's row. `doc` may have heads,
   * which a new import of it keeps; `js` says it is a JS file, whose values are its exports'.
   */
  const useValue = (doc: AutomergeUrl, path: ValuePath, file: boolean, base: string, target: ValueTarget | undefined, link?: AutomergeUrl, js = false) => {
    if (target?.kind === "override") {
      if (file && !link) return editor.setNotice(pickProblem(titleOf(doc), { status: "ready", value: props.info(docOf(doc) ?? doc).value }, target, undefined));
      props.params.configurations.setValues(target.configuration, { [target.key]: { link: link ?? valueUrl(doc, path) } });
      editor.select({ kind: "configuration", id: target.configuration }, "dialog");
      return editor.setNotice(undefined);
    }
    const code = now();
    if (!code) return;
    const ref = valueReference(code.statements, code.taken, doc, path, file ? undefined : valueUrl(doc, path), base, js);
    const edits = insertImports(code.source, code.analysis.program, ref.imports);
    if (!target) return write(edits, { kind: "document", id: ref.id });
    if (target.kind === "default") {
      const set = setDefault(code.source, parameters(code.source, code.analysis), target.key, ref.expression);
      if ("error" in set) return editor.setNotice(`The default of ${target.key} can't be set: ${set.error}.`);
      return write([...edits, ...set.edits], { kind: "params" });
    }
    const entry = timeline(code.source, code.analysis, []).entries.find((e) => e.kind === "feature" && e.name === target.feature);
    if (entry?.kind !== "feature") return editor.setNotice(`${target.feature} is gone.`);
    const all = [...edits, ...setProp(entry.call, target.param, ref.expression)];
    let after;
    try {
      after = analyze(applyToText(code.source, all));
    } catch {
      return editor.setNotice("That would break the code.");
    }
    const index = timeline(applyToText(code.source, all), after, []).entries.findIndex((e) => e.kind === "feature" && e.name === target.feature);
    batch(() => {
      apply(handle, all);
      editor.select({ kind: "entry", index }, "dialog");
    });
    editor.setNotice(undefined);
  };

  /**
   * A document dropped on a number field: a URL that names a number is used at once (for a link, a
   * number in text, too, as a pasted one is, research/17); otherwise the document waits, and its
   * preview picks the value.
   */
  const dropValue = async (d: DroppedDocument, target: ValueTarget) => {
    const doc = docOf(d.url);
    if (!doc) return;
    if (withoutHeads(d.url) !== doc) {
      const loaded = await load(d.url).catch(() => undefined);
      const path = valuePath(d.url);
      if (loaded && target.kind === "override" && resolvedFrom(loaded.value).value !== undefined) return useValue(doc, path ?? [], false, "", target, d.url);
      if (loaded && path && typeof loaded.value === "number") return useValue(doc, path, isFile(loaded.root), baseName(d.url, loaded.root, d.name), target);
    }
    begin(d.url, target, "view", d.name);
  };

  const documentOf = (p: PendingInsert) => {
    const doc = p.url && docOf(p.url);
    if (!p.url || !doc) return undefined;
    const info = props.info(doc);
    // A URL with a path names a value inside the document; one with a cursor range has no value a preview can show.
    const path = withoutHeads(p.url) === doc ? [] : valuePath(p.url);
    return { doc, info, value: path ? valueAt(info.value, path) : undefined, file: isFile(info.value), path };
  };

  /** The row of an import of `url`'s document and path, whatever its version and type: dropped again, it is selected. */
  const importedRow = (url: string) => props.documents.rows().find((r) => r.role === "import" && withoutHeads(r.specifier) === withoutHeads(url));

  // Drags (research/21, "Dropping, pasting, inserting"). A drag that starts in this window says what
  // it carries at its start, which drops on this editor can't read before the drop; one from another
  // window or application only says its types until then. A drag that starts in this editor is its
  // own, which it refuses, unless it is of a document row (`data-drag="document"`), which drops here
  // as any document does.
  let drag: { own: boolean; docs: DroppedDocument[] } | undefined;
  const onDragStart = (event: DragEvent) => {
    const path = event.composedPath();
    const row = path.some((n) => n instanceof Element && n.getAttribute("data-drag") === "document");
    drag = { own: path.includes(element) && !row, docs: event.dataTransfer ? droppedDocuments(event.dataTransfer) : [] };
  };
  const [status, setStatus] = createSignal<string>();
  const [dragging, setDragging] = createSignal(false);
  const [dropFace, setDropFace] = createSignal<Entity>();
  let highlighted: Element | undefined;
  const highlight = (target: Element | undefined) => {
    if (highlighted === target) return;
    highlighted?.removeAttribute("data-drop-target");
    highlighted = target;
    target?.setAttribute("data-drop-target", "true");
  };
  let leaving: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    clearTimeout(leaving);
    highlight(undefined);
    batch(() => {
      setStatus(undefined);
      setDragging(false);
      setDropFace(undefined);
    });
  };
  const onDragEnd = () => {
    drag = undefined;
    end();
  };

  /** What `event` is over: nothing of this editor's (another tool's view, e.g. a comment thread), or a target. */
  const targetOf = (event: Event): DropTarget | undefined => {
    let input = false;
    for (const node of event.composedPath()) {
      if (node === element) break;
      if (!(node instanceof Element)) continue;
      // Another tool's view takes its own drops, e.g. a comment's draft (research/21).
      if (node.localName === "patchwork-view") return undefined;
      const kind = node.getAttribute("data-drop");
      if (kind === "value") {
        const target = JSON.parse(node.getAttribute("data-drop-value") ?? "null") as ValueTarget | null;
        return target && !node.querySelector("input:disabled") ? { kind: "value", element: node, target } : { kind: "refuse", element: undefined };
      }
      if (kind === "document") return { kind: "document", element: node };
      if (kind === "import" || kind === "insert") return input ? { kind: "refuse", element: undefined } : { kind, element: node };
      if (node.matches("input, textarea, select")) input = true;
      // A face of the model, which a document is pinned to (research/21, "Annotation").
      if (node.matches(".cad-model__viewer > canvas") && event instanceof MouseEvent) {
        const face = props.faceAt(event.clientX, event.clientY);
        if (face) return { kind: "face", element: node, face };
      }
    }
    return input ? { kind: "refuse", element: undefined } : { kind: "insert", element: undefined };
  };

  /** What a drop of `docs` on `target` does, for the status bar; `docs` is empty while they aren't known. */
  const describe = (target: DropTarget, docs: readonly DroppedDocument[]): string | undefined => {
    const first = docs[0];
    const title = first ? titleOf(first.url, first.name) : "a document";
    const others = docs.length > 1 ? `; ${docs.length - 1 === 1 ? "the other document is" : `the other ${docs.length - 1} documents are`} left out` : "";
    const imported = docs.length > 0 && docs.every((d) => importedRow(d.url));
    if (target.kind === "import") return imported ? `Select ${title}` : docs.length > 1 ? `Import ${title} and ${docs.length - 1} more` : `Import ${title}`;
    if (target.kind === "value") return (target.target.kind === "override" ? `Link ${title} to ${target.target.key}` : `Use ${title} for ${targetLabel(target.target)}`) + others;
    if (target.kind === "document") return (pending() ? `Insert ${title}` : `Replace with ${title}`) + others;
    if (target.kind === "insert") return `Insert ${title}${others}`;
    if (target.kind === "face") return `${!first || preselects(target, props.info(docOf(first.url) ?? first.url).value) === "annotation" ? "Pin" : "Insert"} ${title} to the face${others}`;
    return undefined;
  };

  /**
   * Whether a drag is one this editor takes, and how it knows: Patchwork's own types, or text that
   * may hold URLs from elsewhere, which is accepted only where it isn't text. Files from the desktop
   * are Patchwork's (the sidebar makes documents of them); this editor's own drags, e.g. of a named
   * view, insert nothing in it.
   */
  const kindOf = (event: DragEvent): "own" | "documents" | "text" | undefined => {
    const types = [...(event.dataTransfer?.types ?? [])];
    if (drag?.own) return isPatchworkDrag(types) ? "own" : undefined;
    if (isPatchworkDrag(types) || (drag?.docs.length && !types.includes("Files"))) return "documents";
    return mayCarryDocuments(types) ? "text" : undefined;
  };

  const onDragOver = (event: DragEvent) => {
    const kind = kindOf(event);
    if (!kind || !event.dataTransfer) return;
    const target = targetOf(event);
    if (!target) return end();
    const takes = kind === "documents" ? target.kind !== "refuse" : kind === "text" && (target.kind === "insert" || target.kind === "face" || target.kind === "value" || target.kind === "document") && !target.element?.closest("[data-drop=import]");
    if (kind === "text" && !takes) return;
    // Accepted, or refused so that no field or the code pane takes the URL as text.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = takes ? dropEffect(event.dataTransfer.effectAllowed) : "none";
    clearTimeout(leaving);
    if (kind !== "documents") return;
    // Over a face, the face is highlighted, not the view.
    highlight(takes && target.kind !== "face" ? (target.element ?? (event.composedPath().find((n) => n instanceof Element && n.matches(".cad-editor__stage, .cad-editor__browser")) as Element | undefined)) : undefined);
    batch(() => {
      const face = takes && target.kind === "face" ? target.face : undefined;
      if (JSON.stringify(face) !== JSON.stringify(dropFace())) setDropFace(face);
      setDragging(true);
      setStatus(takes ? describe(target, drag?.docs ?? []) : undefined);
    });
  };
  const onDragLeave = () => {
    clearTimeout(leaving);
    leaving = setTimeout(end, LEAVE_MS);
  };
  const onDrop = (event: DragEvent) => {
    const kind = kindOf(event);
    const target = kind && kind !== "own" ? targetOf(event) : undefined;
    end();
    if (!kind || !event.dataTransfer || (kind !== "own" && !target)) return;
    event.preventDefault();
    event.stopPropagation();
    drag = undefined;
    if (!target || target.kind === "refuse") return;
    const docs = droppedDocuments(event.dataTransfer);
    const first = docs[0];
    if (!first) return;
    const others = docs.length > 1 ? `Only ${titleOf(first.url, first.name)} is inserted; ${docs.length - 1 === 1 ? "the other document is" : `the other ${docs.length - 1} documents are`} left out.` : undefined;
    if (target.kind === "import") return void importDocuments(docs);
    editor.setNotice(others);
    if (target.kind === "value") return void dropValue(first, target.target);
    if (target.kind === "face") return void dropOnFace(first, target.face);
    if (target.kind === "document") {
      const s = editor.selection();
      if (s?.kind === "document") {
        const row = props.documents.rows().find((r) => r.id === s.id);
        if (row) editor.setNotice(props.documents.replace(row, first.url));
        return;
      }
      const p = pending();
      if (p) return void setPending({ ...p, url: first.url, name: first.name });
    }
    // Imported already or not, it waits: it may be an annotation, and Import of an imported one selects its row.
    begin(first.url, undefined, "view", first.name);
  };

  // Pasting a URL into the view, the browser or the timeline is a drop there; in a field, the code
  // pane, a dialog or another tool's view, a paste is text.
  const onPaste = (event: ClipboardEvent) => {
    for (const node of event.composedPath()) {
      if (node === element) break;
      if (node instanceof Element && (node.localName === "patchwork-view" || node.matches("input, textarea, select, [contenteditable], .cad-editor__dialog, .cad-editor__code"))) return;
    }
    const urls = documentsInText(event.clipboardData?.getData("text/plain") ?? "");
    const first = urls[0];
    if (!first) return;
    event.preventDefault();
    begin(first, undefined, "view");
    editor.setNotice(urls.length > 1 ? `Only ${titleOf(first)} is inserted; the others are left out.` : undefined);
  };

  document.addEventListener("dragstart", onDragStart);
  document.addEventListener("dragend", onDragEnd, true);
  element.addEventListener("dragenter", onDragOver, true);
  element.addEventListener("dragover", onDragOver, true);
  element.addEventListener("dragleave", onDragLeave, true);
  element.addEventListener("drop", onDrop, true);
  element.addEventListener("paste", onPaste);
  onCleanup(() => {
    end();
    document.removeEventListener("dragstart", onDragStart);
    document.removeEventListener("dragend", onDragEnd, true);
    element.removeEventListener("dragenter", onDragOver, true);
    element.removeEventListener("dragover", onDragOver, true);
    element.removeEventListener("dragleave", onDragLeave, true);
    element.removeEventListener("drop", onDrop, true);
    element.removeEventListener("paste", onPaste);
  });

  return {
    pending,
    status,
    dragging,
    dropFace,
    begin,
    setDocument(text) {
      const p = pending();
      const url = documentsInText(text)[0];
      if (!url) return `${text} isn't an automerge URL`;
      if (p) setPending({ ...p, url, name: undefined });
      return undefined;
    },
    async choose(role) {
      const p = pending();
      if (!p?.url) return;
      if (role === "annotation") return annotate(p.url, p.anchor, documentOf(p)?.info.value);
      await importDocuments([{ url: p.url, ...(p.name ? { name: p.name } : {}) }]);
    },
    async pick(path) {
      const p = pending();
      const d = p && documentOf(p);
      if (!p || !d) return;
      const js = !d.path?.length && isFile(d.info.value) && fileKind(d.info.value) === "js";
      useValue(js ? ((await codeSpecifier(d.doc)) as AutomergeUrl) : d.doc, [...(d.path ?? []), ...path], d.file, baseName(p.url!, d.info.value, p.name), p.target, undefined, js);
    },
    documentOf,
    targetLabel,
    exportsOf,
  };
}
