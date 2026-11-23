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
import type { Entity, EntityKind, Highlight, HighlightStyle, Overlay, ViewerApi, ViewerProps, ViewerTestHook } from "../components/Viewer.tsx";

/** What the e2e helpers ask of a view (`ViewerTestHook`), as far as a scene has it. */
export type SceneTestHook = Pick<ViewerTestHook, "entities" | "screenPoint" | "highlighted" | "centroid">;

/** An entity as `body:kind:index`, for tests, as Viewer.tsx's. */
const entityKey = (e: Entity | undefined) => (e ? `${e.body}:${e.kind}:${e.index}` : "");

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

const COLORS = { body: "#a9aeb5", edge: "#1e1e1e", sketch: "#2f6fd6", overlay: "#f08c00", hover: "#2f81f7", accent: "#f08c00" };
/** How near (px) the pointer must be to an edge to hover it, as Viewer.tsx's. */
const EDGE_PX = 6;

type Drawn = { shape: MeshedShape; mesh: Three.Mesh; lines: Three.LineSegments | undefined };
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
  const bodies = new THREE.Group();
  const marks = new THREE.Group();
  const lines = new THREE.Group();
  root.add(bodies, lines, marks);
  /** Model (Z up, mm) → the object's frame (Y up, m). */
  const toObject = new THREE.Matrix4().makeRotationX(-Math.PI / 2).scale(new THREE.Vector3(0.001, 0.001, 0.001));
  const inverse = new THREE.Matrix4();

  let props: ViewerProps | undefined;
  let drawn: Drawn[] = [];
  let hovered: Entity | undefined;
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

  const clear = (group: Three.Group) => {
    for (const c of [...group.children]) {
      c.removeFromParent();
      const o = c as Three.Mesh;
      o.geometry?.dispose();
      for (const m of [o.material].flat()) (m as Three.Material | undefined)?.dispose();
    }
  };
  const segments = (points: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return g;
  };
  const lineMaterial = (color: string, over = false, opacity = 1) =>
    new THREE.LineBasicMaterial({ color, transparent: over || opacity < 1, opacity, depthTest: !over, depthWrite: !over });
  const polylines = (list: Overlay[]) =>
    list.flatMap(({ points, closed }) => points.flatMap((p, i) => (i + 1 < points.length || closed ? [...p, ...points[(i + 1) % points.length]!] : [])));

  const pickableBody = (body: string | undefined) => !!body && (props?.pickable?.(body) ?? true);

  // ── drawing ──
  const drawShapes = (shapes: MeshedShape[] | undefined) => {
    clear(bodies);
    drawn = (shapes ?? []).map((shape) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(shape.faces.vertices, 3));
      if (shape.faces.normals?.length === shape.faces.vertices.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(shape.faces.normals, 3));
      g.setIndex(shape.faces.triangles);
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      const opacity = shape.opacity ?? 1;
      const material = new THREE.MeshStandardMaterial({ color: shape.color || COLORS.body, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide, transparent: opacity < 1, opacity, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const mesh = new THREE.Mesh(g, material);
      bodies.add(mesh);
      let edges: Three.LineSegments | undefined;
      if (shape.edges?.lines.length) {
        edges = new THREE.LineSegments(segments(shape.edges.lines), lineMaterial(COLORS.edge));
        bodies.add(edges);
      }
      return { shape, mesh, lines: edges };
    });
    if (element) element.dataset["vertices"] = String(drawn.reduce((n, d) => n + d.shape.faces.vertices.length / 3, 0));
    fade();
    host.invalidate();
  };
  /** Bodies that can't be picked while picking fade, as in Viewer.tsx. */
  const fade = () => {
    for (const d of drawn) {
      const faded = !!props?.pickable && !pickableBody(d.shape.body);
      const m = d.mesh.material as Three.MeshStandardMaterial;
      const opacity = (d.shape.opacity ?? 1) * (faded ? 0.25 : 1);
      m.transparent = opacity < 1;
      m.opacity = opacity;
      m.depthWrite = !faded;
      m.needsUpdate = true;
    }
    host.invalidate();
  };

  /** Faces or edges of a body as a mark over everything: translucent faces, edges in the colour. */
  const mark = (shape: MeshedShape, kind: EntityKind, indices: number[], color: string, faceOpacity: number) => {
    if (kind === "face") {
      const groups = shape.faces.faceGroups ?? [];
      const tris: number[] = [];
      groups.forEach((g, gi) => {
        if (indices.includes(entityIndex(shape.faceIndex, gi))) for (let i = g.start; i < g.start + g.count; i++) tris.push(shape.faces.triangles[i]!);
      });
      if (!tris.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(shape.faces.vertices, 3));
      geometry.setIndex(tris);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: faceOpacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 10;
      marks.add(mesh);
    } else {
      const groups = shape.edges?.edgeGroups ?? [];
      const points: number[] = [];
      groups.forEach((g, gi) => {
        if (indices.includes(entityIndex(shape.edgeIndex, gi))) points.push(...shape.edges!.lines.slice(g.start * 3, (g.start + g.count) * 3));
      });
      if (!points.length) return;
      const l = new THREE.LineSegments(segments(points), lineMaterial(color, true));
      l.renderOrder = 11;
      marks.add(l);
    }
  };
  const drawMarks = () => {
    clear(marks);
    const shapes = props?.shapes ?? [];
    const of = (h: { body: string; shape?: MeshedShape | undefined }) => h.shape ?? shapes.find((s) => s.body === h.body);
    const own = (entity: Entity | undefined, style: HighlightStyle): Highlight[] => (entity ? [{ body: entity.body, kind: entity.kind, indices: [entity.index], style }] : []);
    const all = [...(props?.highlight ?? []), ...(props?.hoverHighlight === false ? [] : own(hovered, "hover"))];
    highlighted = all.flatMap((h) => h.indices.map((index) => ({ style: h.style, entity: { body: h.body, kind: h.kind, index } })));
    for (const h of props?.highlight ?? ([] as Highlight[])) {
      const shape = of(h);
      const color = h.style === "peer" ? (h.color ?? "#888") : h.style === "accent" ? COLORS.accent : COLORS.hover;
      if (shape) mark(shape, h.kind, h.indices, color, h.ghost ? 0.15 : h.style === "accent" ? 0.35 : 0.25);
    }
    if (hovered && props?.hoverHighlight !== false) {
      const shape = of(hovered);
      if (shape) mark(shape, hovered.kind, [hovered.index], COLORS.hover, 0.25);
    }
    host.invalidate();
  };
  const drawLines = () => {
    clear(lines);
    const sketches = polylines((props?.sketches ?? []).flatMap((s) => s.outline));
    if (sketches.length) lines.add(new THREE.LineSegments(segments(sketches), lineMaterial(COLORS.sketch)));
    const overlays = polylines(props?.overlays ?? []);
    if (overlays.length) {
      const l = new THREE.LineSegments(segments(overlays), lineMaterial(COLORS.overlay, true));
      l.renderOrder = 12;
      lines.add(l);
    }
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
    if (e?.body === hovered?.body && e?.kind === hovered?.kind && e?.index === hovered?.index) return;
    hovered = e;
    if (element) element.dataset["hovered"] = entityKey(e);
    props?.onHover?.(e);
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
      const e = hitAt(ev.x, ev.y)?.entity;
      props.onSelect?.(e);
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
  const sameEntity = (a: Entity | undefined, b: Entity) => !!a && a.body === b.body && a.kind === b.kind && a.index === b.index;
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
    element = el;
    createEffect(() => (el.dataset["pick"] = p.pick ?? ""));
    createEffect(() => drawShapes(p.shapes));
    createEffect(() => {
      void p.pickable;
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
      for (const g of [bodies, marks, lines]) clear(g);
      drawn = [];
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
      for (const g of [bodies, marks, lines]) clear(g);
      root.removeFromParent();
      host.invalidate();
    },
  };
}
