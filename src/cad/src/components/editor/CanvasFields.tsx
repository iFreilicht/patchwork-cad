import { createEffect, createSignal, For, Show, type Accessor } from "solid-js";
import { calibratedWidth, imageDistance, imagePoint, isFrame, onPlane, ORIGIN_PLANES, originPlane, originPlaneOf, planeLabel, type OriginPlane } from "../../model/canvases.ts";
import type { Canvas, PlaneFrame } from "../../types.ts";
import { DEFAULT_DOCUMENT_ASPECT } from "../documentCanvases.ts";
import type { CanvasStore, ImageState, PlacedCanvas } from "../canvases.ts";
import { Icon } from "../icons.tsx";
import type { Overlay } from "../Viewer.tsx";
import { PickButton } from "./FeatureDialog.tsx";
import type { Editor } from "./state.ts";

/** The pick target of a canvas's plane: a face picked in the view puts the canvas on it. */
export const CANVAS_PICK = "canvas-face";

/** Calibrate (research/21, "Canvas"): the canvas whose image's points are picked, and those picked so far, as fractions of the image. */
export interface Calibration {
  state: Accessor<{ id: string; points: [number, number][] } | undefined>;
  start(id: string): void;
  stop(): void;
  /** A point of the image picked in the view; a third starts again. */
  pick(id: string, point: [number, number]): void;
  /** Makes the picked points `distance` apart; says why not. */
  apply(distance: number): string | undefined;
  /** The picked points as crosses on the image, and the line between them. */
  overlays(): Overlay[];
  /** What to do next, for the status bar. */
  status(): string | undefined;
}

/**
 * Calibrate's state: started for a canvas, it ends with that canvas's dialog and when a field starts
 * picking. Setting the width scales the canvas about its centre, which stays where it is.
 */
export function createCalibration(props: {
  canvases: CanvasStore;
  placed: Accessor<PlacedCanvas[]>;
  image(url: string): ImageState;
  selected: Accessor<string | undefined>;
  picking: Accessor<boolean>;
  stopPicking(): void;
  /** What else scaling a canvas sets, e.g. a document's fit, so that its scale stays when the document grows. */
  onScale?(canvas: Canvas): Parameters<CanvasStore["update"]>[1];
}): Calibration {
  const [state, setState] = createSignal<{ id: string; points: [number, number][] }>();
  createEffect(() => {
    const s = state();
    if (s && (props.selected() !== s.id || props.picking())) setState(undefined);
  });
  /** The canvas being calibrated, where it lies, and its image's aspect. */
  const current = () => {
    const s = state();
    const placed = s && props.placed().find((p) => p.canvas.id === s.id);
    const image = placed && props.image(placed.canvas.image);
    const aspect = image?.status === "ready" ? image.aspect : image?.status === "document" ? (placed!.canvas.aspect ?? DEFAULT_DOCUMENT_ASPECT) : undefined;
    return s && placed?.frame && aspect !== undefined ? { points: s.points, canvas: placed.canvas, frame: placed.frame, aspect } : undefined;
  };
  return {
    state,
    start(id) {
      props.stopPicking();
      setState({ id, points: [] });
    },
    stop: () => setState(undefined),
    pick(id, point) {
      const s = state();
      if (s?.id === id) setState({ id, points: s.points.length >= 2 ? [point] : [...s.points, point] });
    },
    apply(distance) {
      const c = current();
      if (!c || c.points.length !== 2) return "Pick two points of the image first.";
      const width = calibratedWidth(c.aspect, [c.points[0]!, c.points[1]!], distance);
      if (width === undefined) return "The two points are the same.";
      setState(undefined);
      props.canvases.update(c.canvas.id, { ...props.onScale?.(c.canvas), width });
      return undefined;
    },
    overlays() {
      const c = current();
      if (!c) return [];
      const points = c.points.map((uv) => imagePoint(c.canvas, c.aspect, uv));
      const r = c.canvas.width / 60;
      const crosses = points.flatMap(([x, y]): Overlay[] => [
        { points: [onPlane(c.frame, [x - r, y - r]), onPlane(c.frame, [x + r, y + r])], closed: false },
        { points: [onPlane(c.frame, [x - r, y + r]), onPlane(c.frame, [x + r, y - r])], closed: false },
      ]);
      return points.length === 2 ? [...crosses, { points: points.map((p) => onPlane(c.frame, p)), closed: false }] : crosses;
    },
    status() {
      const n = state()?.points.length;
      return n === undefined ? undefined : n < 2 ? `Calibrate: click the ${n ? "second" : "first"} of two points of the image` : "Calibrate: type the distance of the two points";
    },
  };
}

/** What a canvas's fields show and change. */
export interface CanvasOptions {
  canvases: CanvasStore;
  placed: Accessor<PlacedCanvas[]>;
  image(url: string): ImageState;
  calibration: Calibration;
  /** Experiment: a document canvas's fit and editing in place. */
  documents?: DocumentCanvasOptions;
}

