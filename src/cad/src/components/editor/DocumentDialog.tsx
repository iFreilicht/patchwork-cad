import { createEffect, createMemo, createResource, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { parse } from "acorn";
import type { ImportedModule } from "../../kernel/imports.ts";
import { fileKind, fittingValues, importKinds, isFile, moduleOf, type ValuePath } from "../imports.ts";
import { Icon } from "../icons.tsx";
import { documentActions } from "./Browser.tsx";
import type { As, DocumentRow, Documents } from "./documents.ts";
import { PICK_LIMITS, pickProblem, ROLES, type Inserts, type PendingInsert } from "./inserts.ts";
import type { Editor } from "./state.ts";
import { PickButton } from "./FeatureDialog.tsx";
import { anchorLabel } from "../../model/annotations.ts";
import type { Annotation } from "../../types.ts";
import type { Annotations } from "../annotations.tsx";

/** What an annotation's fields offer and change (research/21, "The document dialog"). */
export interface AnnotationOptions {
  annotations: Annotations;
  /** The model's named views, Home first, which opening an annotation may go to. */
  views: { id: string; name: string }[];
  /** A tool's name by its id, as Patchwork's registry has it. */
  toolName(id: string): string;
  /** Goes to a named view by its id, or Home's. */
  goToView(id: string): void;
}

/** The pick targets of an annotation's anchor: a face or an edge picked in the view pins it there. */
export const ANCHOR_PICK = { face: "annotation-face", edge: "annotation-edge" } as const;

/**
 * An annotation's own fields: where it is pinned, a face or edge picked in the view, a feature or
 * the model; the tool the embed frame shows it with, which is picked there; and the named view
 * opening it goes to.
 */
function AnnotationFields(props: { annotation: Annotation; options: AnnotationOptions; editor: Editor }) {
  const a = () => props.annotation;
  const store = () => props.options.annotations;
  const placed = () => store().placed().find((p) => p.annotation.id === a().id);
  const features = () => props.editor.timeline().entries.flatMap((e) => (e.kind === "feature" ? [e] : []));
  const disabled = () => props.editor.syntaxError() !== undefined;
  const choose = (value: string) => {
    if (!value) return store().setAnchor(a().id, undefined);
    const entry = features().find((e) => e.name === value);
    if (entry) store().setAnchor(a().id, store().featureAnchor(entry));
  };
  return (
    <>
      <div class="cad-editor__field" data-param="anchor">
        <span>On</span>
        <div class="cad-editor__refs">
          <select class="cad-editor__input" aria-label="On" disabled={disabled()} onChange={(event) => choose(event.currentTarget.value)}>
            <option value="" selected={!a().anchor}>
              the model
            </option>
            <Show when={a().anchor?.entity}>
              <option value="#entity" selected>
                {anchorLabel(a())}
              </option>
            </Show>
            <Show when={a().anchor?.feature && !a().anchor?.entity && !features().some((e) => e.name === a().anchor?.feature)}>
              <option value="#gone" selected>
                {a().anchor?.feature}
              </option>
            </Show>
            <For each={features()}>
              {(e) => (
                <option value={e.name} selected={!a().anchor?.entity && a().anchor?.feature === e.name}>
                  {e.name}
                </option>
              )}
            </For>
          </select>
          <PickButton editor={props.editor} param={ANCHOR_PICK.face} kind="face" multi={false} disabled={disabled()} label="Select face" />
          <PickButton editor={props.editor} param={ANCHOR_PICK.edge} kind="edge" multi={false} disabled={disabled()} label="Select edge" />
          <Show when={placed()?.detached}>
            <span class="cad-editor__document-state" data-state="unavailable" title="Not found in the model" aria-label="Not found in the model" role="img">
              <Icon name="TriangleAlert" size={12} />
            </span>
          </Show>
        </div>
      </div>
      <div class="cad-editor__field" data-param="tool">
        <span>Tool</span>
        <div class="cad-editor__refs">
          <span>{a().tool ? props.options.toolName(a().tool!) : "Default"}</span>
          <Show when={a().tool}>
            <button class="cad-editor__button" title="Show it with its datatype's default tool" onClick={() => store().setTool(a().id, undefined)}>
              Reset
            </button>
          </Show>
        </div>
      </div>
      <div class="cad-editor__field" data-param="view">
        <span>View</span>
        <select
          class="cad-editor__input"
          aria-label="View"
          title="The named view opening it goes to"
          onChange={(event) => {
            const id = event.currentTarget.value || undefined;
            store().setView(a().id, id);
            // Chosen, it is shown, as a click on a view's row goes there.
            if (id) props.options.goToView(id);
          }}
        >
          <option value="" selected={!a().view}>
            none
          </option>
          <Show when={a().view && !props.options.views.some((v) => v.id === a().view)}>
            <option value={a().view} disabled selected>
              Deleted view
            </option>
          </Show>
          <For each={props.options.views}>
            {(v) => (
              <option value={v.id} selected={a().view === v.id}>
                {v.name}
              </option>
            )}
          </For>
        </select>
      </div>
    </>
  );
}

/** Caps of the preview, so that a large document stays cheap to show: keys per level, lines, characters, and bytes drawn as an image. */
const MAX_KEYS = 50;
const MAX_LINES = 8;
const MAX_CHARS = 160;
const MAX_IMAGE_BYTES = 8 * 2 ** 20;

const clip = (text: string) => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text);

