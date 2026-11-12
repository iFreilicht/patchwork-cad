import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { parse } from "acorn";
import type { ImportedModule } from "../../kernel/imports.ts";
import { Icon } from "../icons.tsx";
import { documentActions } from "./Browser.tsx";
import type { As, DocumentRow, Documents } from "./documents.ts";
import type { Editor } from "./state.ts";

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

/** One value of a data preview: a primitive, or a collapsed object or array that renders its keys only when opened. */
function DataNode(props: { name: string | undefined; value: unknown }) {
  const [open, setOpen] = createSignal(false);
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
          <code>{clip(JSON.stringify(props.value) ?? "undefined")}</code>
        </li>
      }
    >
      <li>
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>
            <Show when={props.name !== undefined}>
              <span class="cad-editor__tree-key">{props.name}</span>{" "}
            </Show>
            <span class="cad-editor__muted">{Array.isArray(props.value) ? `[${entries().length}]` : `{${entries().length}}`}</span>
          </summary>
          <Show when={open()}>
            <ul class="cad-editor__tree">
              <For each={entries().slice(0, MAX_KEYS)}>{([key, value]) => <DataNode name={key} value={value} />}</For>
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
function Preview(props: { module: ImportedModule; mimeType: string | undefined }) {
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
            <DataNode name={undefined} value={m().value} />
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
export function DocumentDialog(props: { documents: Documents; row: DocumentRow; editor: Editor; onClose: () => void }) {
  const row = () => props.row;
  const info = () => props.documents.info(row());
  const state = () => props.documents.state(row());
  const own = () => row().role === "import";
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
          <Show when={own()}>
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
            <button role="radio" class="cad-editor__segment" aria-checked={!row().pinned} disabled={!own() || disabled()} title="Follow the document's latest version" onClick={() => props.documents.follow(row())}>
              Following
            </button>
            <button role="radio" class="cad-editor__segment" aria-checked={!!row().pinned} disabled={!own() || disabled() || !props.documents.builtWith(row())} title="Pin the version the model is built with" onClick={() => !row().pinned && props.documents.pin(row())}>
              Pinned
            </button>
          </div>
          <Show when={state().state === "newer"}>
            <button class="cad-editor__button" disabled={!own() || disabled()} title="Pin the document's latest version" onClick={() => props.documents.update(row())}>
              Update
            </button>
          </Show>
          <span class="cad-editor__document-state" data-state={state().state} title={state().label} aria-label={state().label} role="img">
            <Icon name={state().icon} size={12} />
          </span>
        </div>
      </div>
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
      <footer class="cad-editor__dialog-footer">
        <For each={documentActions(props.documents, row()).filter((a) => a.label === "Open" || a.label === "Remove")}>
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
