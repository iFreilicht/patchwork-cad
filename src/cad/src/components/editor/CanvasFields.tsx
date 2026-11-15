import { createEffect, createSignal, For, Show, type Accessor } from "solid-js";
import { calibratedScale, canvasCorners, elementAt, fromFractions, imageDistance, imagePoint, isFrame, isLegacy, onPlane, ORIGIN_PLANES, originPlane, originPlaneOf, planeLabel, repinned, storedPlacement, type CanvasPatch, type ImageBox, type OriginPlane, type Placement } from "../../model/canvases.ts";
import type { PlaneFrame, StoredCanvas } from "../../types.ts";
import type { CanvasStore, PlacedCanvas } from "../canvases.ts";
import { Icon } from "../icons.tsx";
import type { Overlay } from "../Viewer.tsx";
import { PickButton } from "./FeatureDialog.tsx";
import type { Editor } from "./state.ts";

/** The pick target of a canvas's plane: a face picked in the view puts the canvas on it. */
export const CANVAS_PICK = "canvas-face";

/** Picking points of a canvas's image in the view: two for Calibrate, or its anchor. */
export type CanvasPickState = { id: string; mode: "calibrate"; points: [number, number][] } | { id: string; mode: "anchor" };

/**
 * Points of a canvas's image picked in the view (research/21, "Canvas"): Calibrate's two, as
 * fractions of the image, or the element an SVG is pinned by.
 */
export interface Calibration {
  state: Accessor<CanvasPickState | undefined>;
  start(id: string, mode?: CanvasPickState["mode"]): void;
  stop(): void;
  /** A point of the image picked in the view: Calibrate's next, a third starting again, or the anchor's. */
  pick(id: string, point: [number, number]): void;
  /** The point of the image under the pointer, which the overlays show what a click there picks of. */
  hover(id: string, point: [number, number] | undefined): void;
  /** Makes Calibrate's points `distance` apart; says why not. */
  apply(distance: number): string | undefined;
  /** Calibrate's points as crosses on the image, and the line between them, and one under the pointer; the selected canvas's anchor, outlined, and the element under the pointer while one is picked. */
  overlays(): Overlay[];
  /** What to do next, for the status bar. */
  status(): string | undefined;
}

/** A canvas's patch with where it lies, rounded: a canvas stored with a centre and width is stored with a scale with it. */
export const placedPatch = (canvas: StoredCanvas, placement: Placement | undefined, patch: CanvasPatch): CanvasPatch =>
  isLegacy(canvas) && placement ? { ...storedPlacement(placement), ...patch } : patch;

/**
 * Picking points of a canvas's image: started for a canvas, it ends with that canvas's dialog and
 * when a field starts picking. Calibrate scales the image about its pinned point, which stays where
 * it is; an anchor picked pins the image by its centre, leaving it where it is.
 */
