// The editor's 3D view drawn in a scene (ViewerProps, as Viewer.tsx is): the model's live build as
// meshes in a layer of the scene's world, with the scene's own three.js (a scene's renderer can't
// draw another copy's objects), picked by raycasting those meshes here, since the scene's own hits
// don't say which face. Input comes from the scene's hand stack (editTool.tsx). The camera is the
// scene's, which the view's camera props move and which it is read from (sceneCamera.ts).
//
// The model is Z up in millimetres; the layer's frame is the scene object's, Y up in metres.

import { createEffect, onCleanup, type Component } from "solid-js";
import * as Local from "three";
import type * as Three from "three";
import type { MeshedShape } from "../kernel/protocol.ts";
import { luminance, themeColor, type Entity, type EntityKind, type Highlight, type HighlightStyle, type Overlay, type PeerMarker, type Pin, type ShownCanvas, type ShownRegion, type ViewerApi, type ViewerProps, type ViewerTestHook } from "../components/Viewer.tsx";
import { iconElement } from "../components/icons.tsx";
import { contactToken } from "../components/presence.ts";
import { entityIndex, pickingOf, type Hit, type Picking } from "./picking.ts";
import { sceneCamera, type HostCamera } from "./sceneCamera.ts";
import { sceneViewCube, type SceneViewCube } from "./sceneViewCube.ts";
import { wideLines } from "./wideLines.js";

/** What the e2e helpers ask of a view (`ViewerTestHook`), as far as a scene has it. */
export type SceneTestHook = Pick<ViewerTestHook, "entities" | "screenPoint" | "highlighted" | "centroid" | "cameraDirection" | "viewCubePoint" | "intent" | "regions" | "peerMarkers" | "canvases" | "canvasPoint">;

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
  /** The scene's camera, which the editor's views move (sceneCamera.ts). */
  camera: HostCamera;
  /** The port's size in pixels, or null while it has none. */
  size(): { width: number; height: number } | null;
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
  peer(css: string): HighlightMaterials & { marker: Three.Material };
  /** A ghost's edges, as wide as the model's, in the highlight's colour (`""`: the accent's). */
  ghost(css: string): Line;
  /** Regions of a sketch to pick: every state differs; one neither chosen nor hovered only takes the pointer. */
  region: { chosen: Three.Material; hovered: Three.Material; chosenHovered: Three.Material; other: Three.Material };
  dispose(): void;
}