/**
 * A field that commits on Enter or when it is left, e.g. a name or a URL; Escape restores it.
 * `commit` says why not, and the field keeps what was typed then.
 */
function CommitInput(props: { value: string; label: string; title?: string; disabled?: boolean; commit: (text: string) => Promise<string | undefined> | string | undefined; onNotice: (why: string | undefined) => void }) {
  let input!: HTMLInputElement;
  createEffect(() => {
    const value = props.value;
    if (document.activeElement !== input) input.value = value;
  });
  const commit = async () => {
    const text = input.value.trim();
    if (text === props.value) return;
    const why = await props.commit(text);
    props.onNotice(why);
  };
  return (
    <input
      ref={input}
      class="cad-editor__input"
      aria-label={props.label}
      title={props.title}
      spellcheck={false}
      disabled={props.disabled}
      onKeyDown={(event) => {
        if (event.key === "Enter") void commit();
        if (event.key === "Escape" && input.value !== props.value) {
          event.preventDefault();
          input.value = props.value;
        }
      }}
      onBlur={() => void commit()}
    />
  );
}

/** Which values of a data preview can be picked, and what a pick does (research/21, "Dropping, pasting, inserting"). */
interface Picker {
  fits(value: unknown): boolean;
  pick(path: ValuePath): void;
  /** Whether the branch at `path` leads to a value that fits, which opens it. */
  leads(path: ValuePath): boolean;
}

/**
 * One value of a data preview: a primitive, or a collapsed object or array that renders its keys
 * only when opened. With a picker, a value that fits is a button that picks it by its path.
 */
function DataNode(props: { name: string | undefined; value: unknown; path?: ValuePath; picker?: Picker | undefined; opened?: boolean }) {
  const [open, setOpen] = createSignal(props.opened || !!props.picker?.leads(props.path ?? []));
  const entries = () => Object.entries(props.value as object);
  const isObject = () => !!props.value && typeof props.value === "object";
  return (
    <Show
      when={isObject()}
      fallback={
        <li class="cad-editor__tree-leaf">
          <Show when={props.name !== undefined}>
            <span class="cad-editor__tree-key">{props.name}</span>{" "}
          </Show>
          <Show when={props.picker?.fits(props.value) && props.picker} fallback={<code>{clip(JSON.stringify(props.value) ?? "undefined")}</code>}>
            {(picker) => (
              <button class="cad-editor__tree-pick" title={`Use ${(props.path ?? []).join(".") || "it"}`} onClick={() => picker().pick(props.path ?? [])}>
                <code>{clip(JSON.stringify(props.value) ?? "undefined")}</code>
              </button>
            )}
          </Show>
        </li>
      }
    >
      <li>
        <details open={open()} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary data-leads={props.picker?.leads(props.path ?? []) ? "true" : undefined}>
            <Show when={props.name !== undefined}>
              <span class="cad-editor__tree-key">{props.name}</span>{" "}
            </Show>
            <span class="cad-editor__muted">{Array.isArray(props.value) ? `[${entries().length}]` : `{${entries().length}}`}</span>
          </summary>
          <Show when={open()}>
            <ul class="cad-editor__tree">
              <For each={entries().slice(0, MAX_KEYS)}>{([key, value]) => <DataNode name={key} value={value} path={[...(props.path ?? []), Array.isArray(props.value) ? Number(key) : key]} picker={props.picker} />}</For>
              <Show when={entries().length > MAX_KEYS}>
                <li class="cad-editor__muted">… {entries().length - MAX_KEYS} more</li>
              </Show>
            </ul>
          </Show>
        </details>
      </li>
    </Show>
  );
}