export function createCalibration(props: { canvases: CanvasStore; placed: Accessor<PlacedCanvas[]>; selected: Accessor<string | undefined>; picking: Accessor<boolean>; stopPicking(): void; setNotice(notice: string | undefined): void }): Calibration {
  const [state, setState] = createSignal<CanvasPickState>();
  const [hovered, setHovered] = createSignal<[number, number]>();
  createEffect(() => {
    const s = state();
    if (s && (props.selected() !== s.id || props.picking())) setState(undefined);
  });
  createEffect(() => !state() && setHovered(undefined));
  /** A canvas, where it lies, and its image, drawn. */
  const placedOf = (id: string | undefined) => {
    const placed = id === undefined ? undefined : props.placed().find((p) => p.canvas.id === id);
    return placed?.frame && placed.image ? { canvas: placed.canvas, frame: placed.frame, ...placed.image } : undefined;
  };
  const calibrating = () => {
    const s = state();
    const c = s?.mode === "calibrate" ? placedOf(s.id) : undefined;
    return s?.mode === "calibrate" && c ? { ...c, points: s.points } : undefined;
  };
  return {
    state,
    start(id, mode = "calibrate") {
      props.stopPicking();
      setState(mode === "calibrate" ? { id, mode, points: [] } : { id, mode });
    },
    stop: () => setState(undefined),
    hover: (id, point) => setHovered(state()?.id === id ? point : undefined),
    pick(id, point) {
      const s = state();
      if (s?.id !== id) return;
      if (s.mode === "calibrate") return setState({ id, mode: "calibrate", points: s.points.length >= 2 ? [point] : [...s.points, point] });
      const c = placedOf(id);
      const element = c?.elements && elementAt(c.elements, fromFractions(c.box, point));
      if (!c || !element) return props.setNotice("No element with an id there.");
      props.setNotice(undefined);
      setState(undefined);
      const box = element.box;
      props.canvases.update(id, { ...storedPlacement(repinned(c.placement, [box.x + box.width / 2, box.y + box.height / 2])), anchor: { attribute: element.attribute, value: element.value, ...(element.name ? { name: element.name } : {}) } });
    },
    apply(distance) {
      const c = calibrating();
      if (!c || c.points.length !== 2) return "Pick two points of the image first.";
      const scale = calibratedScale(c.box, [c.points[0]!, c.points[1]!], distance);
      if (scale === undefined) return "The two points are the same.";
      setState(undefined);
      props.canvases.update(c.canvas.id, placedPatch(c.canvas, c.placement, { scale }));
      return undefined;
    },
    overlays() {
      const selected = placedOf(props.selected());
      const outline = (box: ImageBox): Overlay => ({ points: canvasCorners(selected!.placement, selected!.frame, box), closed: true });
      const anchor: Overlay[] = selected?.anchor ? [outline(selected.anchor.box)] : [];
      const s = state();
      const pointer = hovered();
      if (s?.mode === "anchor" && selected && pointer) {
        const under = selected.elements && elementAt(selected.elements, fromFractions(selected.box, pointer));
        return under ? [...anchor, outline(under.box)] : anchor;
      }
      const c = calibrating();
      if (!c) return anchor;
      const points = [...c.points, ...(pointer && c.points.length < 2 ? [pointer] : [])].map((uv) => imagePoint(c.placement, c.box, uv));
      const r = (c.placement.scale * c.box.width) / 60;
      const crosses = points.flatMap(([x, y]): Overlay[] => [
        { points: [onPlane(c.frame, [x - r, y - r]), onPlane(c.frame, [x + r, y + r])], closed: false },
        { points: [onPlane(c.frame, [x - r, y + r]), onPlane(c.frame, [x + r, y - r])], closed: false },
      ]);
      return [...anchor, ...crosses, ...(points.length === 2 ? [{ points: points.map((p) => onPlane(c.frame, p)), closed: false }] : [])];
    },
    status() {
      const s = state();
      if (s?.mode === "anchor") return "Pick anchor: click an element of the image";
      const n = s?.points.length;
      return n === undefined ? undefined : n < 2 ? `Calibrate: click the ${n ? "second" : "first"} of two points of the image` : "Calibrate: type the distance of the two points";
    },
  };
}

/** What a canvas's fields show and change. */
export interface CanvasOptions {
  canvases: CanvasStore;
  placed: Accessor<PlacedCanvas[]>;
  calibration: Calibration;
}

/** Rounded for showing, as a field shows a stored value. */
const show = (x: number) => String(Math.round(x * 1e4) / 1e4);

/**
 * A number field that applies each valid number as it is typed, or with `live` false on Enter and
 * when it is left; Escape restores the value it had when it got the focus. `valid` limits it, e.g. to
 * positive numbers.
 */
function NumberInput(props: { value: number | undefined; label: string; title?: string; disabled?: boolean; live?: boolean; valid?: (n: number) => boolean; commit: (n: number) => void }) {
  let input!: HTMLInputElement;
  let before = "";
  createEffect(() => {
    const value = props.value === undefined ? "" : show(props.value);
    if (document.activeElement !== input) input.value = value;
  });
  const parse = () => {
    const text = input.value.trim();
    const n = text === "" ? NaN : Number(text);
    return Number.isFinite(n) && (props.valid?.(n) ?? true) ? n : undefined;
  };
  const commit = () => {
    const n = parse();
    input.classList.toggle("cad-editor__input--invalid", n === undefined && input.value.trim() !== "");
    if (n !== undefined && n !== props.value) props.commit(n);
  };
  return (
    <input
      ref={input}
      class="cad-editor__input"
      inputmode="decimal"
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onFocus={() => (before = input.value)}
      onInput={() => props.live !== false && commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape" && input.value !== before) {
          event.preventDefault();
          input.value = before;
          commit();
        }
      }}
      onBlur={() => {
        commit();
        input.classList.remove("cad-editor__input--invalid");
        input.value = props.value === undefined ? "" : show(props.value);
      }}
    />
  );
}

