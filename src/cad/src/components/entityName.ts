import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { RefData } from "../kernel/protocol.ts";
import type { Model } from "./createModel.ts";
import type { Entity } from "./Viewer.tsx";

/**
 * The reference of a face or edge, as a pick would write it (research/12): its code, e.g.
 * `extrude1.side.front`, and as data for collaborators (research/13). `set` asks the worker for it
 * after `delayMs`, so that a pointer moving across the model doesn't flood the worker with requests.
 */
export function createEntityName(model: Model, delayMs: number): { name: Accessor<string | undefined>; ref: Accessor<RefData | undefined>; set: (entity: Entity | undefined) => void } {
  const [picked, setPicked] = createSignal<{ code: string; ref: RefData | undefined }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Entity | undefined;
  const set = (entity: Entity | undefined) => {
    clearTimeout(timer);
    current = entity;
    setPicked(undefined);
    if (!entity) return;
    timer = setTimeout(() => {
      model.engine.pick(entity.body, entity.kind, entity.index).then(
        (answer) => current === entity && setPicked(answer),
        () => undefined,
      );
    }, delayMs);
  };
  onCleanup(() => clearTimeout(timer));
  return { name: () => picked()?.code || undefined, ref: () => picked()?.ref, set };
}
