import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import { schemas, type ParamSpec } from "@patchwork-cad/features/schema";
import type { Expression } from "acorn";
import type { RefDiagnostic } from "@patchwork-cad/features/runtime";
import type { FeatureCall } from "../../model/analyze.ts";
import { at, calleeName, keys, span, stringValue, type Step } from "../../model/nodes.ts";
import { addToReturn, elements, ensureImports, removeElement, removeProp, replaceElement, retarget, setProp, usedFunctions } from "../../model/splice.ts";
import type { FeatureEntry } from "../../model/timeline.ts";
import { schemaOf, type Editor } from "./state.ts";

/**
 * A text field holding a JS expression (research/02, "Parameters are JS expressions"). It commits
 * on Enter or blur, and follows remote changes only while it isn't being edited.
 */
function ExpressionInput(props: { value: string; placeholder?: string; label: string; onCommit: (text: string) => void; disabled?: boolean }) {
  let input!: HTMLInputElement;
  createEffect(() => {
    const value = props.value;
    if (document.activeElement !== input) input.value = value;
  });
  const commit = () => {
    if (input.value !== props.value) props.onCommit(input.value.trim());
  };
  return (
    <input
      ref={input}
      class="cad-editor__input"
      aria-label={props.label}
      placeholder={props.placeholder ?? ""}
      disabled={props.disabled}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") input.value = props.value;
      }}
      onBlur={commit}
    />
  );
}

const statusLabel = (d: RefDiagnostic | undefined) => (!d ? "" : d.status === "ok" ? "" : d.status === "missing" ? "missing" : "ambiguous");

/** A reference without its geometric hint, for a chip; the tooltip has the whole code. */
const shortRef = (code: string) => code.replace(/, \{ near: \[[^\]]*\] \}/g, "");

interface FieldProps {
  editor: Editor;
  entry: FeatureEntry;
  name: string;
  spec: ParamSpec;
  source: string;
  disabled: boolean;
}

function propNode(call: FeatureCall, key: string): Expression | undefined {
  return call.props?.find((p) => p.key === key)?.node;
}

const textOf = (source: string, node: { start: number; end: number } | undefined) => (node ? source.slice(node.start, node.end) : "");

/** Edits a value inside the open call's parameter, at `path` below it. */
function editAt(editor: Editor, param: string, path: readonly Step[], text: string) {
  editor.editOpen((call, analysis) => {
    const node = at(propNode(call, param), path);
    if (!node) return [];
    return [{ ...span(node), text }, ...ensureImports(analysis, usedFunctions(text))];
  });
}

function setParam(editor: Editor, key: string, text: string, optional: boolean) {
  editor.editOpen((call, analysis) => (text === "" && optional ? removeProp(call, key) : [...setProp(call, key, text), ...ensureImports(analysis, usedFunctions(text))]));
}

function ScalarField(props: FieldProps) {
  const value = () => textOf(props.source, propNode(props.entry.call, props.name));
  const def = props.spec.kind === "length" || props.spec.kind === "number" ? props.spec.default : undefined;
  return <ExpressionInput label={props.spec.label} value={value()} placeholder={def !== undefined ? String(def) : ""} disabled={props.disabled} onCommit={(t) => setParam(props.editor, props.name, t, props.spec.optional ?? false)} />;
}

function ChoiceField(props: FieldProps & { spec: Extract<ParamSpec, { kind: "choice" }> }) {
  const node = () => propNode(props.entry.call, props.name);
  const value = () => stringValue(node()) ?? (node() ? "" : (props.spec.default ?? ""));
  return (
    <select class="cad-editor__input" aria-label={props.spec.label} disabled={props.disabled} value={value()} onChange={(e) => setParam(props.editor, props.name, JSON.stringify(e.currentTarget.value), false)}>
      <For each={props.spec.options}>{(o) => <option value={o}>{o}</option>}</For>
      <Show when={!props.spec.options.includes(value())}>
        <option value="">{textOf(props.source, node()) || "—"}</option>
      </Show>
    </select>
  );
}

