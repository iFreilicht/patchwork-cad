import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { schemas, type ParamSpec } from "@patchwork-cad/features/schema";
import { parseExpressionAt, type Expression } from "acorn";
import type { RefDiagnostic } from "@patchwork-cad/features/runtime";
import type { FeatureCall } from "../../model/analyze.ts";
import { at, calleeName, keys, span, stringValue, type Step } from "../../model/nodes.ts";
import { addToReturn, elements, ensureImports, removeElement, removeProp, replaceElement, resketch, retarget, retool, setOption, setProp, usedFunctions } from "../../model/splice.ts";
import { sketchVariable } from "./regions.ts";
import type { FeatureEntry, ScriptEntry } from "../../model/timeline.ts";
import type { ValueTarget } from "./inserts.ts";
import { schemaOf, type Editor } from "./state.ts";

/** Whether `text` is one expression that can replace a parameter's value, e.g. not `1,` or `1 // x`, which would break the code around it. */
function isExpression(text: string): boolean {
  try {
    // As in the module it goes into, e.g. no legacy octal `01`.
    const node = parseExpressionAt(text, 0, { ecmaVersion: "latest", sourceType: "module" });
    return node.end === text.length && node.type !== "SequenceExpression";
  } catch {
    return false;
  }
}

/**
 * A text field holding a JS expression (research/02, "Parameters are JS expressions"). It commits
 * as it is typed, whenever the text is an expression, and follows remote changes only while it
 * isn't being edited. Other text is marked and never reaches the code; leaving the field drops it,
 * and so does closing its dialog. Escape restores the value from before the edit. An empty field,
 * only allowed with `allowEmpty`, commits on Enter or blur.
 */