type Drawn = { shape: MeshedShape; mesh: Three.Mesh; wide: InstanceType<ReturnType<typeof wideLines>["LineSegments2"]> | undefined };


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
  /** Before the scene draws a frame: the ViewCube follows the camera. */
  update(): void;
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
  // Regions of a sketch, over the model as highlights are, and the hovered one's outline.
  const regionGroup = Object.assign(new THREE.Group(), { renderOrder: 1 });
  const regionOutline = Object.assign(new THREE.Group(), { renderOrder: 2 });
  const peerGroup = Object.assign(new THREE.Group(), { renderOrder: 3 });
  const canvasGroup = new THREE.Group();
  root.add(bodies, canvasGroup, lines, overlays, regionGroup, regionOutline, marks, peerGroup);
  /** Model (Z up, mm) → the object's frame (Y up, m). */
  const toObject = new THREE.Matrix4().makeRotationX(-Math.PI / 2).scale(new THREE.Vector3(0.001, 0.001, 0.001));
  const inverse = new THREE.Matrix4();

  let props: ViewerProps | undefined;
  /** Made when the view mounts, from the theme where it is. */
  let materials: Materials | undefined;
  let drawn: Drawn[] = [];
  let picking: Picking = pickingOf(THREE, []);
  let hovered: Entity | undefined;
  let selected: Entity | undefined;
  let drawnRegions: { region: ShownRegion; mesh: Three.Mesh; outline: () => number[] }[] = [];
  let hoveredRegion: string | undefined;
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
    const peers = new Map<string, HighlightMaterials & { marker: Three.Material }>();
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
        if (!m) peers.set(value, (m = { face: highlightFace(css(value).three, 0.3), line: highlightLine(css(value), 3), marker: keep(new THREE.MeshBasicMaterial({ color: css(value).three, depthTest: false, depthWrite: false })) }));
        return m;
      },
      ghost(value) {
        let m = ghosts.get(value);
        if (!m) ghosts.set(value, (m = wideLine(value ? css(value).three : accentLine.three, 1.5, true)));
        return m;
      },
      region: {
        chosen: highlightFace(accent, 0.5),
        hovered: highlightFace(hover, 0.35),
        chosenHovered: highlightFace(accent, 0.65),
        other: keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide })),
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
    picking = pickingOf(THREE, shapes ?? []);
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

  // ── regions of a sketch (research/21, "Sketch from a drawing"), as Viewer.tsx's ──
  const regionMaterial = (region: ShownRegion) => {
    const r = materials!.region;
    return region.key === hoveredRegion ? (region.chosen ? r.chosenHovered : r.hovered) : region.chosen ? r.chosen : r.other;
  };
  /** Draws the regions' materials, and the hovered one's outline. */
  const drawRegionStates = () => {
    clear(regionOutline);
    const m = materials;
    if (!m) return;
    for (const d of drawnRegions) d.mesh.material = regionMaterial(d.region);
    const outline = drawnRegions.find((d) => d.region.key === hoveredRegion)?.outline();
    if (outline?.length) regionOutline.add(...wide(outline, [m.highlight.hover.line.halo, m.highlight.hover.line.core]));
    host.invalidate();
  };
  const drawRegions = (regions: ShownRegion[] | undefined) => {
    clear(regionGroup);
    drawnRegions = (regions ?? []).map((region) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(region.triangles, 3));
      const mesh = new THREE.Mesh(g, materials?.region.other);
      regionGroup.add(mesh);
      let outline: number[] | undefined;
      return { region, mesh, outline: () => (outline ??= outlineOf(region.triangles)) };
    });
    // Drawn as they are now; a hovered region that is gone is hovered no more.
    if (hoveredRegion !== undefined && !drawnRegions.some((d) => d.region.key === hoveredRegion)) setHoveredRegion(undefined);
    else drawRegionStates();
  };
  const setHoveredRegion = (key: string | undefined) => {
    if (key === hoveredRegion) return;
    hoveredRegion = key;
    drawRegionStates();
    if (element) element.dataset["regionHovered"] = key ?? "";
    props?.onRegionHover?.(key);
  };

  // ── picking, in the model's own frame ──
  const localRay = (x: number, y: number) => {
    const r = host.ray(x, y);
    if (!r) return undefined;
    const origin = new THREE.Vector3().fromArray(r.origin).applyMatrix4(inverse);
    const along = new THREE.Vector3().fromArray(r.origin).add(new THREE.Vector3().fromArray(r.dir)).applyMatrix4(inverse);
    return new THREE.Ray(origin, along.sub(origin).normalize());
  };
  // A faded body neither hovers nor takes clicks, and hides nothing behind it.
  const faceHit = (ray: Three.Ray): Hit | undefined => picking.faceHit(ray, (shape) => !!props?.pickable && !pickableBody(shape.body));
  const edgeHit = (ray: Three.Ray, px: (t: number) => number, front: number): Hit | undefined => picking.edgeHit(ray, px, front, pickableBody);
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

  // ── canvases (research/21, "Canvas"), as Viewer.tsx's: images on planes. Live documents on canvases aren't drawn in a scene (research/23, G2) ──
  /** A texture per drawn image, kept while a canvas shows it. */
  const textures = new Map<HTMLCanvasElement, Three.CanvasTexture>();
  let drawnCanvases: { canvas: ShownCanvas; mesh: Three.Mesh }[] = [];
  const drawCanvases = (list: ShownCanvas[]) => {
    for (const d of drawnCanvases) (d.mesh.material as Three.Material).dispose();
    clear(canvasGroup);
    for (const [image, texture] of textures) {
      if (list.some((c) => c.image === image)) continue;
      texture.dispose();
      textures.delete(image);
    }
    const m = materials;
    drawnCanvases = list.flatMap((c) => {
      if (!c.image || !m) return [];
      let texture = textures.get(c.image);
      if (!texture) {
        texture = new THREE.CanvasTexture(c.image);
        texture.colorSpace = THREE.SRGBColorSpace;
        textures.set(c.image, texture);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(c.corners.flat(), 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      // In front of a face it lies on, which the faces' polygon offset pushes back; through the model if it is drawn through it.
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: c.opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: !c.through, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const mesh = new THREE.Mesh(geometry, material);
      canvasGroup.add(mesh);
      if (c.highlight) canvasGroup.add(...wide(pairsOf({ points: c.corners, closed: true }), [m.highlight[c.highlight].line.halo, m.highlight[c.highlight].line.core]).map((l) => Object.assign(l, { renderOrder: 2 + l.renderOrder })));
      return [{ canvas: c, mesh }];
    });
    if (element) element.dataset["canvases"] = String(drawnCanvases.length);
    host.invalidate();
  };
  /** The point of canvas `id`'s image at port pixel (x, y), as fractions of it from the bottom left. */
  const canvasAt = (id: string, x: number, y: number): [number, number] | undefined => {
    const c = drawnCanvases.find((d) => d.canvas.id === id)?.canvas;
    const ray = localRay(x, y);
    if (!c || !ray) return undefined;
    const [a, b, , d] = c.corners.map((p) => new THREE.Vector3(...p)) as [Three.Vector3, Three.Vector3, Three.Vector3, Three.Vector3];
    const plane = new THREE.Plane().setFromCoplanarPoints(a, b, d);
    const at = ray.intersectPlane(plane, new THREE.Vector3());
    if (!at) return undefined;
    // In the image's axes: along its bottom edge and its left edge.
    const [u, v] = [b.clone().sub(a), d.clone().sub(a)];
    const rel = at.sub(a);
    const uu = u.dot(u), uv = u.dot(v), vv = v.dot(v), ru = rel.dot(u), rv = rel.dot(v);
    const det = uu * vv - uv * uv;
    const s = (ru * vv - rv * uv) / det;
    const t = (rv * uu - ru * uv) / det;
    if (s < 0 || s > 1 || t < 0 || t > 1) return undefined;
    return [Math.round(s * 1e6) / 1e6, Math.round(t * 1e6) / 1e6];
  };

  /** The region at port pixel (x, y): the nearest, as they all lie in one plane and over the model. */
  const regionAt = (x: number, y: number): string | undefined => {
    const ray = localRay(x, y);
    if (!ray || !drawnRegions.length) return undefined;
    const [a, b, c, at] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let best: { key: string; t: number } | undefined;
    for (const { region } of drawnRegions) {
      const t = region.triangles;
      for (let i = 0; i + 8 < t.length; i += 9) {
        a.fromArray(t, i);
        b.fromArray(t, i + 3);
        c.fromArray(t, i + 6);
        if (!ray.intersectTriangle(a, b, c, false, at)) continue;
        const d = at.distanceTo(ray.origin);
        if (!best || d < best.t) best = { key: region.key, t: d };
      }
    }
    return best?.key;
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
    // While points of a canvas are picked, e.g. to calibrate it, nothing of the model is hovered.
    if (props?.canvasPick) {
      setHovered(undefined);
      props.onCanvasHover?.(props.canvasPick, canvasAt(props.canvasPick, ev.x, ev.y));
      props.onPointer?.(hitAt(ev.x, ev.y, "face")?.point);
      return;
    }
    // While regions of a sketch are picked, nothing of the model is hovered.
    if (props?.regions?.length) {
      setHovered(undefined);
      setHoveredRegion(regionAt(ev.x, ev.y));
      props.onPointer?.(hitAt(ev.x, ev.y, "face")?.point);
      return;
    }
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
      // A point of a canvas, e.g. to calibrate it, before anything else a click does.
      if (props.canvasPick) {
        const uv = canvasAt(props.canvasPick, ev.x, ev.y);
        if (uv) props.onCanvasPick?.(props.canvasPick, uv);
        return true;
      }
      // A region of a sketch, which hides the model's faces and edges while regions are picked.
      if (props.regions?.length) {
        const key = regionAt(ev.x, ev.y);
        if (key) props.onRegionPick?.(key);
        return true;
      }
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
      setHoveredRegion(undefined);
      if (props?.canvasPick) props.onCanvasHover?.(props.canvasPick, undefined);
      props?.onPointer?.(undefined);
    },
    cursor: () => (props?.pick ? "crosshair" : null),
  };

  /** What the editor asks of a view, as far as a scene has it. */
  const api: ViewerApi = {
    camera: () => camera.camera(),
    home: () => camera.home(),
    homeCamera: () => camera.homeCamera(),
    pointAt(clientX, clientY) {
      const p = host.port(clientX, clientY);
      return p ? hitAt(p.x, p.y, "face")?.point : undefined;
    },
    faceAt(clientX, clientY) {
      const p = host.port(clientX, clientY);
      return p ? hitAt(p.x, p.y, "face")?.entity : undefined;
    },
  };

  const shapeOf = (body: string) => drawn.find((d) => d.shape.body === body)?.shape;
  // ── the camera: the scene's, moved and read in the model's frame (sceneCamera.ts) ──
  const point = (array: ArrayLike<number>, i: number) => new Local.Vector3(array[3 * i]!, array[3 * i + 1]!, array[3 * i + 2]!);
  /** The vertices of a face group of a shape. */
  const faceVertices = (shape: MeshedShape, group: { start: number; count: number }) => {
    const out: Local.Vector3[] = [];
    for (let i = group.start; i < group.start + group.count; i++) out.push(point(shape.faces.vertices, shape.faces.triangles[i]!));
    return out;
  };
  const sketchVertices = (names?: readonly string[]) => (props?.sketches ?? []).filter((s) => !names || names.includes(s.name)).flatMap((s) => s.outline.flatMap((l) => l.points.map((p) => new Local.Vector3(...p))));
  const boxCorners = (box: Local.Box3) => (box.isEmpty() ? [] : [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Local.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)));
  /** The part of the port that the editor's panels leave free: this view's element, the editor's stage cell, in port pixels. */
  const free = () => {
    const r = element?.getBoundingClientRect();
    const at = r && host.port(r.left, r.top);
    return r && at && r.width && r.height ? { x: at.x, y: at.y, width: r.width, height: r.height } : null;
  };
  const camera = sceneCamera({
    camera: host.camera,
    size: () => host.size(),
    free,
    toStage: () => (root.visible ? new Local.Matrix4().fromArray(root.matrix.elements) : null),
    nextFrame: (fn) => host.nextFrame(fn),
    modelPoints: () => [...drawn.flatMap((d) => boxCorners(new Local.Box3().setFromArray(d.shape.faces.vertices))), ...sketchVertices()],
    vertices: () => [...drawn.flatMap((d) => Array.from({ length: d.shape.faces.vertices.length / 3 }, (_, i) => point(d.shape.faces.vertices, i))), ...sketchVertices()],
    facesInView: (inView) =>
      drawn.flatMap(({ shape }) =>
        shape.body ? (shape.faces.faceGroups ?? []).flatMap((g, gi) => (entityIndex(shape.faceIndex, gi) >= 0 && faceVertices(shape, g).every(inView) ? [{ body: shape.body!, index: entityIndex(shape.faceIndex, gi) }] : [])) : [],
      ),
    sketchesInView: (inView) => (props?.sketches ?? []).filter((s) => s.outline.every((l) => l.points.every((p) => inView(new Local.Vector3(...p))))).map((s) => s.name),
    faceCoveringView() {
      // Sampled on a grid over the view, as Viewer.tsx's.
      const size = free();
      if (!size) return undefined;
      const counts = new Map<string, { body: string; index: number; n: number }>();
      const N = 12;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const e = hitAt(size.x + ((i + 0.5) / N) * size.width, size.y + ((j + 0.5) / N) * size.height, "face")?.entity;
          if (!e || e.index < 0) continue;
          const key = `${e.body}:${e.index}`;
          const c = counts.get(key) ?? { body: e.body, index: e.index, n: 0 };
          c.n++;
          counts.set(key, c);
        }
      return [...counts.values()].sort((a, b) => b.n - a.n)[0];
    },
    facePoints: (located) =>
      located.flatMap(({ body, indices }) => {
        const shape = shapeOf(body);
        if (!shape) return [];
        return (shape.faces.faceGroups ?? []).flatMap((g, gi) => (indices.includes(entityIndex(shape.faceIndex, gi)) ? boxCorners(new Local.Box3().setFromPoints(faceVertices(shape, g))) : []));
      }),
    sketchPoints: (names) => sketchVertices(names),
    bodies: () => drawn.flatMap((d) => (d.shape.body ? [d.shape.body] : [])),
    faceRefs: () => props?.faceRefs,
    home: () => props?.home,
    onReport: (view) => props?.onViewChange?.(view),
    onTurning: (turning) => element && (element.dataset["turning"] = String(turning)),
  });
  let cube: SceneViewCube | undefined;

  // ── for tests ──
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
    cameraDirection: () => camera.direction() ?? [0, 0, 0],
    viewCubePoint: (region) => cube?.point(region),
    intent: () => camera.intent(),
    canvases: () =>
      drawnCanvases.map(({ canvas: c }) => ({ id: c.id, opacity: c.opacity, through: c.through, highlight: c.highlight, world: c.corners, corners: c.corners.flatMap((p) => toScreen(new THREE.Vector3(...p)) ?? []).map(({ x, y }) => ({ x, y })) })),
    canvasPoint(id, u, v) {
      const c = drawnCanvases.find((d) => d.canvas.id === id)?.canvas;
      if (!c) return undefined;
      const [a, b, , d] = c.corners.map((p) => new THREE.Vector3(...p)) as [Three.Vector3, Three.Vector3, Three.Vector3, Three.Vector3];
      const s = toScreen(a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(d.clone().sub(a), v));
      return s?.visible ? { x: Math.round(s.x), y: Math.round(s.y) } : undefined;
    },
    peerMarkers: () =>
      [...markers].flatMap(([key, m]) => {
        const s = toScreen(m.point);
        return s ? [{ key, x: Math.round(s.x), y: Math.round(s.y) }] : [];
      }),
    regions: () =>
      drawnRegions.map(({ region, mesh }) => {
        // The centroid of a triangle that a click there hits, as regions may be concave or have holes.
        const t = region.triangles;
        let at: { x: number; y: number } | undefined;
        for (let i = 0; i + 8 < t.length && !at; i += 9) {
          const c = new THREE.Vector3((t[i]! + t[i + 3]! + t[i + 6]!) / 3, (t[i + 1]! + t[i + 4]! + t[i + 7]!) / 3, (t[i + 2]! + t[i + 5]! + t[i + 8]!) / 3);
          const s = toScreen(c);
          if (!s?.visible) continue;
          const [x, y] = [Math.round(s.x), Math.round(s.y)];
          const p = host.port(x, y);
          if (p && document.elementFromPoint(x, y) instanceof HTMLCanvasElement && regionAt(p.x, p.y) === region.key) at = { x, y };
        }
        // As drawn: by the material it is drawn with, and the outline that only a hovered one has.
        const r = materials?.region;
        const outlined = hoveredRegion === region.key && regionOutline.children.length > 0;
        return { key: region.key, chosen: mesh.material === r?.chosen || mesh.material === r?.chosenHovered, hovered: outlined && (mesh.material === r?.hovered || mesh.material === r?.chosenHovered), point: at };
      }),
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

  // ── pins of comments and annotations, and collaborators' pointers, laid over the view, as Viewer.tsx's (D1, D2) ──
  /** Where a pin on entities goes: on their biggest triangle or longest segment. */
  const anchorOf = (body: string, kind: EntityKind, indices: number[]) => {
    const shape = shapeOf(body);
    return shape && indices.flatMap((i) => candidates(shape, kind, i)).sort((a, b) => b.size - a.size)[0]?.point;
  };
  /** A model point on the screen relative to the view's element, if the port shows it there. */
  const placed = (point: Three.Vector3 | undefined, rect: DOMRect) => {
    const s = point && toScreen(point);
    if (!s) return undefined;
    const [x, y] = [s.x - rect.left, s.y - rect.top];
    return { x, y, visible: s.visible && x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
  };
  /** Buttons over the view at points on the model, which each frame places. */
  const floating = new Map<string, { el: HTMLButtonElement; point: Three.Vector3 | undefined; onClick: (at: { x: number; y: number }) => void }>();
  const float = (key: string, className: string, onClick: (at: { x: number; y: number }) => void) => {
    let f = floating.get(key);
    if (!f) {
      const el = document.createElement("button");
      // The view's element lets the pointer through to the scene; a pin takes it.
      el.style.pointerEvents = "auto";
      const created = { el, point: undefined, onClick };
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        const r = el.getBoundingClientRect();
        created.onClick({ x: r.left, y: r.bottom });
      });
      el.addEventListener("pointerenter", () => props?.onPinHover?.(el.dataset["key"]));
      el.addEventListener("pointerleave", () => props?.onPinHover?.(undefined));
      element?.append(el);
      floating.set(key, created);
      f = created;
    }
    f.onClick = onClick;
    f.el.className = className;
    return f;
  };
  const unfloat = (keep: (key: string) => boolean) => {
    for (const [key, f] of floating) {
      if (keep(key)) continue;
      // Gone under the pointer: it is hovered no more.
      if (f.el.matches(":hover")) props?.onPinHover?.(undefined);
      f.el.remove();
      floating.delete(key);
    }
  };
  const drawPins = (pins: Pin[]) => {
    const keys = new Set(pins.map((p) => `pin:${p.key}`));
    unfloat((key) => !key.startsWith("pin:") || keys.has(key));
    for (const pin of pins) {
      const f = float(`pin:${pin.key}`, "cad-model__pin", (at) => props?.onPin?.(pin.key, at));
      const drawnAs = JSON.stringify([pin.icons, pin.count]);
      if (f.el.dataset["drawn"] !== drawnAs) {
        f.el.dataset["drawn"] = drawnAs;
        f.el.replaceChildren(...pin.icons.map((icon) => iconElement(icon, 12)), ...(pin.count === undefined ? [] : [String(pin.count)]));
      }
      f.el.title = pin.label;
      f.el.setAttribute("aria-label", pin.label);
      f.el.dataset["threads"] = String(pin.threads);
      f.el.dataset["annotations"] = String(pin.annotations);
      if (pin.state) f.el.dataset["state"] = pin.state;
      else delete f.el.dataset["state"];
      f.el.dataset["key"] = pin.key;
      f.el.dataset["focused"] = pin.focused ? "true" : "false";
      f.el.dataset["selected"] = pin.selected ? "true" : "false";
      if (pin.new) f.el.dataset["new"] = "true";
      else delete f.el.dataset["new"];
      f.point = anchorOf(pin.body, pin.kind, pin.indices);
    }
    placeFloating();
  };
  const placeFloating = () => {
    if (!floating.size || !element) return;
    const rect = element.getBoundingClientRect();
    for (const f of floating.values()) {
      const at = placed(f.point, rect);
      f.el.hidden = !at?.visible;
      if (at) f.el.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
  };

  /** A marker per collaborator: a dot on the model and their name next to it, which each frame places. */
  const markers = new Map<string, { dot: Three.Mesh; label: HTMLDivElement; point: Three.Vector3 }>();
  const dotGeometry = new THREE.SphereGeometry(1, 12, 8);
  const drawPeers = (peers: PeerMarker[]) => {
    const keys = new Set(peers.map((p) => p.key));
    for (const [key, m] of markers) {
      if (keys.has(key)) continue;
      m.dot.removeFromParent();
      m.label.remove();
      markers.delete(key);
    }
    for (const peer of peers) {
      let m = markers.get(peer.key);
      if (!m) {
        const label = document.createElement("div");
        label.className = "cad-model__peer";
        label.append(contactToken(peer.contactUrl));
        element?.append(label);
        m = { dot: new THREE.Mesh(dotGeometry), label, point: new THREE.Vector3() };
        peerGroup.add(m.dot);
        markers.set(peer.key, m);
      }
      if (materials) m.dot.material = materials.peer(peer.color).marker;
      m.label.style.setProperty("--peer-color", peer.color);
      m.point.set(...peer.point);
      m.dot.position.copy(m.point);
    }
    if (element) element.dataset["peerMarkers"] = String(markers.size);
    placeMarkers();
  };
  /** Places the markers' labels and sizes their dots to a constant few pixels. */
  const placeMarkers = () => {
    const c = camera.now();
    const size = host.size();
    if (!markers.size || !element || !c || !size) return;
    const rect = element.getBoundingClientRect();
    const tan = Math.tan(THREE.MathUtils.degToRad(c.fov / 2));
    let resized = false;
    for (const m of markers.values()) {
      const at = placed(m.point, rect);
      m.label.hidden = !at?.visible;
      if (at) m.label.style.transform = `translate(${at.x}px, ${at.y}px)`;
      const scale = (4 * 2 * c.position.distanceTo(new Local.Vector3(m.point.x, m.point.y, m.point.z)) * tan) / size.height;
      // Drawn again only when a dot's size changes, not every frame.
      if (Math.abs(scale - m.dot.scale.x) <= 1e-3 * scale) continue;
      m.dot.scale.setScalar(scale);
      resized = true;
    }
    if (resized) host.invalidate();
  };
  const clearOverlays = () => {
    unfloat(() => false);
    for (const m of markers.values()) {
      m.dot.removeFromParent();
      m.label.remove();
    }
    markers.clear();
  };

  const Viewer: Component<ViewerProps> = (p) => {
    props = p;
    const el = Object.assign(document.createElement("div"), { cadViewer: hook });
    el.className = "cad-model__viewer cad-model__viewer--host";
    Object.assign(el.dataset, { hovered: "", selected: "" });
    element = el;
    // Once mounted: the theme is where the element is.
    createEffect(() => {
      materials ??= makeMaterials(el);
      cube ??= sceneViewCube(el, camera, p.collapseViewCube ?? false);
    });
    createEffect(() => cube?.setHomeHovered(!!p.homeHovered));
    // A camera given to the view, e.g. a named view: a new object each time, which moves the scene's camera.
    createEffect(() => {
      const view = p.view;
      if (view) camera.apply(view);
    });
    createEffect(() => {
      // Hover changes kind with the pick target, and picking ends a selection.
      el.dataset["pick"] = p.pick ?? "";
      setHovered(undefined);
      if (p.pick) setSelected(undefined);
    });
    createEffect(() => {
      drawShapes(p.shapes);
      camera.refit();
    });
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
    createEffect(() => drawRegions(p.regions));
    createEffect(() => drawCanvases(p.canvases ?? []));
    createEffect(() => {
      if (p.canvasPick) el.dataset["canvasPick"] = "true";
      else delete el.dataset["canvasPick"];
    });
    createEffect(() => {
      void p.shapes;
      drawPins(p.pins ?? []);
    });
    createEffect(() => drawPeers(p.peers ?? []));
    p.onApi?.(api);
    onCleanup(() => {
      if (props === p) props = undefined;
      if (element === el) element = undefined;
      hovered = undefined;
      selected = undefined;
      drawCanvases([]);
      for (const g of [bodies, marks, lines, overlays, regionGroup, regionOutline]) clear(g);
      drawn = [];
      picking = pickingOf(THREE, []);
      drawnRegions = [];
      hoveredRegion = undefined;
      materials?.dispose();
      materials = undefined;
      cube?.dispose();
      cube = undefined;
      clearOverlays();
      host.invalidate();
    });
    return el;
  };

  return {
    Viewer,
    input,
    moved,
    update() {
      cube?.render();
      placeFloating();
      placeMarkers();
    },
    hovered: () => hovered,
    at(x, y) {
      const h = hitAt(x, y);
      return h && { entity: h.entity, point: h.point };
    },
    dispose() {
      camera.dispose();
      clearOverlays();
      dotGeometry.dispose();
      for (const g of [bodies, marks, lines, overlays, regionGroup, regionOutline]) clear(g);
      materials?.dispose();
      root.removeFromParent();
      host.invalidate();
    },
  };
}
