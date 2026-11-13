/**
 * The documents a model refers to, as the editor's documents list and document dialog show and edit
 * them (research/21, "The documents list", "The document dialog"): the documents the code imports,
 * those imported JS files import, and those configurations link values to, each with its title, its
 * state, what uses it, and the edits of its import as splices of the code; and the documents shown as
 * annotations (research/21, "Annotation"), whose edits are of the `cad` field.
 */
import { batch, createMemo, type Accessor } from "solid-js";
import type { AutomergeUrl, DocHandle, UrlHeads } from "@automerge/automerge-repo";
import { moduleKey, type ImportedModule, type ImportType } from "../../kernel/imports.ts";
import { analyze } from "../../model/analyze.ts";
import { isLinked } from "../../model/configurations.ts";
import { documentId, documentStatements, follow as followEdits, pin as pinEdits, removeStatement, renameImport, replaceDocument, setType as setTypeEdits, usedAnywhere, type DocumentStatement } from "../../model/documents.ts";
import { apply } from "../../model/splice.ts";
import type { Annotation, CadModelDoc, Configuration } from "../../types.ts";
import type { AnnotationStore } from "../annotations.tsx";
import type { HeldDocument, Model } from "../createModel.ts";
import type { DocumentInfo } from "../documentInfo.ts";
import { docOf, headsOf, importKinds, sameHeads, withHeads, withoutHeads } from "../imports.ts";
import type { Editor } from "./state.ts";

/** How a document enters the model: imported by its code, by an imported JS file, linked to by a configuration's value, or shown as an annotation. */
export type DocumentRole = "import" | "indirect" | "link" | "annotation";

export interface DocumentRow {
  /** Its id as the selection names it: `documentId` for an import, the URL `as link` for a linked value's document, `annotationRowId` for an annotation. */
  id: string;
  role: DocumentRole;
  /** The specifier as the code has it, with heads if it is pinned. */
  specifier: string;
  /** The document, without a path or heads. */
  doc: string | undefined;
  /** The path inside it the URL names, if any. */
  path: string | undefined;
  type: ImportType | undefined;
  /** The heads it is pinned to. */
  pinned: UrlHeads | undefined;
  statements: DocumentStatement[];
  /** The module the shown build made of it. */
  module: ImportedModule | undefined;
  held: HeldDocument | undefined;
  /** The timeline entries that use it, whether the parameters do, and the configurations whose values link to it with their keys. */
  users: { entries: number[]; params: boolean; configurations: { id: string; name: string; keys: string[] }[] };
  /** For an indirect document, the id of the JS file's row that imports it. */
  via: string | undefined;
  /** For an annotation, the annotation. */
  annotation?: Annotation;
}

/** The selection's id of an annotation's row: one row per annotation, as a document may be pinned to several places. */
export const annotationRowId = (id: string) => `annotation:${id}`;

/** A row's state, as its icon and tooltip show it (research/21, "The documents list"). */
export type DocumentState = "following" | "pinned" | "newer" | "unavailable" | "held";

/** How the dialog's As offers a document to the model (research/21, "The document dialog"). */
export type As = "data" | "code" | "text" | "bytes";

/**
 * What dragging a row carries (research/21, "The documents list"): the document with the path its
 * import names, without heads, so that a drop elsewhere in Patchwork shows the document as it is now,
 * as the row's title does, and a drop on this model's fields finds its import, whose id has no heads
 * either; a linked value's document without the path, so that a drop on a field offers its values.
 */
export const rowDragUrl = (row: Pick<DocumentRow, "role" | "specifier">): AutomergeUrl | undefined => {
  const doc = docOf(row.specifier);
  if (!doc) return undefined;
  return row.role === "link" ? doc : (withoutHeads(row.specifier) as AutomergeUrl);
};

export interface Documents {
  rows: Accessor<DocumentRow[]>;
  info(row: DocumentRow): DocumentInfo;
  /** The row's title: the document's, and the path it names after it. */
  title(row: DocumentRow): string;
  state(row: DocumentRow): { state: DocumentState; icon: string; label: string };
  /** The version the model is built with, for Pin: the lock it is held back at, or the version the shown build read. */
  builtWith(row: DocumentRow): UrlHeads | undefined;
  /** The ways the document can be imported, and the current one. */
  kinds(row: DocumentRow): As[];
  as(row: DocumentRow): As;
  /** Whether nothing uses it, so that Remove may delete its imports. */
  removable(row: DocumentRow): boolean;
  open(row: DocumentRow): void;
  /** Shows an annotation's document next to its pin. */
  show(row: DocumentRow): void;
  pin(row: DocumentRow): void;
  follow(row: DocumentRow): void;
  /** Pins a pinned document to its current version. */
  update(row: DocumentRow): void;
  setAs(row: DocumentRow, as: As): void;
  /** Replaces the document by a pasted URL; says why not. */
  replace(row: DocumentRow, url: string): string | undefined;
  remove(row: DocumentRow): void;
  rename(row: DocumentRow, to: string): Promise<string | undefined>;
}

