// The editor's 3D view drawn in a scene (ViewerProps, as Viewer.tsx is): the model's live build as
// meshes in a layer of the scene's world, with the scene's own three.js (a scene's renderer can't
// draw another copy's objects), picked by raycasting those meshes here, since the scene's own hits
// don't say which face. Input comes from the scene's hand stack (editTool.tsx); the scene keeps the
// camera, so the view's camera props (view, home, ViewCube, faceRefs) mean nothing here.
//
// The model is Z up in millimetres; the layer's frame is the scene object's, Y up in metres.

import { createEffect, onCleanup, type Component } from "solid-js";
import type * as Three from "three";
import type { MeshedShape } from "../kernel/protocol.ts";
import { luminance, themeColor, type Entity, type EntityKind, type Highlight, type HighlightStyle, type Overlay, type ViewerApi, type ViewerProps, type ViewerTestHook } from "../components/Viewer.tsx";
import { wideLines } from "./wideLines.js";

/** What the e2e helpers ask of a view (`ViewerTestHook`), as far as a scene has it. */
export type SceneTestHook = Pick<ViewerTestHook, "entities" | "screenPoint" | "highlighted" | "centroid">;

/** An entity as `body:kind:index`, for tests, as Viewer.tsx's. */
const entityKey = (e: Entity | undefined) => (e ? `${e.body}:${e.kind}:${e.index}` : "");
const sameEntity = (a: Entity | undefined, b: Entity | undefined) => !!a && !!b && a.body === b.body && a.kind === b.kind && a.index === b.index;

export interface SceneHost {
  /** The scene's three.js: every object drawn in its layer is made with it. */
  THREE: typeof Three;
  /** A group in the stage's frame, kept out of the scene's picking. */
  layer: Three.Group;
  /** The scene object's drawn matrix in the stage (16 numbers, column-major), or null while it has none. */
  frame(): number[] | null;
  /** The ray through port pixel (x, y), in the stage's frame. */
  ray(x: number, y: number): { origin: number[]; dir: number[] } | null;
  /** A port pixel of a client point, or null if it is outside the port. */
  port(clientX: number, clientY: number): { x: number; y: number } | null;
  /** Where a point in the stage's frame is on the screen, in client pixels, and whether the port shows it; null while there is no camera. */
  project(point: number[]): { x: number; y: number; visible: boolean } | null;
  invalidate(): void;
  /** Calls `fn` once before the next frame is drawn. */
  nextFrame(fn: () => void): void;
}

/** A pointer event as the scene hands it to a hand: port pixels and client pixels. */
export interface HandEvent {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  buttons?: number;
  locked?: boolean;
}

/** How near (px) the pointer must be to an edge to hover it, as Viewer.tsx's. */
const EDGE_PX = 6;

type Line = InstanceType<ReturnType<typeof wideLines>["LineMaterial"]>;
type HighlightMaterials = { face: Three.Material; line: { core: Line; halo: Line } };
/** The materials of the view, in the theme's colours as Viewer.tsx's (research/14-edge-contrast.md). */
interface Materials {
  face: Three.MeshStandardMaterial;
  fadedFace: Three.MeshStandardMaterial;
  edge: Line;
  fadedEdge: Line;
  sketch: Line;
  highlight: Record<Exclude<HighlightStyle, "peer">, HighlightMaterials>;
  /** Around a hovered selected edge. */
  ring: { line: Line; halo: Line };
  peer(css: string): HighlightMaterials;
  /** A ghost's edges, as wide as the model's, in the highlight's colour (`""`: the accent's). */
  ghost(css: string): Line;
  dispose(): void;
}

type Drawn = { shape: MeshedShape; mesh: Three.Mesh; wide: InstanceType<ReturnType<typeof wideLines>["LineSegments2"]> | undefined };
type Hit = { entity: Entity | undefined; point: [number, number, number]; t: number };

/** The index of the group of `groups` that holds `at`, -1 if none. */
const groupAt = (groups: { start: number; count: number }[] | undefined, at: number) => (groups ?? []).findIndex((g) => at >= g.start && at < g.start + g.count);
/** An entity's index in its body from its group's, as Viewer.tsx's `groupEntity`. */
const entityIndex = (indexOf: number[] | undefined, group: number) => (indexOf ? (indexOf[group] ?? -1) : group);