/** The names a JS module exports, `default` included. */
function exportedNames(code: string): string[] {
  try {
    const program = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    return program.body.flatMap((node): string[] => {
      if (node.type === "ExportDefaultDeclaration") return ["default"];
      if (node.type === "ExportAllDeclaration") return [node.exported ? (node.exported.type === "Identifier" ? node.exported.name : String(node.exported.value)) : "*"];
      if (node.type !== "ExportNamedDeclaration") return [];
      if (node.declaration?.type === "VariableDeclaration") return node.declaration.declarations.flatMap((d) => (d.id.type === "Identifier" ? [d.id.name] : []));
      if (node.declaration && "id" in node.declaration && node.declaration.id) return [node.declaration.id.name];
      return node.specifiers.map((s) => (s.exported.type === "Identifier" ? s.exported.name : String(s.exported.value)));
    });
  } catch {
    return [];
  }
}

/** A size in bytes, for people. */
const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);

/** What the model gets of a document (research/21, "The document dialog"): data as a tree, text as its first lines, bytes as their size and an image as itself, code as its exports. */
function Preview(props: { module: ImportedModule; mimeType: string | undefined; picker?: Picker | undefined }) {
  const image = createMemo(() => {
    const m = props.module;
    if (m.kind !== "bytes" || !props.mimeType?.startsWith("image/") || m.bytes.length > MAX_IMAGE_BYTES) return undefined;
    const url = URL.createObjectURL(new Blob([m.bytes as BlobPart], { type: props.mimeType }));
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  return (
    <div class="cad-editor__preview" data-kind={props.module.kind}>
      <Show when={props.module.kind === "data" && props.module}>
        {(m) => (
          <ul class="cad-editor__tree">
            {/* What a value is picked from starts open. */}
            <DataNode name={undefined} value={m().value} picker={props.picker} opened={!!props.picker} />
          </ul>
        )}
      </Show>
      <Show when={props.module.kind === "text" && props.module}>
        {(m) => {
          const lines = () => m().text.split("\n");
          return (
            <pre class="cad-editor__preview-text">
              {lines().slice(0, MAX_LINES).map(clip).join("\n")}
              {lines().length > MAX_LINES ? `\n… ${lines().length - MAX_LINES} more lines` : ""}
            </pre>
          );
        }}
      </Show>
      <Show when={props.module.kind === "bytes" && props.module}>
        {(m) => (
          <>
            <span class="cad-editor__muted">{size(m().bytes.length)}</span>
            <Show when={image()}>{(url) => <img class="cad-editor__preview-image" src={url()} alt="" />}</Show>
          </>
        )}
      </Show>
      <Show when={props.module.kind === "js" && props.module}>
        {(m) => (
          <div class="cad-editor__refs">
            <For each={exportedNames(m().code)} fallback={<span class="cad-editor__muted">no exports</span>}>
              {(name) => (
                <span class="cad-editor__version" data-kind="code">
                  <code>{name}</code>
                </span>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

const AS_LABELS: Record<As, string> = { data: "Data", code: "Code", text: "Text", bytes: "Bytes" };
const AS_TITLES: Record<As, string> = { data: "Its data, each key a named export", code: "Its code, run as a module", text: 'Its text, with { type: "text" }', bytes: 'Its bytes, with { type: "bytes" }' };

/**
 * The dialog of a document the model refers to (research/21, "The document dialog"): the document,
 * which opens it, and a field that takes another one's URL; for an import, what the model gets of
 * it (As, and a preview), its name and its version; and what uses it, each of which selects that.
 * Edits apply as they are made.
 */
export function DocumentDialog(props: { documents: Documents; row: DocumentRow; editor: Editor; annotation?: AnnotationOptions; onClose: () => void }) {
  const row = () => props.row;
  const info = () => props.documents.info(row());
  const state = () => props.documents.state(row());
  const own = () => row().role === "import";
  /** Its URL and version are the model's to change: an import's, or an annotation's. */
  const editable = () => own() || row().role === "annotation";
  const disabled = () => props.editor.syntaxError() !== undefined;
  const named = () => row().statements.flatMap((s) => s.named);
  const name = () => row().statements.find((s) => s.name !== undefined)?.name;
  const mimeType = () => {
    const v = info().value as { mimeType?: unknown } | undefined;
    return typeof v?.mimeType === "string" ? v.mimeType : undefined;
  };
  const entries = () => props.editor.timeline().entries;
  const userLabel = (index: number) => {
    const e = entries()[index];
    return !e ? "" : e.kind === "feature" ? e.name : `the Custom Script at lines ${e.lines.join("–")}`;
  };
  return (
    <section class="cad-editor__dialog" aria-label={`Document ${props.documents.title(row())}`} data-feature="document" data-document={row().id} data-role={row().role} data-state={state().state}>
      <header class="cad-editor__dialog-header">
        <strong>Document</strong> <span>{props.documents.title(row())}</span>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.onClose()}>
          ×
        </button>
      </header>
      <Show when={state().state === "unavailable" || state().state === "held"}>
        <p class="cad-editor__problem" data-status={state().state}>
          {state().label}
        </p>
      </Show>
      <div class="cad-editor__field" data-param="document">
        <span>Document</span>
        <div class="cad-editor__document-field" onPointerEnter={() => props.editor.setHoveredDocument(row().id)} onPointerLeave={() => props.editor.setHoveredDocument(undefined)}>
          <button class="cad-editor__button cad-editor__document-open" title={`Open ${props.documents.title(row())}${info().datatype ? ` (${info().datatype})` : ""}`} disabled={!row().doc} onClick={() => props.documents.open(row())}>
            <Icon name={info().icon} />
            <span>{props.documents.title(row())}</span>
            <Show when={row().path}>
              <span class="cad-editor__muted">{row().path}</span>
            </Show>
          </button>
          <Show when={editable()}>
            <CommitInput value={row().specifier.split("#", 1)[0]!} label="Document URL" title="Another document's automerge: URL replaces this one" disabled={disabled()} commit={(url) => props.documents.replace(row(), url)} onNotice={props.editor.setNotice} />
          </Show>
        </div>
      </div>
      <Show when={own() && props.documents.kinds(row()).length > 0}>
        <div class="cad-editor__field" data-param="as">
          <span>As</span>
          <div class="cad-editor__segmented" role="radiogroup" aria-label="As">
            <Index each={props.documents.kinds(row())}>
              {(kind) => (
                <button role="radio" class="cad-editor__segment" aria-checked={props.documents.as(row()) === kind()} disabled={disabled()} title={AS_TITLES[kind()]} onClick={() => props.documents.setAs(row(), kind())}>
                  {AS_LABELS[kind()]}
                </button>
              )}
            </Index>
          </div>
        </div>
      </Show>
      <Show when={row().module && row().module!.kind !== "problem" && row().module}>
        {(m) => (
          <div class="cad-editor__field" data-param="preview">
            <span>Preview</span>
            <Preview module={m()} mimeType={mimeType()} />
          </div>
        )}
      </Show>
      <Show when={own() && (name() !== undefined || named().length > 0)}>
        <div class="cad-editor__field" data-param="name">
          <span>Name</span>
          <div class="cad-editor__refs">
            <Show when={name()}>{(n) => <CommitInput value={n()} label="Name" disabled={disabled()} commit={(to) => props.documents.rename(row(), to)} onNotice={props.editor.setNotice} />}</Show>
            <For each={named()}>
              {(n) => (
                <span class="cad-editor__version" data-kind="name" title={n.imported === n.local ? n.local : `${n.imported} as ${n.local}`}>
                  <code>{n.imported === n.local ? n.local : `${n.imported} as ${n.local}`}</code>
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="cad-editor__field" data-param="version">
        <span>Version</span>
        <div class="cad-editor__refs">
          <div class="cad-editor__segmented" role="radiogroup" aria-label="Version">
            <button role="radio" class="cad-editor__segment" aria-checked={!row().pinned} disabled={!editable() || disabled()} title="Follow the document's latest version" onClick={() => props.documents.follow(row())}>
              Following
            </button>
            <button role="radio" class="cad-editor__segment" aria-checked={!!row().pinned} disabled={!editable() || disabled() || !props.documents.builtWith(row())} title="Pin the version the model is built with" onClick={() => !row().pinned && props.documents.pin(row())}>
              Pinned
            </button>
          </div>
          <Show when={state().state === "newer"}>
            <button class="cad-editor__button" disabled={!editable() || disabled()} title="Pin the document's latest version" onClick={() => props.documents.update(row())}>
              Update
            </button>
          </Show>
          <span class="cad-editor__document-state" data-state={state().state} title={state().label} aria-label={state().label} role="img">
            <Icon name={state().icon} size={12} />
          </span>
        </div>
      </div>
      <Show when={row().annotation && props.annotation && { annotation: row().annotation!, options: props.annotation }}>
        {(a) => <AnnotationFields annotation={a().annotation} options={a().options} editor={props.editor} />}
      </Show>
      <Show when={row().role !== "annotation"}>
        <div class="cad-editor__field" data-param="users">
          <span>Used by</span>
          <div class="cad-editor__refs">
            <For each={row().users.entries}>
              {(index) => (
                <button class="cad-editor__link" onClick={() => props.editor.select({ kind: "entry", index }, "dialog")}>
                  {userLabel(index)}
                </button>
              )}
            </For>
            <Show when={row().users.params}>
              <button class="cad-editor__link" onClick={() => props.editor.select({ kind: "params" }, "dialog")}>
                Parameters
              </button>
            </Show>
            <For each={row().users.configurations}>
              {(c) => (
                <button class="cad-editor__link" title={c.keys.join(", ")} onClick={() => props.editor.select({ kind: "configuration", id: c.id }, "dialog")}>
                  {c.name}: {c.keys.join(", ")}
                </button>
              )}
            </For>
            <Show when={row().role === "indirect" && row().via}>
              {(via) => {
                const parent = () => props.documents.rows().find((r) => r.id === via());
                return (
                  <Show when={parent()}>
                    {(p) => (
                      <button class="cad-editor__link" onClick={() => props.editor.select({ kind: "document", id: p().id }, "dialog")}>
                        {props.documents.title(p())}
                      </button>
                    )}
                  </Show>
                );
              }}
            </Show>
            <Show when={!row().users.entries.length && !row().users.params && !row().users.configurations.length && row().role !== "indirect"}>
              <span class="cad-editor__muted">nothing</span>
            </Show>
          </div>
        </div>
      </Show>
      <footer class="cad-editor__dialog-footer">
        <For each={documentActions(props.documents, row()).filter((a) => a.label === "Open" || a.label === "Show" || a.label === "Remove")}>
          {(action) => (
            <button class="cad-editor__button" classList={{ "cad-editor__button--danger": !!action.danger }} disabled={action.disabled || (action.label === "Remove" && disabled())} onClick={() => void action.run()}>
              {action.label}
            </button>
          )}
        </For>
      </footer>
    </section>
  );
}

/**
 * The document dialog of a pending insert (research/21, "The document dialog"): a document dropped,
 * pasted or given to "Insert" that waits for its role. "Use as" offers the roles the document allows,
 * none chosen, and nothing is written until one is, or a value of the preview is picked to import
 * only that. Dropped on a number field, the dialog is about a value for it alone: no "Use as", the
 * branches that lead to numbers open, a JS file's exports as its tree, and a problem line where
 * none can be picked. The document field takes a pasted URL or a drop.
 */
export function InsertDialog(props: { inserts: Inserts; pending: PendingInsert; editor: Editor; onOpen: (doc: string) => void; onClose: () => void }) {
  const inserted = () => props.inserts.documentOf(props.pending);
  const title = () => {
    const d = inserted();
    return d ? d.info.title + (d.path?.length ? `/${d.path.join("/")}` : "") : "";
  };
  const hasPath = () => !!inserted()?.path?.length;
  const disabled = () => props.editor.syntaxError() !== undefined;
  const roles = () => {
    const d = inserted();
    return d && d.info.status === "ready" ? ROLES.filter((r) => r.allows(d.info.value, hasPath())) : [];
  };
  const mimeType = () => {
    const v = inserted()?.info.value as { mimeType?: unknown } | undefined;
    return typeof v?.mimeType === "string" ? v.mimeType : undefined;
  };
  const target = () => props.pending.target;
  /** For a field, what a JS file exports, which it is run for: its numbers are what can be picked. */
  const runs = () => {
    const d = inserted();
    return target() && !hasPath() && d?.info.status === "ready" && isFile(d.info.value) && fileKind(d.info.value) === "js" ? { doc: d.doc, value: d.info.value } : undefined;
  };
  const [exported] = createResource(runs, ({ doc }) =>
    props.inserts.exportsOf(doc).then(
      (value): ImportedModule => ({ kind: "data", value }),
      (error: unknown): ImportedModule => ({ kind: "problem", problem: `running it failed: ${String((error as Error)?.message ?? error)}` }),
    ),
  );
  /** What the model gets of it, imported in the first way it can be, or for a field a JS file's exports: a data tree is what values are picked from. */
  const module = createMemo((): ImportedModule | undefined => {
    const d = inserted();
    if (!d || d.info.status !== "ready") return undefined;
    if (hasPath()) return d.value === undefined ? undefined : { kind: "data", value: d.value };
    // A resource keeps its last value when its source is gone, e.g. once another document is dropped.
    const exports = runs() && exported.state === "ready" ? exported() : undefined;
    if (exports) return exports;
    const as = importKinds(d.value)[0];
    return as ? moduleOf(d.value, as === "text" || as === "bytes" ? as : undefined, d.doc) : undefined;
  });
  const fits = (value: unknown) => (target() ? typeof value === "number" : value === null || typeof value !== "object");
  /** For a field, where the values that fit it are, within limits: the branches to them open. */
  const search = createMemo(() => {
    const m = module();
    return target() && m?.kind === "data" ? fittingValues(m.value, fits, PICK_LIMITS) : undefined;
  });
  const leading = createMemo(() => new Set((search()?.paths ?? []).flatMap((path) => path.map((_, i) => JSON.stringify(path.slice(0, i))))));
  /** For a field, why nothing can be picked, if nothing can. */
  const problem = () => {
    const d = inserted();
    const t = target();
    const m = module();
    if (!d || !t) return undefined;
    return pickProblem(title(), d.info, t, search()) ?? (m?.kind === "problem" ? `${title()} can't be used: ${m.problem}.` : undefined);
  };
  const picker = (): Picker | undefined => {
    const d = inserted();
    if (!d || disabled() || problem()) return undefined;
    return { fits, pick: (path) => void props.inserts.pick(path), leads: (path) => leading().has(JSON.stringify(path)) };
  };
  return (
    <section class="cad-editor__dialog" aria-label={`Insert ${title() || "a document"}`} data-feature="insert" data-insert={props.pending.url ?? ""} data-target={target()?.kind ?? ""}>
      <header class="cad-editor__dialog-header">
        <strong>Insert</strong> <span>{title()}</span>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.onClose()}>
          ×
        </button>
      </header>
      <Show when={!target() && inserted()?.info.status === "unavailable"}>
        <p class="cad-editor__problem" data-status="unavailable">
          Unavailable: {inserted()?.info.problem}
        </p>
      </Show>
      <Show when={problem()}>
        {(why) => (
          <p class="cad-editor__problem" data-status="unpickable">
            {why()}
          </p>
        )}
      </Show>
      <div class="cad-editor__field" data-param="document">
        <span>Document</span>
        <div class="cad-editor__document-field" data-drop="document">
          <Show when={inserted()}>
            {(d) => (
              <button class="cad-editor__button cad-editor__document-open" title={`Open ${d().info.title}${d().info.datatype ? ` (${d().info.datatype})` : ""}`} onClick={() => props.onOpen(d().doc)}>
                <Icon name={d().info.icon} />
                <span>{d().info.title}</span>
                <Show when={hasPath()}>
                  <span class="cad-editor__muted">/{d().path!.join("/")}</span>
                </Show>
              </button>
            )}
          </Show>
          <CommitInput value={props.pending.url ?? ""} label="Document URL" title="An automerge: URL or a Patchwork link" commit={(url) => props.inserts.setDocument(url)} onNotice={props.editor.setNotice} />
        </div>
      </div>
      <Show when={target()}>
        {(t) => (
          <div class="cad-editor__field" data-param="target">
            <span>For</span>
            <span>{props.inserts.targetLabel(t())}</span>
          </div>
        )}
      </Show>
      <Show when={props.pending.anchor}>
        {(anchor) => (
          <div class="cad-editor__field" data-param="anchor">
            <span>On</span>
            <span>{anchorLabel({ anchor: anchor() })}</span>
          </div>
        )}
      </Show>
      {/* For a field, the dialog is about a value for it alone. */}
      <Show when={!target() && roles().length > 0}>
        <div class="cad-editor__field" data-param="role">
          <span>Use as</span>
          <div class="cad-editor__segmented" role="radiogroup" aria-label="Use as">
            <For each={roles()}>
              {(role) => (
                <button role="radio" class="cad-editor__segment" aria-checked={false} disabled={disabled()} title={role.title} onClick={() => void props.inserts.choose(role.id)}>
                  {role.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={module()?.kind !== "problem" && module()}>
        {(m) => (
          <div class="cad-editor__field" data-param="preview">
            <span>Preview</span>
            <Preview module={m()} mimeType={mimeType()} picker={m().kind === "data" ? picker() : undefined} />
          </div>
        )}
      </Show>
    </section>
  );
}
