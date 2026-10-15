/**
 * The timeline is a view of the code (research/02, "The timeline is a view"): every `const x =
 * feature({…})` statement of `main` is a feature entry, and every run of other statements up to
 * the next one is a Custom Script entry. Each entry is matched with the feature calls the last
 * build actually ran (the trace), which also shows features that run inside Custom Script code.
 */
import type { FeatureType } from "@patchwork-cad/features/schema";
import type { FeatureTrace } from "../kernel/protocol.ts";
import type { Analysis, FeatureCall, Span } from "./analyze.ts";

export interface FeatureEntry {
  kind: "feature";
  /** The variable name: the identity references use. */
  name: string;
  type: FeatureType;
  call: FeatureCall;
  /** The whole statement. */
  span: Span;
  trace: FeatureTrace | undefined;
}

export interface ScriptEntry {
  kind: "script";
  span: Span;
  /** 1-based lines it covers. */
  lines: [number, number];
  /** Feature calls the last build ran inside this code, e.g. in a loop. */
  features: FeatureTrace[];
}

export type Entry = FeatureEntry | ScriptEntry;

export interface Timeline {
  entries: Entry[];
  /** `return …` of main, which the editor keeps pointing at the visible bodies. */
  returned: Span | undefined;
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

export function timeline(source: string, analysis: Analysis, trace: readonly FeatureTrace[]): Timeline {
  const statements = analysis.main?.statements ?? [];
  const entries: Entry[] = [];
  let script: ScriptEntry | undefined;
  let returned: Span | undefined;
  for (const [i, statement] of statements.entries()) {
    const call = analysis.calls.find((c) => c.statement === statement && c.variable !== undefined && statement.type === "VariableDeclaration" && statement.declarations.length === 1 && statement.declarations[0]!.init?.start === c.span.start);
    const last = i === statements.length - 1;
    if (statement.type === "ReturnStatement" && last) {
      returned = { start: statement.start, end: statement.end };
      script = undefined;
      continue;
    }
    if (call && call.variable) {
      script = undefined;
      const traced = trace.find((t) => t.variable && t.name === call.variable);
      entries.push({ kind: "feature", name: call.variable, type: call.type, call, span: { start: statement.start, end: statement.end }, trace: traced });
      continue;
    }
    if (!script) {
      script = { kind: "script", span: { start: statement.start, end: statement.end }, lines: [0, 0], features: [] };
      entries.push(script);
    }
    script.span.end = statement.end;
  }
  for (const entry of entries) {
    if (entry.kind !== "script") continue;
    entry.lines = [lineAt(source, entry.span.start), lineAt(source, entry.span.end)];
    entry.features = trace.filter((t) => t.line !== undefined && t.line >= entry.lines[0] && t.line <= entry.lines[1]);
  }
  return { entries, returned };
}

/**
 * Where a timeline marker is: before the first entry that ends after its cursor's offset
 * (research/07, "The timeline marker"). The cursor sits on the first character of the entry after
 * the marker and moves to the next surviving character when that text is deleted, so the marker
 * stays between the entries around it when others delete entries on both sides. A cursor that is
 * lost (`offset` undefined, e.g. after the whole text was replaced) falls back to the entry named
 * `next`. `entries.length` is the end.
 */
export function markerPosition(tl: Timeline, offset: number | undefined, next: string | undefined): number {
  const n = tl.entries.length;
  if (offset === undefined) {
    const named = tl.entries.findIndex((e) => e.kind === "feature" && e.name === next);
    return named < 0 ? n : named;
  }
  // An offset inside an entry (its first characters were edited) still means before it.
  const index = tl.entries.findIndex((e) => e.span.end > offset);
  return index < 0 ? n : index;
}