const TYPE_OF: Record<As, ImportType | undefined> = { data: undefined, code: undefined, text: "text", bytes: "bytes" };

/** The path a specifier names in its document, `/a/b`, if any. */
const pathOf = (specifier: string) => {
  const rest = withoutHeads(specifier).slice((docOf(specifier) ?? "").length);
  return rest.startsWith("/") && rest.length > 1 ? rest : undefined;
};

export function createDocuments(props: { handle: DocHandle<CadModelDoc>; editor: Editor; model: Model; configurations: Accessor<Configuration[]>; annotations: AnnotationStore; onShow: (annotation: string) => void; info: (url: string) => DocumentInfo; element: HTMLElement }): Documents {
  const { handle, editor, model } = props;
  const rows = createMemo<DocumentRow[]>(() => {
    const shown = model.documents();
    const held = model.held();
    const module = (key: string) => shown.find((d) => d.key === key)?.module;
    const out: DocumentRow[] = editor.documents().map((d) => {
      const first = d.statements[0]!;
      const doc = docOf(first.specifier);
      return {
        id: d.id,
        role: "import",
        specifier: first.specifier,
        doc,
        path: pathOf(first.specifier),
        type: first.type,
        pinned: headsOf(first.specifier),
        statements: d.statements,
        module: module(moduleKey(first.specifier, first.type)),
        held: headsOf(first.specifier) ? undefined : held.find((h) => h.doc === doc),
        users: { ...d.users, configurations: [] },
        via: undefined,
      };
    });
    const ids = new Set(out.map((r) => r.id));
    for (const d of shown) {
      const id = documentId(d.specifier, d.type);
      if (d.via === undefined || ids.has(id)) continue;
      ids.add(id);
      const via = shown.find((v) => v.key === d.via);
      out.push({
        id,
        role: "indirect",
        specifier: d.specifier,
        doc: d.doc,
        path: pathOf(d.specifier),
        type: d.type,
        pinned: headsOf(d.specifier),
        statements: [],
        module: d.module,
        held: headsOf(d.specifier) ? undefined : held.find((h) => h.doc === d.doc),
        users: { entries: [], params: false, configurations: [] },
        via: via ? documentId(via.specifier, via.type) : undefined,
      });
    }
    const links = new Map<string, DocumentRow>();
    for (const c of props.configurations()) {
      for (const [key, value] of Object.entries(c.params)) {
        if (!isLinked(value)) continue;
        const url = withoutHeads(value.link);
        let row = links.get(url);
        if (!row) {
          row = { id: `${url} as link`, role: "link", specifier: value.link, doc: docOf(url), path: pathOf(url), type: undefined, pinned: headsOf(value.link), statements: [], module: undefined, held: undefined, users: { entries: [], params: false, configurations: [] }, via: undefined };
          links.set(url, row);
        }
        const users = row.users.configurations;
        const user = users.find((u) => u.id === c.id) ?? (users.push({ id: c.id, name: c.name, keys: [] }), users[users.length - 1]!);
        user.keys.push(key);
      }
    }
    const annotated = props.annotations.list().map(
      (a): DocumentRow => ({ id: annotationRowId(a.id), role: "annotation", specifier: a.doc, doc: docOf(a.doc), path: undefined, type: undefined, pinned: headsOf(a.doc), statements: [], module: undefined, held: undefined, users: { entries: [], params: false, configurations: [] }, via: undefined, annotation: a }),
    );
    return [...out, ...links.values(), ...annotated];
  });

  const info = (row: DocumentRow): DocumentInfo => (row.doc ? props.info(row.doc) : { status: "unavailable", title: row.specifier, icon: "File", datatype: undefined, heads: undefined, value: undefined, problem: "it isn't a valid automerge URL" });
  const title = (row: DocumentRow) => info(row).title;

  const state = (row: DocumentRow): { state: DocumentState; icon: string; label: string } => {
    const i = info(row);
    const problem = row.module?.kind === "problem" ? row.module.problem : i.status === "unavailable" ? i.problem : undefined;
    if (problem) return { state: "unavailable", icon: "TriangleAlert", label: `Unavailable: ${problem}` };
    if (row.held) return { state: "held", icon: "Lock", label: `Held back at the version the model last built with; the newer version brings: ${row.held.errors.join("; ")}` };
    if (row.pinned) return sameHeads(row.pinned, i.heads) || !i.heads ? { state: "pinned", icon: "Pin", label: "Pinned to a version" } : { state: "newer", icon: "Dot", label: "Pinned; a newer version is available" };
    return { state: "following", icon: "Link", label: "Following its latest version" };
  };

  const builtWith = (row: DocumentRow): UrlHeads | undefined => {
    if (row.pinned) return row.pinned;
    // An annotation is shown as it is now.
    if (row.role === "annotation") return info(row).heads;
    if (row.held) return row.held.locked;
    return model.documents().find((d) => d.doc === row.doc && !headsOf(d.specifier))?.heads ?? info(row).heads;
  };

  /** The code now, its statements, and the edits of `make` applied in one change. */
  const edit = (make: (source: string, statements: DocumentStatement[]) => ReturnType<typeof pinEdits>): boolean => {
    const source = handle.doc()?.content ?? "";
    let program;
    try {
      program = analyze(source).program;
    } catch {
      editor.setNotice("The code doesn't parse.");
      return false;
    }
    const edits = make(source, documentStatements(source, program));
    apply(handle, edits);
    return edits.length > 0;
  };
  const kinds = (row: DocumentRow): As[] => (row.path ? ["data"] : importKinds(info(row).value));
  const as = (row: DocumentRow): As => (row.type === "text" || row.type === "bytes" ? row.type : row.module?.kind === "js" || kinds(row).includes("code") ? "code" : "data");
  /**
   * Edits the row's imports so that its id becomes `id`, keeping it selected if it is: in one batch,
   * or the selection would be cleared as soon as the old id is gone.
   */
  const reidentify = (row: DocumentRow, id: string, make: Parameters<typeof edit>[0]) => {
    const selected = editor.isSelected({ kind: "document", id: row.id });
    batch(() => {
      if (edit(make) && selected) editor.select({ kind: "document", id }, "dialog");
    });
  };

  return {
    rows,
    info,
    title,
    state,
    builtWith,
    kinds,
    as,
    removable: (row) => {
      if (row.role === "annotation") return true;
      const a = editor.analysis();
      return row.role === "import" && !!a && row.statements.every((s) => !usedAnywhere(a.program, s));
    },
    show: (row) => row.annotation && props.onShow(row.annotation.id),
    open(row) {
      if (row.doc) props.element.dispatchEvent(new CustomEvent("patchwork:open-document", { detail: { url: row.doc }, bubbles: true, composed: true }));
    },
    pin(row) {
      const heads = builtWith(row);
      if (heads && row.annotation) props.annotations.setDoc(row.annotation.id, withHeads(row.annotation.doc, heads) as AutomergeUrl);
      else if (heads && row.role === "import") edit((source, s) => pinEdits(source, s, row.id, heads));
    },
    follow(row) {
      if (row.annotation) props.annotations.setDoc(row.annotation.id, withoutHeads(row.annotation.doc) as AutomergeUrl);
      else if (row.role === "import") edit((source, s) => followEdits(source, s, row.id));
    },
    update(row) {
      const heads = info(row).heads;
      if (heads && row.annotation) props.annotations.setDoc(row.annotation.id, withHeads(row.annotation.doc, heads) as AutomergeUrl);
      else if (heads && row.role === "import") edit((source, s) => pinEdits(source, s, row.id, heads));
    },
    setAs(row, to) {
      const type = row.type === "json" && to === "data" ? "json" : TYPE_OF[to];
      if (row.role !== "import" || type === row.type) return;
      reidentify(row, documentId(row.specifier, type), (_, s) => setTypeEdits(s, row.id, type));
    },
    replace(row, url) {
      const next = url.trim();
      if (!docOf(next)) return `${next} isn't an automerge URL`;
      if (row.annotation) {
        if (next !== row.annotation.doc) props.annotations.setDoc(row.annotation.id, next as AutomergeUrl);
        return undefined;
      }
      if (next === row.specifier || row.role !== "import") return undefined;
      reidentify(row, documentId(next, row.type), (source, s) => replaceDocument(source, s, row.id, next));
      return undefined;
    },
    remove(row) {
      if (row.annotation) {
        if (editor.isSelected({ kind: "document", id: row.id })) editor.select(undefined, "dialog");
        props.annotations.remove(row.annotation.id);
        return;
      }
      if (row.role !== "import") return;
      if (editor.isSelected({ kind: "document", id: row.id })) editor.select(undefined, "dialog");
      edit((source, s) => s.filter((x) => x.id === row.id && x.node.type === "ImportDeclaration").flatMap((x) => removeStatement(source, x)));
    },
    async rename(row, to) {
      const source = handle.doc()?.content ?? "";
      let analysis;
      try {
        analysis = analyze(source);
      } catch {
        return "The code doesn't parse.";
      }
      const statement = documentStatements(source, analysis.program).find((s) => s.id === row.id && s.name !== undefined);
      if (!statement) return "The import has no single name.";
      const r = renameImport(analysis, statement, to);
      if ("error" in r) return `Renaming ${statement.name} to ${to} doesn't work: ${r.error}.`;
      apply(handle, r.edits);
      return undefined;
    },
  };
}
