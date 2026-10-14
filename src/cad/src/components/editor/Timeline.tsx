import { For, Index, Match, Switch } from "solid-js";
import { schemas } from "@patchwork-cad/features/schema";
import type { FeatureTrace } from "../../kernel/protocol.ts";
import type { Entry, FeatureEntry, ScriptEntry } from "../../model/timeline.ts";
import type { Editor } from "./state.ts";

// U+FE0E asks for the text form of each symbol: browsers may draw some as emoji, which ignore CSS colors.
const GLYPHS: Record<string, string> = { sketch: "✎\uFE0E", extrude: "⬆\uFE0E", fillet: "◜\uFE0E", chamfer: "◸\uFE0E" };

/** A feature's status in the timeline; an unused result greys out a feature that built fine. */
const status = (trace: FeatureTrace | undefined) => (!trace ? "not-run" : trace.status === "ok" && trace.unused ? "unused" : trace.status);

const UNUSED = "\nUnused: no later feature uses its result, and the model doesn't return it.";

function FeatureItem(props: { editor: Editor; entry: FeatureEntry }) {
  const label = () => schemas[props.entry.type].label;
  return (
    <button
      class="cad-editor__entry"
      data-kind="feature"
      data-name={props.entry.name}
      data-status={status(props.entry.trace)}
      aria-pressed={props.editor.open()?.name === props.entry.name}
      title={`${label()} ${props.entry.name}${props.entry.trace?.message ? `\n${props.entry.trace.message}` : ""}${props.entry.trace?.unused ? UNUSED : ""}`}
      onClick={() => props.editor.openFeature(props.editor.open()?.name === props.entry.name ? undefined : props.entry)}
    >
      <span class="cad-editor__glyph">{GLYPHS[props.entry.type]}</span>
      <span>{props.entry.name}</span>
    </button>
  );
}

/**
 * Code the timeline doesn't recognize as features (research/02, "Custom Script"). It lists the
 * feature calls the last build ran inside it, which is how references into it can be followed.
 */
function ScriptItem(props: { entry: ScriptEntry; onOpen: (entry: ScriptEntry) => void }) {
  const broken = () => props.entry.features.find((f) => status(f) !== "ok");
  return (
    <button
      class="cad-editor__entry cad-editor__entry--script"
      data-kind="script"
      data-lines={props.entry.lines.join("-")}
      data-status={broken() ? status(broken()) : "ok"}
      title={`Custom Script, lines ${props.entry.lines.join("–")}`}
      onClick={() => props.onOpen(props.entry)}
    >
      <span class="cad-editor__glyph">{"{ }"}</span>
      <span>
        lines {props.entry.lines[0]}–{props.entry.lines[1]}
      </span>
      <For each={props.entry.features}>
        {(f) => (
          <span class="cad-editor__ran" data-name={f.name} data-status={status(f)} title={`${f.type} ${f.name}${f.message ? `\n${f.message}` : ""}${f.unused ? UNUSED : ""}`}>
            {GLYPHS[f.type]} {f.name}
          </span>
        )}
      </For>
    </button>
  );
}

/** The timeline: one entry per feature statement or Custom Script run, in text order. */
export function Timeline(props: { editor: Editor; onOpenScript: (entry: ScriptEntry) => void }) {
  return (
    <nav class="cad-editor__timeline" aria-label="Timeline">
      {/* By position: entries are new objects after every change, and their buttons should stay. */}
      <Index each={props.editor.timeline().entries}>
        {(entry: () => Entry) => (
          <Switch>
            <Match when={entry().kind === "feature" && (entry() as FeatureEntry)}>{(e) => <FeatureItem editor={props.editor} entry={e()} />}</Match>
            <Match when={entry().kind === "script" && (entry() as ScriptEntry)}>{(e) => <ScriptItem entry={e()} onOpen={props.onOpenScript} />}</Match>
          </Switch>
        )}
      </Index>
    </nav>
  );
}