function VariableField(props: FieldProps & { of: "body" | "sketch" }) {
  const value = () => textOf(props.source, propNode(props.entry.call, props.name));
  const options = () => props.editor.variablesBefore(props.of);
  return (
    <select
      class="cad-editor__input"
      aria-label={props.spec.label}
      disabled={props.disabled}
      value={value()}
      onChange={(e) => {
        const chosen = e.currentTarget.value;
        props.editor.editOpen((call, analysis, source) => {
          const current = call.props?.find((p) => p.key === props.name);
          const previous = current?.node.type === "Identifier" ? source.slice(current.value.start, current.value.end) : undefined;
          return [
            ...(chosen === "" && props.spec.optional ? removeProp(call, props.name) : setProp(call, props.name, chosen)),
            // The result shows the feature instead of the body it now works on, and the body it no
            // longer works on, if nothing else uses it, instead of dropping it.
            ...(props.of === "body" ? retarget(analysis, call, props.entry.name, previous, chosen || undefined) : []),
          ];
        });
      }}
    >
      <Show when={props.spec.optional}>
        <option value="">—</option>
      </Show>
      <For each={options()}>{(o) => <option value={o}>{o}</option>}</For>
      <Show when={value() && !options().includes(value())}>
        <option value={value()}>{value()}</option>
      </Show>
    </select>
  );
}

/** A chip per reference, with its status from the last build and the suggestion to accept. */
function ReferenceChip(props: { code: string; diagnostic: RefDiagnostic | undefined; onRemove?: () => void; onSuggestion?: (code: string) => void; disabled: boolean }) {
  return (
    <span class="cad-editor__chip" data-status={props.diagnostic?.status ?? "unknown"} title={props.diagnostic?.message ? `${props.code}\n${props.diagnostic.message}` : props.code}>
      <code>{shortRef(props.code)}</code>
      <Show when={statusLabel(props.diagnostic)}>
        <span class="cad-editor__chip-status">{statusLabel(props.diagnostic)}</span>
      </Show>
      <Show when={props.diagnostic?.suggestion}>
        {(s) => (
          <button class="cad-editor__link" disabled={props.disabled} onClick={() => props.onSuggestion?.(s())}>
            use suggestion
          </button>
        )}
      </Show>
      <Show when={props.onRemove}>
        <button class="cad-editor__link" aria-label="remove" disabled={props.disabled} onClick={() => props.onRemove?.()}>
          ×
        </button>
      </Show>
    </span>
  );
}

function PickButton(props: { editor: Editor; param: string; kind: "face" | "edge"; multi: boolean; disabled: boolean }) {
  const active = () => props.editor.pickTarget()?.param === props.param;
  return (
    <button
      class="cad-editor__button"
      aria-pressed={active()}
      disabled={props.disabled}
      onClick={() => props.editor.setPickTarget(active() ? undefined : { param: props.param, kind: props.kind, multi: props.multi })}
    >
      {active() ? "Done selecting" : `Select ${props.kind}s`}
    </button>
  );
}

function ReferenceListField(props: FieldProps & { spec: Extract<ParamSpec, { kind: "edges" | "faces" }> }) {
  const items = () => elements(props.entry.call, props.name).map((s) => props.source.slice(s.start, s.end));
  const diagnostic = (index: number) => props.entry.trace?.refs.find((d) => d.param === props.name && d.index === index);
  const kind = props.spec.kind === "edges" ? "edge" : "face";
  return (
    <div class="cad-editor__refs">
      <For each={items()} fallback={<span class="cad-editor__muted">nothing selected</span>}>
        {(code, i) => (
          <ReferenceChip
            code={code}
            diagnostic={diagnostic(i())}
            disabled={props.disabled}
            onRemove={() => props.editor.editOpen((call) => removeElement(call, props.name, i()))}
            onSuggestion={(s) => props.editor.editOpen((call, analysis) => [...replaceElement(call, props.name, i(), s), ...ensureImports(analysis, usedFunctions(s))])}
          />
        )}
      </For>
      <PickButton editor={props.editor} param={props.name} kind={kind} multi disabled={props.disabled} />
    </div>
  );
}

const PLANES = ["XY", "XZ", "YZ"];

