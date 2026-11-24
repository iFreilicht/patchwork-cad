// The builds models show in this page, by the model's URL (research/23-scene-editing.md): a scene
// that builds a model its editor has just built, e.g. after the same edit, takes the editor's result
// instead of building it again in a kernel of its own.

import type { BuildResult } from "../kernel/engine.ts";
import type { BuildParams, RefData } from "../kernel/protocol.ts";

/** The same values of parameters, whichever order their keys are in. */
export const paramsKey = (params: BuildParams | undefined) => (params ? JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))) : "");

/** A build a model shows: what it was built from, and the result. */
export interface SharedBuild {
  source: string;
  /** Its parameters' `paramsKey`. */
  params: string;
  /** Its imports' read key (`ReadImports.key`): the documents and the versions they were read at. */
  imports: string;
  result: Extract<BuildResult, { ok: true }>;
  /** Locates references in the build, in the kernel that made it. */
  locate(bodies: string[], refs: RefData[]): Promise<{ body: string; indices: number[] }[][]>;
}

interface Sharer {
  building(): boolean;
  shown: SharedBuild | undefined;
}

const sharers = new Map<string, Set<Sharer>>();

/** Shares a model's builds while it is shown; → stop. */
export function shareBuilds(url: string, building: () => boolean): { show(build: SharedBuild | undefined): void; stop(): void } {
  const sharer: Sharer = { building, shown: undefined };
  let set = sharers.get(url);
  if (!set) sharers.set(url, (set = new Set()));
  set.add(sharer);
  return {
    show: (build) => void (sharer.shown = build),
    stop() {
      set.delete(sharer);
      if (!set.size) sharers.delete(url);
    },
  };
}

/** How long a build waits for a model that is building in this page, before it builds itself. */
const WAIT_MS = 30_000;
const POLL_MS = 100;

/**
 * A build of `url` shown in this page from exactly this source, parameters and imports: once nothing
 * in the page is building it any more, as the same change usually starts the editor's build too.
 * Undefined if none is, e.g. without an editor open, or one that shows another configuration.
 */
export async function sharedBuild(url: string, source: string, params: string, imports: string): Promise<SharedBuild | undefined> {
  if (!sharers.has(url)) return undefined;
  const until = Date.now() + WAIT_MS;
  while ([...(sharers.get(url) ?? [])].some((s) => s.building()) && Date.now() < until) await new Promise((r) => setTimeout(r, POLL_MS));
  for (const s of sharers.get(url) ?? []) if (!s.building() && s.shown && s.shown.source === source && s.shown.params === params && s.shown.imports === imports) return s.shown;
  return undefined;
}