export interface SceneView {
  /** The view for the editor's `viewer` prop; mount at most one at a time. */
  Viewer: Component<ViewerProps>;
  /** The hand's input: moves hover, clicks pick or select, a menu opens the editor's context menu. */
  input: {
    move(ev: HandEvent): boolean;
    click(ev: HandEvent): boolean;
    menu(ev: HandEvent): boolean;
    /** The pointer left the view: nothing is hovered. */
    leave(): void;
    cursor(): string | null;
  };
  /** The scene object moved: draw the model where it is now. */
  moved(): void;
  /** What is under the pointer now, for tests. */
  hovered(): Entity | undefined;
  /** What is at port pixel (x, y), for tests. */
  at(x: number, y: number): { entity: Entity | undefined; point: [number, number, number] } | undefined;
  dispose(): void;
}

export function sceneView(host: SceneHost): SceneView {
  const { THREE } = host;
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  host.layer.add(root);
  const { LineSegmentsGeometry, LineMaterial, LineSegments2 } = wideLines(THREE);
  // As Viewer.tsx's groups: sketches, then overlays over the model, then highlights over everything.
  const bodies = new THREE.Group();
  const lines = new THREE.Group();
  const overlays = Object.assign(new THREE.Group(), { renderOrder: 1 });
  const marks = Object.assign(new THREE.Group(), { renderOrder: 2 });
  root.add(bodies, lines, overlays, marks);
  /** Model (Z up, mm) → the object's frame (Y up, m). */
  const toObject = new THREE.Matrix4().makeRotationX(-Math.PI / 2).scale(new THREE.Vector3(0.001, 0.001, 0.001));
  const inverse = new THREE.Matrix4();

  let props: ViewerProps | undefined;
  /** Made when the view mounts, from the theme where it is. */
  let materials: Materials | undefined;
  let drawn: Drawn[] = [];
  let hovered: Entity | undefined;
  let selected: Entity | undefined;
  let pending: HandEvent | undefined;
  /** The highlighted entities by style, for tests. */
  let highlighted: { style: HighlightStyle; entity: Entity }[] = [];
  /** The view's element in the editor's stage cell: it draws nothing, and carries the state tests read, as Viewer.tsx's does. */
  let element: HTMLDivElement | undefined;

  const moved = () => {
    const m = host.frame();
    root.visible = !!m;
    if (m) root.matrix.fromArray(m).multiply(toObject);
    root.matrixWorldNeedsUpdate = true;
    inverse.copy(root.matrix).invert();
    host.invalidate();
  };
  moved();

  /** Removes a group's objects and frees their geometries; materials are the view's, freed when it unmounts. */
  const clear = (group: Three.Group) => {
    for (const c of [...group.children]) {
      c.removeFromParent();
      (c as Three.Mesh).geometry?.dispose();
    }
  };
  /** Pairs of points as a wide line's geometry. */
  const wideGeometry = (pairs: ArrayLike<number>) => new LineSegmentsGeometry().setPositions(Array.from(pairs));
  /** Wide lines, outermost first, in render order. */
  const wide = (pairs: ArrayLike<number>, layers: Line[]) => layers.map((material, i) => Object.assign(new LineSegments2(wideGeometry(pairs), material), { renderOrder: i }));
  /** A polyline as pairs of points. */
  const pairsOf = ({ points, closed }: Overlay) => points.slice(0, closed ? undefined : -1).flatMap((p, i) => [...p, ...points[(i + 1) % points.length]!]);

  /** The materials of Viewer.tsx, in the theme's colours where `element` is. */
  const makeMaterials = (element: Element): Materials => {
    const color = (name: string) => {
      const c = themeColor(element, name);
      return { c, three: new THREE.Color().setRGB(c.r, c.g, c.b) };
    };
    // Lines in CSS pixels, as WebGL's own lines are never wider than one; wider with `prefers-contrast: more`.
    const contrast = matchMedia("(prefers-contrast: more)").matches ? 1.5 : 1;
    const own: Three.Material[] = [];
    const keep = <M extends Three.Material>(m: M) => (own.push(m), m);
    const wideLine = (c: Three.Color, width: number, overlay: boolean) =>
      keep(new LineMaterial({ color: c.getHex(), linewidth: width * contrast, ...(overlay ? { transparent: true, depthTest: false, depthWrite: false } : {}) }));
    const shape = color("--cad-model-shape").three;
    const edge = color("--cad-model-edge").three;
    const accent = color("--cad-model-accent").three;
    // Lines need the contrast of the text variant, e.g. a sketch outline against a light background.
    const accentLine = color("--cad-model-accent-text");
    const hover = color("--cad-model-hover").three;
    // A highlighted edge is a line over a wider halo in the theme's dark or light ink, whichever contrasts with it.
    const inks = [color("--cad-model-bg"), color("--cad-model-fg")].sort((a, b) => luminance(a.c) - luminance(b.c));
    const inkFor = (c: { c: Parameters<typeof luminance>[0] }) => (luminance(c.c) > 0.35 ? inks[0]! : inks[1]!).three;
    // Highlights show through the model, so that they also show what other faces hide.
    const highlightFace = (c: Three.Color, opacity: number) => keep(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    const highlightLine = (c: { c: Parameters<typeof luminance>[0]; three: Three.Color }, width: number) => ({ core: wideLine(c.three, width, true), halo: wideLine(inkFor(c), width + 3.5, true) });
    const peers = new Map<string, HighlightMaterials>();
    const ghosts = new Map<string, Line>();
    const css = (value: string) => {
      const three = new THREE.Color().setStyle(value, THREE.SRGBColorSpace);
      // luminance only reads the linear components.
      return { c: { r: three.r, g: three.g, b: three.b } as Parameters<typeof luminance>[0], three };
    };
    return {
      face: keep(new THREE.MeshStandardMaterial({ color: shape, roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 1 })),
      // Bodies that can't be picked: see-through, so that they don't hide the ones that can.
      fadedFace: keep(new THREE.MeshStandardMaterial({ color: shape, roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide, transparent: true, opacity: 0.25, depthWrite: false })),
      edge: wideLine(edge, 1.5, false),
      fadedEdge: keep(new LineMaterial({ color: edge.getHex(), linewidth: 1.5 * contrast, transparent: true, opacity: 0.3, depthWrite: false })),
      sketch: wideLine(accentLine.three, 1.5, false),
      // Hovered and selected edges have one colour; a hover is thinner.
      highlight: { hover: { face: highlightFace(hover, 0.35), line: highlightLine(accentLine, 2) }, accent: { face: highlightFace(accent, 0.5), line: highlightLine(accentLine, 3.5) } },
      ring: { line: wideLine(accentLine.three, 10, true), halo: wideLine(inkFor(accentLine), 13.5, true) },
      peer(value) {
        let m = peers.get(value);
        if (!m) peers.set(value, (m = { face: highlightFace(css(value).three, 0.3), line: highlightLine(css(value), 3) }));
        return m;
      },
      ghost(value) {
        let m = ghosts.get(value);
        if (!m) ghosts.set(value, (m = wideLine(value ? css(value).three : accentLine.three, 1.5, true)));
        return m;
      },
      dispose: () => own.forEach((m) => m.dispose()),
    };
  };

  /** Whether a shape is pickable now: while picking, the shapes `pickable` doesn't name fade, as in Viewer.tsx. */
  const pickableShape = (shape: MeshedShape, i: number) => !props?.pick || !props.pickable || props.pickable(shape.body ?? `#${i}`);
  const pickableBody = (body: string | undefined) => !!body && (props?.pickable?.(body) ?? true);

  // ── drawing ──
  const drawShapes = (shapes: MeshedShape[] | undefined) => {
    clear(bodies);
    const m = materials;
    drawn = (shapes ?? []).map((shape) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(shape.faces.vertices, 3));
      if (shape.faces.normals?.length === shape.faces.vertices.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(shape.faces.normals, 3));
      g.setIndex(shape.faces.triangles);
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, m?.face);
      bodies.add(mesh);
      const edges = shape.edges?.lines.length && m ? new LineSegments2(wideGeometry(shape.edges.lines), m.edge) : undefined;
      if (edges) bodies.add(edges);
      return { shape, mesh, wide: edges };
    });
    if (element) element.dataset["vertices"] = String(drawn.reduce((n, d) => n + d.shape.faces.vertices.length / 3, 0));
    // Indices may name other entities in the new shapes.
    setHovered(undefined);
    setSelected(undefined);
    fade();
    host.invalidate();
  };
  /** Bodies that can't be picked while picking fade, faces and edges, as in Viewer.tsx. */
  const fade = () => {
    const m = materials;
    if (!m) return;
    drawn.forEach((d, i) => {
      const faded = !pickableShape(d.shape, i);
      d.mesh.material = faded ? m.fadedFace : m.face;
      if (d.wide) d.wide.material = faded ? m.fadedEdge : m.edge;
    });
    if (element) element.dataset["faded"] = drawn.flatMap((d, i) => (pickableShape(d.shape, i) ? [] : [d.shape.body ?? `#${i}`])).join(" ");
    host.invalidate();
  };

  /** The triangles of a shape's faces `indices`, as x, y and z of each corner, three corners each. */
  const faceTriangles = (shape: MeshedShape, indices: number[]): number[] => {
    const { vertices, triangles, faceGroups } = shape.faces;
    const out: number[] = [];
    (faceGroups ?? []).forEach((g, gi) => {
      if (!indices.includes(entityIndex(shape.faceIndex, gi))) return;
      for (let i = g.start; i < g.start + g.count; i++) out.push(vertices[triangles[i]! * 3]!, vertices[triangles[i]! * 3 + 1]!, vertices[triangles[i]! * 3 + 2]!);
    });
    return out;
  };
  /** The segments of a shape's edges `indices`, as pairs of points. */
  const edgePairs = (shape: MeshedShape, indices: number[]): number[] => {
    const out: number[] = [];
    (shape.edges?.edgeGroups ?? []).forEach((g, gi) => {
      if (indices.includes(entityIndex(shape.edgeIndex, gi))) out.push(...shape.edges!.lines.slice(g.start * 3, (g.start + g.count) * 3));
    });
    return out;
  };
  /**
   * The outline of triangles, as Viewer.tsx's `outline`: the sides that only one of them has. Corners
   * are matched by position, as a mesh repeats them along seams and between faces.
   */
  const outlineOf = (triangles: number[]): number[] => {
    const key = (i: number) => `${triangles[3 * i]!.toFixed(4)},${triangles[3 * i + 1]!.toFixed(4)},${triangles[3 * i + 2]!.toFixed(4)}`;
    const sides = new Map<string, [number, number] | undefined>();
    for (let t = 0; t + 2 < triangles.length / 3; t += 3)
      for (const [a, b] of [[t, t + 1], [t + 1, t + 2], [t + 2, t]] as const) {
        const [ka, kb] = [key(a), key(b)];
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        // A second triangle with this side: it is inside.
        sides.set(k, sides.has(k) ? undefined : [a, b]);
      }
    return [...sides.values()].flatMap((s) => (s ? [...triangles.slice(3 * s[0], 3 * s[0] + 3), ...triangles.slice(3 * s[1], 3 * s[1] + 3)] : []));
  };

  /** Draws the highlights as Viewer.tsx does: the given ones, the selection and the hover. */
  const drawMarks = () => {
    clear(marks);
    const m = materials;
    const shapes = props?.shapes ?? [];
    const own = (entity: Entity | undefined, style: HighlightStyle): Highlight[] => (entity ? [{ body: entity.body, kind: entity.kind, indices: [entity.index], style }] : []);
    const all = [...(props?.highlight ?? []), ...own(selected, "accent"), ...(props?.hoverHighlight === false ? [] : own(hovered, "hover"))];
    highlighted = all.flatMap((h) => h.indices.map((index) => ({ style: h.style, entity: { body: h.body, kind: h.kind, index } })));
    if (!m) return;
    /** The selected edge is hovered: it gets the ring, and the hover no line of its own. */
    const ringed = selected?.kind === "edge" && sameEntity(hovered, selected);
    /** The selected face is hovered: it keeps the selection's fill, and gets the hover's outline. */
    const hoveredSelectedFace = selected?.kind === "face" && sameEntity(hovered, selected);
    for (const h of all) {
      const shape = h.shape ?? shapes.find((s) => s.body === h.body);
      if (!shape) continue;
      const { face, line } = h.style === "peer" ? m.peer(h.color ?? "#888") : m.highlight[h.style];
      const first = { body: h.body, kind: h.kind, index: h.indices[0]! };
      if (h.kind === "face") {
        const triangles = faceTriangles(shape, h.indices);
        if (!triangles.length) continue;
        const ownHover = h.style === "hover" && h.indices.length === 1 && sameEntity(hovered, first);
        if (!(hoveredSelectedFace && ownHover)) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(triangles, 3));
          marks.add(new THREE.Mesh(g, face));
        }
        // A hover, of a face or of a feature's faces, is outlined with the hover's thin line, also over a selection.
        if (h.style === "hover" && !h.ghost) marks.add(...wide(outlineOf(triangles), [line.halo, line.core]));
      } else if (!(ringed && h.style === "hover" && sameEntity(hovered, first))) {
        const pairs = edgePairs(shape, h.indices);
        if (!pairs.length) continue;
        const ring = ringed && h.style === "accent" && sameEntity(selected, first);
        // Outermost first; a ghost's edges are a thin line alone.
        const layers = h.ghost ? [m.ghost(h.style === "peer" ? (h.color ?? "#888") : "")] : [...(ring ? [m.ring.halo, m.ring.line] : []), line.halo, line.core];
        marks.add(...wide(pairs, layers));
      }
    }
    host.invalidate();
  };
  const drawLines = () => {
    clear(lines);
    clear(overlays);
    const m = materials;
    if (!m) return;
    for (const sketch of props?.sketches ?? []) for (const line of sketch.outline) lines.add(new LineSegments2(wideGeometry(pairsOf(line)), m.sketch));
    for (const overlay of props?.overlays ?? []) overlays.add(...wide(pairsOf(overlay), [m.highlight.hover.line.halo, m.highlight.hover.line.core]));
    if (element) element.dataset["overlays"] = String(props?.overlays?.length ?? 0);
    host.invalidate();
  };

  // ── picking, in the model's own frame ──
  const localRay = (x: number, y: number) => {
    const r = host.ray(x, y);
    if (!r) return undefined;
    const origin = new THREE.Vector3().fromArray(r.origin).applyMatrix4(inverse);
    const along = new THREE.Vector3().fromArray(r.origin).add(new THREE.Vector3().fromArray(r.dir)).applyMatrix4(inverse);
    return new THREE.Ray(origin, along.sub(origin).normalize());
  };
  const faceHit = (ray: Three.Ray): Hit | undefined => {
    const [a, b, c, at] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let best: Hit | undefined;
    for (const { shape } of drawn) {
      const v = shape.faces.vertices;
      const tris = shape.faces.triangles;
      const pickable = pickableBody(shape.body);
      // A faded body neither hovers nor takes clicks, and hides nothing behind it.
      if (props?.pickable && !pickable) continue;
      for (let i = 0; i + 2 < tris.length; i += 3) {
        a.fromArray(v, tris[i]! * 3);
        b.fromArray(v, tris[i + 1]! * 3);
        c.fromArray(v, tris[i + 2]! * 3);
        if (!ray.intersectTriangle(a, b, c, false, at)) continue;
        const t = at.distanceTo(ray.origin);
        if (best && t >= best.t) continue;
        const group = groupAt(shape.faces.faceGroups, i);
        const entity = shape.body && group >= 0 ? { body: shape.body, kind: "face" as const, index: entityIndex(shape.faceIndex, group) } : undefined;
        best = { entity, point: at.toArray() as [number, number, number], t };
      }
    }
    return best;
  };
  /** The nearest edge within EDGE_PX of the pointer and not behind `front` (by more than the pixel slack). */
  const edgeHit = (ray: Three.Ray, px: (t: number) => number, front: number): Hit | undefined => {
    const [a, b, onRay, onSeg] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let best: (Hit & { score: number }) | undefined;
    for (const { shape } of drawn) {
      if (!shape.body || !shape.edges || !pickableBody(shape.body)) continue;
      const l = shape.edges.lines;
      for (let i = 0; i + 5 < l.length; i += 6) {
        a.fromArray(l, i);
        b.fromArray(l, i + 3);
        const d = Math.sqrt(ray.distanceSqToSegment(a, b, onRay, onSeg));
        const t = onRay.distanceTo(ray.origin);
        const size = px(t);
        const score = d / size;
        if (score > EDGE_PX || t > front + EDGE_PX * size || (best && score >= best.score)) continue;
        const group = groupAt(shape.edges.edgeGroups, i / 3);
        if (group < 0) continue;
        best = { entity: { body: shape.body, kind: "edge", index: entityIndex(shape.edgeIndex, group) }, point: onSeg.toArray() as [number, number, number], t, score };
      }
    }
    return best;
  };
  /** What is at port pixel (x, y): an edge if `kind` allows one near, else a face (`kind`: only that kind). */
  const hitAt = (x: number, y: number, kind?: EntityKind): Hit | undefined => {
    const ray = localRay(x, y);
    const next = localRay(x + 1, y);
    if (!ray || !next) return undefined;
    const angle = ray.direction.angleTo(next.direction);
    const face = faceHit(ray);
    if (kind !== "face") {
      const edge = edgeHit(ray, (t) => Math.max(t * angle, 1e-9), face?.t ?? Infinity);
      if (edge) return edge;
      if (kind === "edge") return undefined;
    }
    return face;
  };

  const setHovered = (e: Entity | undefined) => {
    if (sameEntity(e, hovered) || (!e && !hovered)) return;
    hovered = e;
    if (element) element.dataset["hovered"] = entityKey(e);
    props?.onHover?.(e);
    drawMarks();
  };
  /** The face or edge selected in the view, drawn as the accent, as Viewer.tsx's own selection. */
  const setSelected = (e: Entity | undefined) => {
    if (sameEntity(e, selected) || (!e && !selected)) return;
    selected = e;
    if (element) element.dataset["selected"] = entityKey(e);
    props?.onSelect?.(e);
    drawMarks();
  };
  const hover = (ev: HandEvent) => {
    const hit = hitAt(ev.x, ev.y, props?.pick);
    setHovered(props?.pick && hit?.entity && !pickableBody(hit.entity.body) ? undefined : hit?.entity);
    props?.onPointer?.(hit?.point);
  };

  const input: SceneView["input"] = {
    move(ev) {
      // Orbiting: leave the hover where it was.
      if (ev.locked || ev.buttons) return false;
      const waiting = pending;
      pending = ev;
      if (!waiting) host.nextFrame(() => {
        const p = pending;
        pending = undefined;
        if (p && props) hover(p);
      });
      return false;
    },
    click(ev) {
      if (!props) return false;
      if (props.pick) {
        // While a field picks, a click picks or does nothing, as in the CAD view.
        const e = hitAt(ev.x, ev.y, props.pick)?.entity;
        if (e && pickableBody(e.body)) props.onPick?.(e);
        return true;
      }
      if (!props.onSelect) return false;
      const e = hitAt(ev.x, ev.y)?.entity;
      setSelected(e);
      // A click off the model is the scene's.
      return !!e;
    },
    menu(ev) {
      if (!props?.onContextMenu) return false;
      const e = hitAt(ev.x, ev.y)?.entity;
      if (!e) return false;
      props.onContextMenu(e, { x: ev.clientX, y: ev.clientY });
      return true;
    },
    leave() {
      pending = undefined;
      setHovered(undefined);
      props?.onPointer?.(undefined);
    },
    cursor: () => (props?.pick ? "crosshair" : null),
  };

  /** What the editor asks of a view, as far as a scene has it. */
  const api: ViewerApi = {
    camera: () => undefined,
    home: () => {},
    homeCamera: () => undefined,
    pointAt(clientX, clientY) {
      const p = host.port(clientX, clientY);
      return p ? hitAt(p.x, p.y, "face")?.point : undefined;
    },
    faceAt(clientX, clientY) {
      const p = host.port(clientX, clientY);
      return p ? hitAt(p.x, p.y, "face")?.entity : undefined;
    },
  };

  // ── for tests ──
  const shapeOf = (body: string) => drawn.find((d) => d.shape.body === body)?.shape;
  /** A model point (Z up, mm) on the screen. */
  const toScreen = (p: Three.Vector3) => host.project(p.clone().applyMatrix4(root.matrix).toArray());
  /**
   * Points on an entity, biggest first, as Viewer.tsx's `candidatesOf`: the centroids of a face's
   * triangles by area, the midpoints of an edge's segments by length.
   */
  const candidates = (shape: MeshedShape, kind: EntityKind, index: number): { point: Three.Vector3; size: number }[] => {
    const out: { point: Three.Vector3; size: number }[] = [];
    if (kind === "face") {
      const { vertices, triangles, faceGroups } = shape.faces;
      (faceGroups ?? []).forEach((g, gi) => {
        if (entityIndex(shape.faceIndex, gi) !== index) return;
        for (let t = g.start; t + 2 < g.start + g.count; t += 3) {
          const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromArray(vertices, triangles[t + k]! * 3)) as [Three.Vector3, Three.Vector3, Three.Vector3];
          const area = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).length() / 2;
          out.push({ point: a.add(b).add(c).divideScalar(3), size: area });
        }
      });
    } else if (shape.edges) {
      const { lines: l, edgeGroups } = shape.edges;
      (edgeGroups ?? []).forEach((g, gi) => {
        if (entityIndex(shape.edgeIndex, gi) !== index) return;
        for (let v = g.start; v + 1 < g.start + g.count; v += 2) {
          const [a, b] = [new THREE.Vector3().fromArray(l, v * 3), new THREE.Vector3().fromArray(l, (v + 1) * 3)];
          out.push({ point: a.clone().add(b).multiplyScalar(0.5), size: a.distanceTo(b) });
        }
      });
    }
    return out.sort((x, y) => y.size - x.size);
  };
  const hook: SceneTestHook = {
    entities: (kind) =>
      drawn.flatMap(({ shape }) => {
        const indices = (kind === "face" ? shape.faceIndex : shape.edgeIndex) ?? [];
        return shape.body ? indices.filter((i) => i >= 0).map((index) => ({ body: shape.body!, kind, index })) : [];
      }),
    highlighted: (style) => highlighted.filter((h) => h.style === style).map((h) => h.entity),
    centroid(entity) {
      const shape = shapeOf(entity.body);
      const points = shape ? candidates(shape, entity.kind, entity.index) : [];
      if (!points.length) return undefined;
      return points.reduce((sum, c) => sum.add(c.point), new THREE.Vector3()).divideScalar(points.length).toArray() as [number, number, number];
    },
    screenPoint(entity) {
      const shape = shapeOf(entity.body);
      if (!shape) return undefined;
      // A point that a click hits reliably: whole pixels on the scene's canvas, not under the editor's panels, and the same entity a few pixels around it.
      const margin = entity.kind === "face" ? 3 : 1;
      const around = [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]] as const;
      for (const { point } of candidates(shape, entity.kind, entity.index)) {
        const s = toScreen(point);
        if (!s?.visible) continue;
        const [x, y] = [Math.round(s.x), Math.round(s.y)];
        const hits = around.every(([dx, dy]) => {
          const p = host.port(x + dx, y + dy);
          return document.elementFromPoint(x + dx, y + dy) instanceof HTMLCanvasElement && !!p && sameEntity(hitAt(p.x, p.y, entity.kind)?.entity, entity);
        });
        if (hits) return { x, y };
      }
      return undefined;
    },
  };

  const Viewer: Component<ViewerProps> = (p) => {
    props = p;
    const el = Object.assign(document.createElement("div"), { cadViewer: hook });
    el.className = "cad-model__viewer cad-model__viewer--host";
    Object.assign(el.dataset, { hovered: "", selected: "" });
    element = el;
    // Once mounted: the theme is where the element is.
    createEffect(() => (materials ??= makeMaterials(el)));
    createEffect(() => {
      // Hover changes kind with the pick target, and picking ends a selection.
      el.dataset["pick"] = p.pick ?? "";
      setHovered(undefined);
      if (p.pick) setSelected(undefined);
    });
    createEffect(() => drawShapes(p.shapes));
    createEffect(() => {
      void [p.pickable, p.pick];
      fade();
    });
    createEffect(() => {
      void [p.highlight, p.shapes, p.hoverHighlight];
      drawMarks();
    });
    createEffect(() => {
      void [p.sketches, p.overlays];
      drawLines();
    });
    p.onApi?.(api);
    onCleanup(() => {
      if (props === p) props = undefined;
      if (element === el) element = undefined;
      hovered = undefined;
      selected = undefined;
      for (const g of [bodies, marks, lines, overlays]) clear(g);
      drawn = [];
      materials?.dispose();
      materials = undefined;
      host.invalidate();
    });
    return el;
  };

  return {
    Viewer,
    input,
    moved,
    hovered: () => hovered,
    at(x, y) {
      const h = hitAt(x, y);
      return h && { entity: h.entity, point: h.point };
    },
    dispose() {
      for (const g of [bodies, marks, lines, overlays]) clear(g);
      materials?.dispose();
      root.removeFromParent();
      host.invalidate();
    },
  };
}