function PlaneField(props: FieldProps) {
  const node = () => propNode(props.entry.call, props.name);
  const origin = () => (calleeName(node()) === "plane" ? node() : undefined);
  const name = () => {
    const n = origin();
    return n?.type === "CallExpression" ? stringValue(n.arguments[0] as Expression | undefined) : undefined;
  };
  const offset = () => {
    const n = origin();
    return n?.type === "CallExpression" ? textOf(props.source, n.arguments[1]) : "";
  };
  const diagnostic = () => props.entry.trace?.refs.find((d) => d.param === props.name);
  const setPlane = (plane: string, off: string) =>
    props.editor.editOpen((call, analysis) => [
      ...setProp(call, props.name, `plane(${JSON.stringify(plane)}${off && off !== "0" ? `, ${off}` : ""})`),
      ...removeProp(call, "body"),
      ...ensureImports(analysis, ["plane"]),
    ]);
  return (
    <div class="cad-editor__refs">
      <Show
        when={origin()}
        fallback={
          <Show when={node()}>
            <ReferenceChip
              code={textOf(props.source, node())}
              diagnostic={diagnostic()}
              disabled={props.disabled}
              onSuggestion={(s) => props.editor.editOpen((call, analysis) => [...setProp(call, props.name, s), ...ensureImports(analysis, usedFunctions(s))])}
            />
          </Show>
        }
      >
        <select class="cad-editor__input" aria-label="Origin plane" disabled={props.disabled} value={name() ?? ""} onChange={(e) => setPlane(e.currentTarget.value, offset())}>
          <For each={PLANES}>{(p) => <option value={p}>{p}</option>}</For>
        </select>
        <ExpressionInput label="Offset" value={offset()} placeholder="0" disabled={props.disabled} onCommit={(t) => setPlane(name() ?? "XY", t)} />
      </Show>
      <Show when={!origin()}>
        <button class="cad-editor__button" disabled={props.disabled} onClick={() => setPlane("XY", "")}>
          Origin plane
        </button>
      </Show>
      <PickButton editor={props.editor} param={props.name} kind="face" multi={false} disabled={props.disabled} />
    </div>
  );
}

const PROFILES: Record<string, string> = {
  rect: "rect({ from: [0, 0], to: [20, 10] })",
  circle: "circle({ center: [0, 0], radius: 5 })",
  polygon: "polygon({ a: [0, 0], b: [20, 0], c: [0, 10] })",
};