/** Experiment: what a canvas of a document that isn't an image offers besides an image's fields. */
export interface DocumentCanvasOptions {
  /** Whether its document's part on the canvas can be fitted to what it holds, as a tldraw drawing's. */
  fits(canvas: Canvas): boolean;
  /** Shows all of the document on the canvas. */
  fit(canvas: Canvas): void;
  /** Whether it can be edited in place: following its document, which is loaded. */
  editable(canvas: Canvas): boolean;
  /** The canvas edited in place, if any. */
  editing: Accessor<string | undefined>;
  edit(canvas: Canvas): void;
  done(): void;
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
 * origin plane with an offset or a face picked in the view; its centre there, angle and width, which
 * Calibrate sets from two points of the image and their distance; its opacity; and whether it is
 * drawn through the model.
 */
export function CanvasFields(props: { canvas: Canvas; options: CanvasOptions; editor: Editor }) {
  const c = () => props.canvas;
  const store = () => props.options.canvases;
  const update = (patch: Parameters<CanvasStore["update"]>[1]) => store().update(c().id, patch);
  const placed = () => props.options.placed().find((p) => p.canvas.id === c().id);
  const origin = () => (isFrame(c().plane) ? originPlaneOf(c().plane as PlaneFrame) : undefined);
  const image = () => props.options.image(c().image);
  const isDocument = () => image().status === "document";
  const aspect = () => {
    const i = image();
    return i.status === "ready" ? i.aspect : i.status === "document" ? (c().aspect ?? DEFAULT_DOCUMENT_ASPECT) : undefined;
  };
  const docs = () => (isDocument() ? props.options.documents : undefined);
  const calibrating = () => {
    const s = props.options.calibration.state();
    return s?.id === c().id ? s : undefined;
  };
  /** The distance of Calibrate's two points, once both are picked. */
  const distance = () => {
    const s = calibrating();
    const a = aspect();
    return s?.points.length === 2 && a !== undefined ? imageDistance(c(), a, s.points as [[number, number], [number, number]]) : undefined;
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
      <div class="cad-editor__field" data-param="center">
        <span>Center</span>
        <div class="cad-editor__grid">
          <label class="cad-editor__subfield">
            <span>x</span>
            <NumberInput label="Center x" value={c().center[0]} commit={(x) => update({ center: [x, c().center[1]] })} />
          </label>
          <label class="cad-editor__subfield">
            <span>y</span>
            <NumberInput label="Center y" value={c().center[1]} commit={(y) => update({ center: [c().center[0], y] })} />
          </label>
        </div>
      </div>
      <div class="cad-editor__field" data-param="angle">
        <span>Angle</span>
        <div class="cad-editor__scalar">
          <NumberInput label="Angle" title="Rotation about the plane's normal, in degrees" value={c().angle} commit={(angle) => update({ angle })} />
          <span class="cad-editor__muted">°</span>
        </div>
      </div>
      <div class="cad-editor__field" data-param="width">
        <span>Width</span>
        <div class="cad-editor__refs">
          <div class="cad-editor__scalar cad-editor__canvas-size">
            <NumberInput label="Width" value={c().width} valid={(n) => n > 0} commit={(width) => update({ width })} />
            <Show when={aspect()}>{(a) => <span class="cad-editor__muted" title="Height, from the image's aspect">× {show(c().width * a())}</span>}</Show>
          </div>
          <button
            class="cad-editor__button"
            aria-pressed={!!calibrating()}
            disabled={!aspect() || !placed()?.frame}
            title="Scale it by the distance of two points of the image"
            onClick={() => (calibrating() ? props.options.calibration.stop() : props.options.calibration.start(c().id))}
          >
            {calibrating() ? "Cancel" : "Calibrate"}
          </button>
        </div>
      </div>
      <Show when={docs()}>
        {(d) => (
          <>
            <div class="cad-editor__field" data-param="height">
              <span>Height</span>
              <div class="cad-editor__refs">
                <div class="cad-editor__scalar cad-editor__canvas-size">
                  <NumberInput label="Height" value={c().width * (aspect() ?? DEFAULT_DOCUMENT_ASPECT)} valid={(n) => n > 0} commit={(height) => update({ aspect: height / c().width })} />
                </div>
                <Show when={d().fits(c())}>
                  <button class="cad-editor__button" title="Show all of the drawing on the canvas" onClick={() => d().fit(c())}>
                    Fit
                  </button>
                </Show>
              </div>
            </div>
            <div class="cad-editor__field" data-param="edit">
              <span>Document</span>
              <div class="cad-editor__refs">
                <button
                  class="cad-editor__button"
                  aria-pressed={d().editing() === c().id}
                  disabled={d().editing() !== c().id && !d().editable(c())}
                  title={d().editable(c()) ? "Edit it here, face on" : "A pinned version can't be edited"}
                  onClick={() => (d().editing() === c().id ? d().done() : d().edit(c()))}
                >
                  {d().editing() === c().id ? "Done" : "Edit in place"}
                </button>
              </div>
            </div>
          </>
        )}
      </Show>
      {/* Its value doesn't read the Show's accessor: the field's blur, when it is removed, reads it after the Show has switched. */}
      <Show when={distance() !== undefined}>
        <div class="cad-editor__field" data-param="distance">
          <span>Distance</span>
          <div class="cad-editor__scalar">
            <NumberInput label="Distance" title="The distance of the two points, which sets the width" live={false} valid={(n) => n > 0} value={distance()} commit={(d) => props.editor.setNotice(props.options.calibration.apply(d))} />
          </div>
        </div>
      </Show>
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
