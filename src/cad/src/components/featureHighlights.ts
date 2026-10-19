import { createEffect, createSignal, on, type Accessor } from "solid-js";
import { isFeatureType, schemas } from "@patchwork-cad/features/schema";
import type { FeatureTrace, MeshedShape } from "../kernel/protocol.ts";
import type { Model } from "./createModel.ts";
import type { Highlight, HighlightStyle } from "./Viewer.tsx";

/**
 * What hovered features made, as highlights, by the feature's choice (`hover` in its schema):
 * `faces`, the faces it owns in the shown bodies, or else in its own result, e.g. past the timeline
 * marker (research/12); `difference`, the volume it added or removed, as a ghost (research/12). The worker's answers are cached until the next build.
 */
export function createFeatureHighlights(model: Model, shown: Accessor<MeshedShape[]>): (names: string[], style: HighlightStyle, color?: string) => Highlight[] {
  const [version, setVersion] = createSignal(0);
  /** Answers by feature or body name; `null` while asked. */
  let results = new Map<string, MeshedShape | undefined | null>();
  let ghosts = new Map<string, MeshedShape[] | null>();
  createEffect(
    on(model.last, () => {
      results = new Map();
      ghosts = new Map();
      setVersion((v) => v + 1);
    }),
  );
  /** The cached answer, asking the worker for it first; undefined until it is there. */
  const ask = <T>(cache: Map<string, T | null>, name: string, load: () => Promise<T>, failed: T): T | undefined => {
    if (!cache.has(name)) {
      cache.set(name, null);
      const asked = cache;
      void load()
        .catch(() => failed)
        .then((answer) => {
          if (asked.get(name) !== null) return;
          asked.set(name, answer);
          setVersion((v) => v + 1);
        });
    }
    return cache.get(name) ?? undefined;
  };
  const entryOf = (name: string): FeatureTrace | undefined => model.trace().find((t) => t.name === name || t.results.includes(name));

  return (names, style, color) => {
    version();
    /** Features shown as ghosts already: a feature's name and its bodies' may both be hovered. */
    const ghosted = new Set<string>();
    return names.flatMap((name): Highlight[] => {
      const entry = entryOf(name);
      if (entry && isFeatureType(entry.type) && schemas[entry.type].hover === "difference") {
        if (ghosted.has(entry.name)) return [];
        ghosted.add(entry.name);
        const parts = ask(ghosts, entry.name, () => model.engine.difference(entry.name), []) ?? [];
        // A shape that isn't a body: each mesh group is a face or edge of its own. Its edges are thin, as the model's, without the hover's outline, which distracts.
        return parts.flatMap((s) => {
          const base = { body: s.name, style, shape: s, ghost: true, ...(color ? { color } : {}) };
          return [
            { ...base, kind: "face" as const, indices: (s.faces.faceGroups ?? [{}]).map((_, i) => i) },
            ...(s.edges ? [{ ...base, kind: "edge" as const, indices: (s.edges.edgeGroups ?? [{}]).map((_, i) => i) }] : []),
          ];
        });
      }
      const inShown = shown().filter((s) => s.features?.[name]);
      // A feature that made nothing in the shown bodies, e.g. one past the marker, or whose faces later features removed, shows on its own result.
      const own = inShown.length || !model.trace().some((t) => t.results.includes(name)) ? undefined : ask(results, name, () => model.engine.result(name), undefined);
      const sources = inShown.length ? inShown.map((s) => ({ s, own: false })) : own?.features?.[name] ? [{ s: own, own: true }] : [];
      return sources.flatMap(({ s, own }) => {
        const owned = s.features![name]!;
        const base = { body: s.body ?? s.name, style, ...(own ? { shape: s } : {}), ...(color ? { color } : {}) };
        return [
          { ...base, kind: "face" as const, indices: owned.faces },
          { ...base, kind: "edge" as const, indices: owned.edges },
        ];
      });
    });
  };
}