/** The sketch's profile: rectangle, circle or polygon, each value an expression. */
function ProfileField(props: FieldProps) {
  const node = () => propNode(props.entry.call, props.name);
  const kind = () => calleeName(node()) ?? "";
  const value = (path: Step[]) => textOf(props.source, at(node(), path));
  const field = (label: string, path: Step[]) => (
    <label class="cad-editor__subfield">
      <span>{label}</span>
      <ExpressionInput label={label} value={value(path)} disabled={props.disabled} onCommit={(t) => editAt(props.editor, props.name, path, t)} />
    </label>
  );
  const replaceProfile = (code: string) => props.editor.editOpen((call, analysis) => [...setProp(call, props.name, code), ...ensureImports(analysis, usedFunctions(code))]);
  const segments = () => keys(node());
  return (
    <div class="cad-editor__profile">
      <select class="cad-editor__input" aria-label="Profile kind" disabled={props.disabled} value={kind()} onChange={(e) => replaceProfile(PROFILES[e.currentTarget.value]!)}>
        <For each={Object.keys(PROFILES)}>{(k) => <option value={k}>{k}</option>}</For>
        <Show when={!PROFILES[kind()]}>
          <option value="">{textOf(props.source, node()) || "—"}</option>
        </Show>
      </select>
      <Show when={kind() === "rect"}>
        <div class="cad-editor__grid">
          {field("from x", ["from", 0])}
          {field("from y", ["from", 1])}
          {field("to x", ["to", 0])}
          {field("to y", ["to", 1])}
        </div>
      </Show>
      <Show when={kind() === "circle"}>
        <div class="cad-editor__grid">
          {field("center x", ["center", 0])}
          {field("center y", ["center", 1])}
          {field("radius", ["radius"])}
        </div>
      </Show>
      <Show when={kind() === "polygon"}>
        <div class="cad-editor__grid cad-editor__grid--segments">
          <For each={segments()}>
            {(id) => (
              <>
                <code title="segment id: the name its side face gets">{id}</code>
                {field(`${id} x`, [id, 0])}
                {field(`${id} y`, [id, 1])}
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function Field(props: FieldProps): JSX.Element {
  const spec = props.spec;
  switch (spec.kind) {
    case "length":
    case "number":
      return <ScalarField {...props} />;
    case "choice":
      return <ChoiceField {...props} spec={spec} />;
    case "body":
      return <VariableField {...props} of="body" />;
    case "sketch":
      return <VariableField {...props} of="sketch" />;
    case "edges":
    case "faces":
      return <ReferenceListField {...props} spec={spec} />;
    case "plane":
      return <PlaneField {...props} />;
    case "profile":
      return <ProfileField {...props} />;
    case "code":
      // Code is edited in the code pane (research/11): body() entries have no dialog.
      return null;
  }
}

/**
 * Each type's parameters as one stable array: `For` keys its items by reference, and new arrays on
 * every build or remote edit would recreate the inputs, throwing away what the user is typing.
 */
const PARAMS = Object.fromEntries(Object.entries(schemas).map(([type, schema]) => [type, Object.entries(schema.params) as [string, ParamSpec][]]));

/** The form of the open feature, generated from its schema (research/02, "Feature types"). */
export function FeatureDialog(props: { editor: Editor; entry: FeatureEntry; onEditCode: () => void }) {
  const schema = () => schemaOf(props.entry.type);
  const disabled = () => props.editor.syntaxError() !== undefined;
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  /**
   * When the feature failed because a parameter holds a replicad shape, the variable and the Custom
   * Script that makes it, which "Wrap in body()" can turn into a body (research/11).
   */
  const wrappable = () => {
    const param = /^(\w+): a replicad shape, not a feature body/.exec(props.entry.trace?.message ?? "")?.[1];
    const value = props.entry.call.props?.find((p) => p.key === param)?.node;
    if (value?.type !== "Identifier") return undefined;
    const index = props.editor.graph()?.declaredBy.get(value.name);
    return index !== undefined && props.editor.timeline().entries[index]?.kind === "script" ? { name: value.name, index } : undefined;
  };
  return (
    <section class="cad-editor__dialog" aria-label={`${schema().label} ${props.entry.name}`} data-feature={props.entry.name}>
      <header class="cad-editor__dialog-header">
        <strong>{schema().label}</strong> <code>{props.entry.name}</code>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.editor.openFeature(undefined)}>
          ×
        </button>
      </header>
      <Show when={props.entry.trace && props.entry.trace.status !== "ok"}>
        <p class="cad-editor__problem" data-status={props.entry.trace!.status}>
          {props.entry.trace!.status === "broken" ? "Broken reference: " : "Failed: "}
          {props.entry.trace!.message}
          <Show when={wrappable()}>
            {(w) => (
              <>
                {" "}
                <button class="cad-editor__link" disabled={disabled()} onClick={() => void props.editor.wrap(w().index).then(props.editor.setNotice)}>
                  Wrap {w().name} in body()
                </button>
              </>
            )}
          </Show>
        </p>
      </Show>
      <Show when={props.entry.trace?.unused}>
        <p class="cad-editor__problem" data-status="unused">
          Unused: no later feature uses this result, and the model doesn't return it.{" "}
          <button class="cad-editor__link" disabled={disabled()} onClick={() => props.editor.editOpen((_, analysis, source) => addToReturn(source, analysis, props.entry.name))}>
            Add to result
          </button>
        </p>
      </Show>
      <Show when={disabled()}>
        <p class="cad-editor__muted">The code doesn't parse; fix it to edit here.</p>
      </Show>
      <For each={PARAMS[props.entry.type]}>
        {([name, spec]) => (
          <div class="cad-editor__field" data-param={name}>
            <span>{spec.label}</span>
            <Field editor={props.editor} entry={props.entry} name={name} spec={spec} source={props.editor.source()} disabled={disabled()} />
          </div>
        )}
      </For>
      <footer class="cad-editor__dialog-footer">
        <button class="cad-editor__button" onClick={() => props.onEditCode()}>
          Edit code
        </button>
        <Show
          when={confirmDelete()}
          fallback={
            <button class="cad-editor__button" disabled={disabled()} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          }
        >
          <button class="cad-editor__button cad-editor__button--danger" onClick={() => props.editor.deleteOpen()}>
            Delete {props.entry.name}
          </button>
        </Show>
      </footer>
    </section>
  );
}