export function ExpressionInput(props: { value: string; placeholder?: string; label: string; onCommit: (text: string) => boolean; disabled?: boolean; allowEmpty?: boolean }) {
  let input!: HTMLInputElement;
  const [invalid, setInvalid] = createSignal(false);
  /** The value when the field got the focus. */
  let before = "";
  // A field taken away while it has the focus blurs: what it holds then was committed as it was typed, or isn't a value.
  let mounted = true;
  onCleanup(() => (mounted = false));
  createEffect(() => {
    const value = props.value;
    if (document.activeElement !== input) input.value = value;
  });
  const commit = (text: string, live: boolean) => {
    const empty = text === "";
    let valid = empty ? props.allowEmpty === true : isExpression(text);
    // The edit itself checks that the code still parses with it.
    if (valid && !(empty && live) && text !== props.value) valid = props.onCommit(text);
    setInvalid(!valid && !empty);
  };
  return (
    <input
      ref={input}
      class="cad-editor__input"
      classList={{ "cad-editor__input--invalid": invalid() }}
      aria-label={props.label}
      aria-invalid={invalid()}
      placeholder={props.placeholder ?? ""}
      disabled={props.disabled}
      onFocus={() => (before = props.value)}
      onInput={() => commit(input.value.trim(), true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(input.value.trim(), false);
        // Restoring the value is what Escape does here; with nothing to restore, it closes the dialog.
        if (e.key === "Escape" && input.value !== before) {
          e.preventDefault();
          input.value = before;
          commit(before, false);
        }
      }}
      onBlur={() => {
        if (!mounted) return;
        commit(input.value.trim(), false);
        if (invalid() || (input.value.trim() === "" && !props.allowEmpty)) {
          input.value = props.value;
          setInvalid(false);
        }
      }}
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
  /** Makes a parameter of argument `key` (research/17-parameters.md); says why not, if not. */
  promote?: ((call: FeatureCall, key: string) => string | undefined) | undefined;
}

function propNode(call: FeatureCall, key: string): Expression | undefined {
  return call.props?.find((p) => p.key === key)?.node;
}

const textOf = (source: string, node: { start: number; end: number } | undefined) => (node ? source.slice(node.start, node.end) : "");

/** Edits a value inside the open call's parameter, at `path` below it. */
function editAt(editor: Editor, param: string, path: readonly Step[], text: string): boolean {
  return editor.editOpen((call, analysis) => {
    const node = at(propNode(call, param), path);
    if (!node) return [];
    return [{ ...span(node), text }, ...ensureImports(analysis, usedFunctions(text))];
  });
}

function setParam(editor: Editor, key: string, text: string, optional: boolean): boolean {
  return editor.editOpen((call, analysis) => (text === "" && optional ? removeProp(call, key) : [...setProp(call, key, text), ...ensureImports(analysis, usedFunctions(text))]));
}

/** A number as code, e.g. `20` or `-1.5`, which can become a parameter's default. */
const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;

/** A number argument; a document dropped on it gives it a value (research/21, "Dropping, pasting, inserting"). */
function ScalarField(props: FieldProps) {
  const value = () => textOf(props.source, propNode(props.entry.call, props.name));
  const def = props.spec.kind === "length" || props.spec.kind === "number" ? props.spec.default : undefined;
  const target = (): ValueTarget => ({ kind: "argument", feature: props.entry.name, param: props.name, label: props.spec.label });
  return (
    <div class="cad-editor__scalar" data-drop="value" data-drop-value={JSON.stringify(target())}>
      <ExpressionInput label={props.spec.label} value={value()} placeholder={def !== undefined ? String(def) : ""} disabled={props.disabled} allowEmpty={props.spec.optional ?? false} onCommit={(t) => setParam(props.editor, props.name, t, props.spec.optional ?? false)} />
      <Show when={props.promote && NUMBER.test(value())}>
        <button class="cad-editor__link" title="Make a parameter of this value, with it as the default" aria-label="Make a parameter of this value" disabled={props.disabled} onClick={() => props.editor.setNotice(props.promote?.(props.entry.call, props.name))}>
          ƒ
        </button>
      </Show>
    </div>
  );
}

/**
 * An extrusion that starts to join or cut needs a target: the body its sketch lies on, as in Fusion,
 * or else the one the user picks next.
 */
function targetForOperation(editor: Editor, entry: FeatureEntry, operation: string): boolean {
  let pickNext = false;
  const done = editor.editOpen((call, analysis) => {
    const edits = setProp(call, "operation", JSON.stringify(operation));
    if (entry.type !== "extrude" || operation === "new" || call.props?.some((p) => p.key === "target")) return edits;
    const sketch = call.props?.find((p) => p.key === "sketch")?.node;
    const onFace = sketch?.type === "Identifier" ? analysis.calls.find((c) => c.variable === sketch.name)?.props?.find((p) => p.key === "body")?.node : undefined;
    if (onFace?.type !== "Identifier") {
      pickNext = true;
      return edits;
    }
    return [...edits, ...setProp(call, "target", onFace.name), ...retarget(analysis, call, entry.name, undefined, onFace.name)];
  });
  if (pickNext) editor.setPickTarget({ param: "target", kind: "body", multi: false });
  return done;
}

function ChoiceField(props: FieldProps & { spec: Extract<ParamSpec, { kind: "choice" }> }) {
  const node = () => propNode(props.entry.call, props.name);
  const value = () => stringValue(node()) ?? (node() ? "" : (props.spec.default ?? ""));
  const choose = (option: string) => (props.name === "operation" && props.entry.type === "extrude" ? targetForOperation(props.editor, props.entry, option) : setParam(props.editor, props.name, JSON.stringify(option), false));
  return (
    <select class="cad-editor__input" aria-label={props.spec.label} disabled={props.disabled} value={value()} onChange={(e) => choose(e.currentTarget.value)}>
      <For each={props.spec.options}>{(o) => <option value={o}>{o}</option>}</For>
      <Show when={!props.spec.options.includes(value())}>
        <option value="">{textOf(props.source, node()) || "—"}</option>
      </Show>
    </select>
  );
}

/**
 * A body or sketch parameter, filled by picking (research/15, "Availability"): in the 3D view, the
 * browser or the timeline. An optional one can be cleared.
 */
function VersionField(props: FieldProps & { of: "body" | "sketch" }) {
  const value = () => textOf(props.source, propNode(props.entry.call, props.name));
  const clear = () =>
    props.editor.editOpen((call, analysis) => [...removeProp(call, props.name), ...(props.of === "sketch" ? resketch(analysis, call, value() || undefined, undefined) : [])]);
  return (
    <div class="cad-editor__refs">
      <Show when={value()} fallback={<span class="cad-editor__muted">none</span>}>
        <span class="cad-editor__version" data-kind={props.of} title={value()}>
          <code>{value()}</code>
          <Show when={props.spec.optional}>
            <button class="cad-editor__link" aria-label={`clear ${props.spec.label}`} disabled={props.disabled} onClick={clear}>
              ×
            </button>
          </Show>
        </span>
      </Show>
      <PickButton editor={props.editor} param={props.name} kind={props.of} multi={false} disabled={props.disabled} label={`Select ${props.of}`} />
    </div>
  );
}

/** A list of bodies, e.g. a combine's tools: a chip each, added and removed by picking. */
function VersionListField(props: FieldProps) {
  const items = () => elements(props.entry.call, props.name).map((s) => props.source.slice(s.start, s.end));
  return (
    <div class="cad-editor__refs">
      <For each={items()} fallback={<span class="cad-editor__muted">nothing selected</span>}>
        {(code, i) => (
          <span class="cad-editor__version" data-kind="body" title={code}>
            <code>{code}</code>
            <button
              class="cad-editor__link"
              aria-label={`remove ${code}`}
              disabled={props.disabled}
              onClick={() => props.editor.editOpen((call, analysis) => [...removeElement(call, props.name, i()), ...retool(analysis, call, undefined, code)])}
            >
              ×
            </button>
          </span>
        )}
      </For>
      <PickButton editor={props.editor} param={props.name} kind="body" multi disabled={props.disabled} label="Select bodies" />
    </div>
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

export function PickButton(props: { editor: Editor; param: string; kind: "face" | "edge" | "body" | "sketch" | "version" | "region"; multi: boolean; disabled: boolean; label?: string }) {
  const active = () => props.editor.pickTarget()?.param === props.param;
  return (
    <button
      class="cad-editor__button"
      aria-pressed={active()}
      disabled={props.disabled}
      onClick={() => props.editor.setPickTarget(active() ? undefined : { param: props.param, kind: props.kind, multi: props.multi })}
    >
      {active() ? "Done selecting" : (props.label ?? `Select ${props.kind}s`)}
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
  const setPlane = (plane: string, off: string): boolean =>
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
        <ExpressionInput label="Offset" value={offset()} placeholder="0" disabled={props.disabled} allowEmpty onCommit={(t) => setPlane(name() ?? "XY", t)} />
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
        <Show when={kind() === "svg"}>
          <option value="svg">svg</option>
        </Show>
        <Show when={!PROFILES[kind()] && kind() !== "svg"}>
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
      <Show when={kind() === "svg"}>
        <code class="cad-editor__drawing" title="The drawing">
          {textOf(props.source, (node() as { arguments?: Expression[] } | undefined)?.arguments?.[0])}
        </code>
        <SvgFields {...props} size={props.entry.trace?.size} />
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

/**
 * An extrusion's profiles (research/21, "Sketch from a drawing"): a chip per region it names, picked
 * in the view, and Filled, which names all that the drawing fills. Without any, a sketch's only one.
 */
function RegionsField(props: FieldProps) {
  const node = () => propNode(props.entry.call, props.name);
  const items = () => {
    const n = node();
    if (!n) return [];
    if (n.type !== "ArrayExpression") return [{ code: textOf(props.source, n), index: undefined }];
    return elements(props.entry.call, props.name).map((s, index) => ({ code: props.source.slice(s.start, s.end), index }));
  };
  const diagnostic = (index: number | undefined) => props.entry.trace?.refs.find((d) => d.param === props.name && d.index === index);
  const sketch = () => sketchVariable(props.entry.call);
  const regions = () => {
    const name = sketch();
    const entry = props.editor.timeline().entries.find((e) => e.kind === "feature" && e.name === name);
    return entry?.kind === "feature" ? entry.trace?.regions : undefined;
  };
  const filled = () => (sketch() ? `${sketch()}.filled` : undefined);
  const remove = (index: number | undefined) => props.editor.editOpen((call) => (index === undefined ? setProp(call, props.name, "[]") : removeElement(call, props.name, index)));
  return (
    <div class="cad-editor__refs">
      <For each={items()} fallback={<span class="cad-editor__muted">{regions()?.length === 1 ? "its only profile" : "none"}</span>}>
        {(item) => (
          <ReferenceChip
            code={item.code}
            diagnostic={diagnostic(item.index)}
            disabled={props.disabled}
            onRemove={() => remove(item.index)}
            onSuggestion={(s) => props.editor.editOpen((call) => (item.index === undefined ? setProp(call, props.name, `[${s}]`) : replaceElement(call, props.name, item.index, s)))}
          />
        )}
      </For>
      <PickButton editor={props.editor} param={props.name} kind="region" multi disabled={props.disabled || !regions()?.length} label="Select profiles" />
      <Show when={filled() && regions()?.some((r) => r.filled) && textOf(props.source, node()) !== filled()}>
        <button class="cad-editor__button" title={`Every profile the drawing fills: ${filled()}`} disabled={props.disabled} onClick={() => props.editor.editOpen((call) => setProp(call, props.name, filled()!))}>
          Filled
        </button>
      </Show>
    </div>
  );
}

/** How an SVG profile is sized: as the drawing is, or to a width, a height or a scale. */
const SVG_SIZES = ["natural", "width", "height", "scale"] as const;

/** An SVG profile, `svg(logo, { width, center })`: the drawing, its size and where its middle lies (research/21, "Sketch from a drawing"). */
function SvgFields(props: FieldProps & { size: [number, number] | undefined }) {
  const profileOf = (call: FeatureCall) => {
    const n = call.props?.find((p) => p.key === props.name)?.node;
    return n?.type === "CallExpression" ? n : undefined;
  };
  const property = (call: FeatureCall, key: string) => {
    const options = profileOf(call)?.arguments[1];
    const p = options?.type === "ObjectExpression" ? options.properties.find((x) => x.type === "Property" && !x.computed && x.key.type === "Identifier" && x.key.name === key) : undefined;
    return p?.type === "Property" ? p : undefined;
  };
  const option = (key: string) => property(props.entry.call, key)?.value as Expression | undefined;
  const sizing = () => SVG_SIZES.find((k) => k !== "natural" && option(k)) ?? "natural";
  const setOptionOf = (key: string, text: string | undefined) =>
    props.editor.editOpen((call) => {
      const node = profileOf(call);
      return node ? setOption(node, key, text) : [];
    });
  /** Sizes it another way: the other option in place of the one it has, at the size it has now, or as drawn. */
  const chooseSizing = (next: string) =>
    props.editor.editOpen((call) => {
      const node = profileOf(call);
      const current = sizing();
      if (!node || next === current) return [];
      if (next === "natural") return setOption(node, current, undefined);
      const value = next === "scale" ? "1" : String(+(props.size?.[next === "height" ? 1 : 0] ?? 10).toFixed(2));
      if (current === "natural") return setOption(node, next, value);
      const p = property(call, current)!;
      return [{ start: p.key.start, end: p.value.end, text: `${next}: ${value}` }];
    });
  const center = (i: 0 | 1) => {
    const n = option("center");
    return n?.type === "ArrayExpression" ? textOf(props.source, n.elements[i] as Expression | undefined) : "";
  };
  const setCenter = (i: 0 | 1, t: string) => {
    const xy = [center(0) || "0", center(1) || "0"];
    xy[i] = t || "0";
    return setOptionOf("center", xy.every((v) => v === "0") ? undefined : `[${xy.join(", ")}]`);
  };
  return (
    <div class="cad-editor__grid">
      <label class="cad-editor__subfield">
        <span>Size</span>
        <select class="cad-editor__input" aria-label="Size" disabled={props.disabled} value={sizing()} onChange={(e) => chooseSizing(e.currentTarget.value)}>
          <For each={SVG_SIZES}>{(k) => <option value={k}>{k === "natural" ? "as drawn" : k}</option>}</For>
        </select>
      </label>
      {/* A field of its own per option: text typed for the width is never committed as the height. */}
      <Show when={sizing() !== "natural" && sizing()} keyed>
        {(key) => (
          <label class="cad-editor__subfield">
            <span>{key}</span>
            <ExpressionInput label={key} value={textOf(props.source, option(key))} disabled={props.disabled} onCommit={(t) => setOptionOf(key, t)} />
          </label>
        )}
      </Show>
      <label class="cad-editor__subfield">
        <span>center x</span>
        <ExpressionInput label="center x" value={center(0)} placeholder="0" allowEmpty disabled={props.disabled} onCommit={(t) => setCenter(0, t)} />
      </label>
      <label class="cad-editor__subfield">
        <span>center y</span>
        <ExpressionInput label="center y" value={center(1)} placeholder="0" allowEmpty disabled={props.disabled} onCommit={(t) => setCenter(1, t)} />
      </label>
      <Show when={props.size}>{(s) => <span class="cad-editor__muted" data-size>{`${+s()[0].toFixed(2)} × ${+s()[1].toFixed(2)}`}</span>}</Show>
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
      return <VersionField {...props} of="body" />;
    case "sketch":
      return <VersionField {...props} of="sketch" />;
    case "bodies":
      return <VersionListField {...props} />;
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
    case "regions":
      return <RegionsField {...props} />;
  }
}

/**
 * Each type's parameters as one stable array: `For` keys its items by reference, and new arrays on
 * every build or remote edit would recreate the inputs, throwing away what the user is typing. A
 * body that its faces or edges decide (`from`) isn't a field: picking them picks it.
 */
const PARAMS = Object.fromEntries(Object.entries(schemas).map(([type, schema]) => [type, (Object.entries(schema.params) as [string, ParamSpec][]).filter(([, spec]) => spec.kind !== "body" || !spec.from)]));

/**
 * The body the open feature works on, where its faces or edges decide it (research/15,
 * "Availability"): shown, not edited. Hovering it hovers its lineage, as its row in the browser does.
 */
function OnBody(props: { editor: Editor; entry: FeatureEntry }) {
  const param = () => Object.entries(schemaOf(props.entry.type).params as Record<string, ParamSpec>).find(([, spec]) => spec.kind === "body" && spec.from)?.[0];
  const value = () => {
    const key = param();
    return key ? textOf(props.editor.source(), propNode(props.entry.call, key)) : "";
  };
  const lane = () => props.editor.lanes()?.laneOf.get(value());
  const hover = (on: boolean) => {
    const l = lane();
    props.editor.setHoveredLane(on && l !== undefined ? { lane: l, version: value() } : undefined);
  };
  return (
    <Show when={value()}>
      <span class="cad-editor__on" data-param={param()} title={`Works on ${value()}`} onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)}>
        on <code>{value()}</code>
      </span>
    </Show>
  );
}

/** The form of the open feature, generated from its schema (research/02, "Feature types"). */
/** "Edit ‹document›" for each document an entry uses, which selects it (research/21, "The documents list"). */
function EditDocuments(props: { editor: Editor; documents: { id: string; title: string }[] | undefined }) {
  return (
    <For each={props.documents ?? []}>
      {(d) => (
        <button class="cad-editor__button" data-document={d.id} onClick={() => props.editor.select({ kind: "document", id: d.id }, "dialog")}>
          Edit {d.title}
        </button>
      )}
    </For>
  );
}

export function FeatureDialog(props: { editor: Editor; entry: FeatureEntry; onEditCode: () => void; promote?: FieldProps["promote"]; documents?: { id: string; title: string }[] }) {
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
        <strong>{schema().label}</strong> <code>{props.entry.name}</code> <OnBody editor={props.editor} entry={props.entry} />
        <button class="cad-editor__link" aria-label="close" onClick={() => props.editor.select(undefined, "dialog")}>
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
      <For each={props.entry.trace?.warnings ?? []}>
        {(warning) => (
          <p class="cad-editor__problem" data-status="warning">
            {warning}
          </p>
        )}
      </For>
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
      <Show when={props.editor.chainMode()}>
        {(mode) => (
          <div class="cad-editor__field" data-param="chain">
            <span>Chain</span>
            <div class="cad-editor__segmented" role="radiogroup" aria-label="Chain">
              <button
                role="radio"
                class="cad-editor__segment"
                aria-checked={mode() === "join"}
                disabled={disabled()}
                title="Join: the features after it that worked on its input work on its result"
                onClick={() => props.editor.setChainMode("join")}
              >
                Join
              </button>
              <button
                role="radio"
                class="cad-editor__segment"
                aria-checked={mode() === "branch"}
                disabled={disabled()}
                title="Branch: the features after it work on its input; its result is a body of its own"
                onClick={() => props.editor.setChainMode("branch")}
              >
                Branch
              </button>
            </div>
          </div>
        )}
      </Show>
      <For each={PARAMS[props.entry.type]}>
        {([name, spec]) => (
          <div class="cad-editor__field" data-param={name}>
            <span>{spec.label}</span>
            <Field editor={props.editor} entry={props.entry} name={name} spec={spec} source={props.editor.source()} disabled={disabled()} promote={props.promote} />
          </div>
        )}
      </For>
      <footer class="cad-editor__dialog-footer">
        <button class="cad-editor__button" onClick={() => props.onEditCode()}>
          Edit code
        </button>
        <EditDocuments editor={props.editor} documents={props.documents} />
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

/**
 * The dialog of an entry that has no form, a Custom Script or a body() (research/11): every selected
 * item has a dialog (research/19-selection.md, "The selection"); this one opens the code or deletes it.
 */
export function CodeDialog(props: { editor: Editor; entry: ScriptEntry | FeatureEntry; index: number; onEditCode: () => void; documents?: { id: string; title: string }[] }) {
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const label = () => (props.entry.kind === "feature" ? props.entry.names.join(", ") : `the Custom Script at lines ${props.entry.lines.join("–")}`);
  return (
    <section class="cad-editor__dialog" aria-label={props.entry.kind === "feature" ? `body() ${label()}` : "Custom Script"} data-feature={props.entry.kind === "feature" ? props.entry.name : "script"}>
      <header class="cad-editor__dialog-header">
        <Show when={props.entry.kind === "feature"} fallback={<strong>Custom Script</strong>}>
          <strong>body()</strong> <code>{label()}</code>
        </Show>
        <Show when={props.entry.kind === "script" && props.entry}>{(script) => <span class="cad-editor__muted">lines {script().lines.join("–")}</span>}</Show>
        <button class="cad-editor__link" aria-label="close" onClick={() => props.editor.select(undefined, "dialog")}>
          ×
        </button>
      </header>
      <footer class="cad-editor__dialog-footer">
        <button class="cad-editor__button" onClick={() => props.onEditCode()}>
          Edit code
        </button>
        <EditDocuments editor={props.editor} documents={props.documents} />
        <Show
          when={confirmDelete()}
          fallback={
            <button class="cad-editor__button" disabled={props.editor.syntaxError() !== undefined} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          }
        >
          <button class="cad-editor__button cad-editor__button--danger" onClick={() => void props.editor.remove(props.index).then(props.editor.setNotice)}>
            Delete {label()}
          </button>
        </Show>
      </footer>
    </section>
  );
}