/**
 * A canvas's own fields (research/21, "The document dialog"): its name; the plane it is on, an
 * origin plane with an offset or a face picked in the view; where its pinned point is there, its
 * angle about it and its width, the scale times the image's, which Calibrate sets from two points of
 * the image and their distance; the element of an SVG it is pinned by; its opacity; and whether it
 * is drawn through the model.
 */
export function CanvasFields(props: { canvas: StoredCanvas; options: CanvasOptions; editor: Editor }) {
  const c = () => props.canvas;
  const store = () => props.options.canvases;
  const placed = () => props.options.placed().find((p) => p.canvas.id === c().id);
  const image = () => placed()?.image;
  /** Where the image lies: as drawn, or as stored while it isn't; a canvas stored with a centre and width only once it is drawn. */
  const placement = (): Placement | undefined => {
    const canvas = c();
    return image()?.placement ?? (isLegacy(canvas) ? undefined : canvas);
  };
  const update = (patch: CanvasPatch) => store().update(c().id, placedPatch(c(), placement(), patch));
  const origin = () => (isFrame(c().plane) ? originPlaneOf(c().plane as PlaneFrame) : undefined);
  const picking = () => {
    const s = props.options.calibration.state();
    return s?.id === c().id ? s : undefined;
  };
  const calibrating = () => {
    const s = picking();
    return s?.mode === "calibrate" ? s : undefined;
  };
  /** The distance of Calibrate's two points, once both are picked. */
  const distance = () => {
    const s = calibrating();
    const i = image();
    return s?.points.length === 2 && i ? imageDistance(i.placement, i.box, s.points as [[number, number], [number, number]]) : undefined;
  };
  const width = () => {
    const i = image();
    return i && i.placement.scale * i.box.width;
  };
  const anchor = () => {
    const canvas = c();
    return isLegacy(canvas) ? undefined : canvas.anchor;
  };
  const anchorLabel = () => {
    const a = anchor();
    return a && (a.name || image()?.anchor?.label || `${a.attribute === "id" ? "#" : ""}${a.value}`);
  };
  const problem = () => {
    const p = placed()?.problem;
    return p === "gone" ? "Its face isn't in the model" : p === "not planar" ? "Its face isn't planar" : p === "hidden" ? "Its face isn't shown here" : undefined;
  };
  return (
    <>
      <div class="cad-editor__field" data-param="name">
        <span>Name</span>
        <input
          class="cad-editor__input"
          aria-label="Name"
          value={c().name}
          onChange={(event) => {
            const name = event.currentTarget.value.trim();
            if (name) update({ name });
            else event.currentTarget.value = c().name;
          }}
        />
      </div>
      <div class="cad-editor__field" data-param="plane">
        <span>Plane</span>
        <div class="cad-editor__refs">
          <select
            class="cad-editor__input"
            aria-label="Plane"
            onChange={(event) => {
              const name = event.currentTarget.value as OriginPlane;
              if (name in ORIGIN_PLANES) update({ plane: originPlane(name, origin()?.offset ?? 0) });
            }}
          >
            <Show when={!origin()}>
              <option value="" selected>
                {planeLabel(c().plane)}
              </option>
            </Show>
            <For each={Object.keys(ORIGIN_PLANES) as OriginPlane[]}>
              {(name) => (
                <option value={name} selected={origin()?.name === name}>
                  {name}
                </option>
              )}
            </For>
          </select>
          <Show when={origin()}>{(o) => <NumberInput label="Offset" title="Offset along the plane's normal" value={o().offset} commit={(offset) => update({ plane: originPlane(o().name, offset) })} />}</Show>
          <PickButton editor={props.editor} param={CANVAS_PICK} kind="face" multi={false} disabled={false} label="Select face" />
          <Show when={problem()}>
            {(why) => (
              <span class="cad-editor__document-state" data-state="unavailable" title={why()} aria-label={why()} role="img">
                <Icon name="TriangleAlert" size={12} />
              </span>
            )}
          </Show>
        </div>
      </div>
      <div class="cad-editor__field" data-param="position">
        <span>Position</span>
        <div class="cad-editor__grid">
          <label class="cad-editor__subfield">
            <span>x</span>
            <NumberInput label="Position x" title={anchor() ? "Where the anchor's centre is" : "Where the pinned point of the image is"} disabled={!placement()} value={placement()?.position[0]} commit={(x) => update({ position: [x, placement()!.position[1]] })} />
          </label>
          <label class="cad-editor__subfield">
            <span>y</span>
            <NumberInput label="Position y" title={anchor() ? "Where the anchor's centre is" : "Where the pinned point of the image is"} disabled={!placement()} value={placement()?.position[1]} commit={(y) => update({ position: [placement()!.position[0], y] })} />
          </label>
        </div>
      </div>
      <div class="cad-editor__field" data-param="angle">
        <span>Angle</span>
        <div class="cad-editor__scalar">
          <NumberInput label="Angle" title="Rotation about the plane's normal, in degrees" disabled={!placement()} value={c().angle} commit={(angle) => update({ angle })} />
          <span class="cad-editor__muted">°</span>
        </div>
      </div>
      <div class="cad-editor__field" data-param="width">
        <span>Width</span>
        <div class="cad-editor__refs">
          <div class="cad-editor__scalar cad-editor__canvas-size">
            <NumberInput label="Width" disabled={!image()} value={width()} valid={(n) => n > 0} commit={(w) => update({ scale: w / image()!.box.width })} />
            <Show when={image()}>{(i) => <span class="cad-editor__muted" title="Height, from the image's aspect">× {show(i().placement.scale * i().box.height)}</span>}</Show>
          </div>
          <button
            class="cad-editor__button"
            aria-pressed={!!calibrating()}
            disabled={!image() || !placed()?.frame}
            title="Scale it by the distance of two points of the image"
            onClick={() => (calibrating() ? props.options.calibration.stop() : props.options.calibration.start(c().id))}
          >
            {calibrating() ? "Cancel" : "Calibrate"}
          </button>
        </div>
      </div>
      {/* Its value doesn't read the Show's accessor: the field's blur, when it is removed, reads it after the Show has switched. */}
      <Show when={distance() !== undefined}>
        <div class="cad-editor__field" data-param="distance">
          <span>Distance</span>
          <div class="cad-editor__scalar">
            <NumberInput label="Distance" title="The distance of the two points, which sets the width" live={false} valid={(n) => n > 0} value={distance()} commit={(d) => props.editor.setNotice(props.options.calibration.apply(d))} />
          </div>
        </div>
      </Show>
      <div class="cad-editor__field" data-param="canvas-anchor">
        <span>Anchor</span>
        <div class="cad-editor__refs">
          <span class="cad-editor__muted" data-anchor={anchor()?.value}>{anchorLabel() ?? "None"}</span>
          <Show when={placed()?.anchorLost}>
            <span class="cad-editor__document-state" data-state="unavailable" title="The image has no such element" aria-label="The image has no such element" role="img">
              <Icon name="TriangleAlert" size={12} />
            </span>
          </Show>
          <button
            class="cad-editor__button"
            aria-pressed={picking()?.mode === "anchor"}
            disabled={!image()?.elements?.length || !placed()?.frame}
            title="Pin the image by an element of it, which stays where it is as the image changes"
            onClick={() => (picking()?.mode === "anchor" ? props.options.calibration.stop() : props.options.calibration.start(c().id, "anchor"))}
          >
            {picking()?.mode === "anchor" ? "Cancel" : "Pick anchor"}
          </button>
          <Show when={anchor()}>
            <button class="cad-editor__button" aria-label="Remove anchor" title="Pin the image by where the anchor is now" onClick={() => update({ anchor: null, ...(image() ? storedPlacement(image()!.placement) : {}) })}>
              Remove
            </button>
          </Show>
        </div>
      </div>
      <div class="cad-editor__field" data-param="opacity">
        <span>Opacity</span>
        <div class="cad-editor__scalar">
          <input class="cad-editor__range" type="range" min="0" max="100" step="5" aria-label="Opacity" value={Math.round(c().opacity * 100)} onInput={(event) => update({ opacity: Number(event.currentTarget.value) / 100 })} />
          <span class="cad-editor__muted">{Math.round(c().opacity * 100)}%</span>
        </div>
      </div>
      <div class="cad-editor__field" data-param="through">
        <span>Display</span>
        <label class="cad-editor__check">
          <input type="checkbox" checked={c().through} onChange={(event) => update({ through: event.currentTarget.checked })} />
          <span>through the model</span>
        </label>
      </div>
    </>
  );
}
