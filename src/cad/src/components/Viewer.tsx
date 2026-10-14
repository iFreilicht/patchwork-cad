import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getEdgeIndex, getFaceIndex, syncFaces, syncLines } from "replicad-threejs-helper";
import type { MeshedShape } from "../kernel/protocol.ts";

export type EntityKind = "face" | "edge";

/** Entities of a body to highlight, by index in the body. */
export interface Highlight {
  body: string;
  kind: EntityKind;
  indices: number[];
}

export interface Entity {
  body: string;
  kind: EntityKind;
  index: number;
}

/** A polyline in world coordinates drawn over the model, e.g. a sketch preview. */
export interface Overlay {
  points: [number, number, number][];
  closed: boolean;
}

export interface ViewerProps {
  shapes: MeshedShape[] | undefined;
  /** Which entities hover and click pick; nothing is pickable without it. */
  pick?: EntityKind | undefined;
  onPick?: (entity: Entity) => void;
  highlight?: Highlight[] | undefined;
  overlays?: Overlay[] | undefined;
}

/**
 * For tests: where on the screen an entity can be clicked. The e2e specs click real pixels, so
 * picking goes through the same raycasting as a user's click.
 */
export interface ViewerTestHook {
  screenPoint(entity: Entity): { x: number; y: number } | undefined;
  /** The pickable entities of the shown shapes. */
  entities(kind: EntityKind): Entity[];
  /** The mean of an entity's mesh vertices. */
  centroid(entity: Entity): [number, number, number] | undefined;
  /** Looks at the model from `direction`, as orbiting the camera would. */
  view(direction: [number, number, number]): void;
}

/** Reads a theme colour that the stylesheet derived for this tool. */
function themeColor(element: Element, name: string): THREE.Color {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  const color = new THREE.Color();
  // three.js parses rgb()/hex only, and a canvas normalises color-mix() to oklch(), which it can't
  // parse either. Painting a pixel converts any CSS colour to sRGB.
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context && value) {
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  }
  return color;
}

/** Material indices of face and edge groups. */
const NORMAL = 0;
const SELECTED = 1;
const HOVER = 2;

interface Rendered {
  shape: MeshedShape;
  mesh: THREE.Mesh;
  lines: THREE.LineSegments | undefined;
}

const same = (a: Entity | undefined, b: Entity | undefined) => !!a && !!b && a.body === b.body && a.kind === b.kind && a.index === b.index;

export function Viewer(props: ViewerProps) {
  let container!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const [hovered, setHovered] = createSignal<Entity>();

  onMount(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    camera.up.set(0, 0, 1);
    camera.position.set(80, -120, 90);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const controls = new OrbitControls(camera, renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const light = new THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(1, -1, 2);
    scene.add(light);

    const faceMaterial = (color: THREE.Color) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 1 });
    const accent = themeColor(container, "--cad-model-accent");
    // Thin lines need the contrast of the text variant, e.g. a sketch outline against a light background.
    const accentLine = themeColor(container, "--cad-model-accent-text");
    const hover = themeColor(container, "--cad-model-hover");
    const faceMaterials = [faceMaterial(themeColor(container, "--cad-model-shape")), faceMaterial(accent), faceMaterial(hover)];
    const lineMaterials = [
      new THREE.LineBasicMaterial({ color: themeColor(container, "--cad-model-edge") }),
      new THREE.LineBasicMaterial({ color: accentLine, linewidth: 3 }),
      new THREE.LineBasicMaterial({ color: hover, linewidth: 3 }),
    ];
    const overlayMaterial = new THREE.LineBasicMaterial({ color: accentLine, depthTest: false });
    const group = new THREE.Group();
    const overlayGroup = new THREE.Group();
    overlayGroup.renderOrder = 1;
    scene.add(group, overlayGroup);
    let rendered: Rendered[] = [];

    let radius = 50;
    let framed: THREE.Sphere | undefined;
    /** Frames the model, unless it still fits in the framed view (so that edits don't move the camera). */
    let viewDirection = new THREE.Vector3(0.55, -0.85, 0.65).normalize();
    const frame = (force = false) => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      radius = sphere.radius;
      if (!force && framed && framed.radius >= sphere.radius && framed.radius <= sphere.radius * 3 && framed.containsPoint(sphere.center) && sphere.center.distanceTo(framed.center) + sphere.radius <= framed.radius * 1.1) return;
      camera.position.copy(sphere.center).addScaledVector(viewDirection, sphere.radius * 3);
      camera.near = sphere.radius / 100;
      camera.far = sphere.radius * 100;
      camera.updateProjectionMatrix();
      controls.target.copy(sphere.center);
      framed = sphere;
    };

    const resize = () => {
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frameId = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(tick);
    };
    tick();

    const dispose = (objects: THREE.Object3D[]) => {
      for (const child of objects) if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) child.geometry.dispose();
    };

    createEffect(() => {
      const shapes = props.shapes;
      if (!shapes) return;
      dispose([...group.children]);
      group.clear();
      let vertices = 0;
      rendered = shapes.map((shape) => {
        const faces = new THREE.BufferGeometry();
        syncFaces(faces, shape.faces);
        const mesh = new THREE.Mesh(faces, faceMaterials);
        group.add(mesh);
        vertices += shape.faces.vertices.length / 3;
        let lines: THREE.LineSegments | undefined;
        if (shape.edges) {
          const geometry = new THREE.BufferGeometry();
          syncLines(geometry, shape.edges);
          lines = new THREE.LineSegments(geometry, lineMaterials);
          group.add(lines);
        }
        return { shape, mesh, lines };
      });
      container.dataset["vertices"] = String(vertices);
      frame();
      applyHighlights();
    });

    const applyHighlights = () => {
      const highlight = props.highlight ?? [];
      const hover = hovered();
      for (const { shape, mesh, lines } of rendered) {
        const paint = (geometry: THREE.BufferGeometry, kind: EntityKind, indexOf: number[] | undefined) => {
          const selected = new Set(highlight.filter((h) => h.body === shape.body && h.kind === kind).flatMap((h) => h.indices));
          geometry.groups.forEach((g, i) => {
            const index = indexOf?.[i] ?? -1;
            const material = same(hover, { body: shape.body ?? "", kind, index }) ? HOVER : selected.has(index) ? SELECTED : NORMAL;
            // three.js reads the groups on every render.
            g.materialIndex = material;
          });
        };
        paint(mesh.geometry, "face", shape.faceIndex);
        if (lines) paint(lines.geometry, "edge", shape.edgeIndex);
      }
    };
    createEffect(applyHighlights);

    createEffect(() => {
      dispose([...overlayGroup.children]);
      overlayGroup.clear();
      for (const overlay of props.overlays ?? []) {
        const geometry = new THREE.BufferGeometry().setFromPoints(overlay.points.map((p) => new THREE.Vector3(...p)));
        overlayGroup.add(overlay.closed ? new THREE.LineLoop(geometry, overlayMaterial) : new THREE.Line(geometry, overlayMaterial));
      }
    });

    // ---------- picking ----------

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    /** The entity of kind `kind` under a canvas position, unless a face hides it. */
    const entityAt = (clientX: number, clientY: number, kind: EntityKind): Entity | undefined => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      raycaster.params.Line = { threshold: radius * 0.015 };
      const faceHit = raycaster.intersectObjects(rendered.map((r) => r.mesh), false)[0];
      if (kind === "face") {
        const r = faceHit && rendered.find((x) => x.mesh === faceHit.object);
        if (!r?.shape.body || faceHit?.faceIndex == null) return undefined;
        const index = r.shape.faceIndex?.[getFaceIndex(faceHit.faceIndex, r.mesh.geometry)] ?? -1;
        return index < 0 ? undefined : { body: r.shape.body, kind, index };
      }
      const lineHit = raycaster.intersectObjects(rendered.flatMap((r) => (r.lines ? [r.lines] : [])), false)[0];
      if (!lineHit || lineHit.index == null) return undefined;
      // An edge behind a face is hidden; the threshold lets edges on the face's border through.
      if (faceHit && faceHit.distance < lineHit.distance - radius * 0.01) return undefined;
      const r = rendered.find((x) => x.lines === lineHit.object);
      if (!r?.shape.body || !r.lines) return undefined;
      const index = r.shape.edgeIndex?.[getEdgeIndex(lineHit.index, r.lines.geometry)] ?? -1;
      return index < 0 ? undefined : { body: r.shape.body, kind, index };
    };

    let down: { x: number; y: number } | undefined;
    const onPointerMove = (event: PointerEvent) => {
      if (!props.pick || event.buttons) return;
      const entity = entityAt(event.clientX, event.clientY, props.pick);
      if (!same(entity, hovered())) setHovered(entity);
    };
    const onPointerDown = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY });
    const onPointerUp = (event: PointerEvent) => {
      const start = down;
      down = undefined;
      // A drag orbits the camera; only a click picks.
      if (!props.pick || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const entity = entityAt(event.clientX, event.clientY, props.pick);
      if (entity) props.onPick?.(entity);
    };
    const onPointerLeave = () => setHovered(undefined);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    createEffect(() => {
      if (!props.pick) setHovered(undefined);
      container.dataset["pick"] = props.pick ?? "";
    });

    const toScreen = (p: THREE.Vector3) => {
      const v = p.clone().project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    };
    const hook: ViewerTestHook = {
      entities: (kind) =>
        rendered.flatMap((r) => {
          const body = r.shape.body;
          const indices = (kind === "face" ? r.shape.faceIndex : r.shape.edgeIndex) ?? [];
          return body ? indices.filter((i) => i >= 0).map((index) => ({ body, kind, index })) : [];
        }),
      centroid(entity) {
        const r = rendered.find((x) => x.shape.body === entity.body);
        const geometry = entity.kind === "face" ? r?.mesh.geometry : r?.lines?.geometry;
        const groups = entity.kind === "face" ? r?.shape.faceIndex : r?.shape.edgeIndex;
        if (!geometry || !groups) return undefined;
        const position = geometry.getAttribute("position");
        const index = entity.kind === "face" ? geometry.getIndex() : null;
        const sum = new THREE.Vector3();
        let n = 0;
        geometry.groups.forEach((g, gi) => {
          if (groups[gi] !== entity.index) return;
          for (let i = g.start; i < g.start + g.count; i++) {
            sum.add(new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i));
            n++;
          }
        });
        return n ? (sum.divideScalar(n).toArray() as [number, number, number]) : undefined;
      },
      view(direction) {
        viewDirection = new THREE.Vector3(...direction).normalize();
        frame(true);
        controls.update();
        camera.updateMatrixWorld();
      },
      screenPoint(entity) {
        const r = rendered.find((x) => x.shape.body === entity.body);
        if (!r) return undefined;
        // Candidate points with their size: triangle centroids by area, segment midpoints by length.
        const candidates: { point: THREE.Vector3; size: number }[] = [];
        if (entity.kind === "face") {
          const position = r.mesh.geometry.getAttribute("position");
          const index = r.mesh.geometry.getIndex();
          r.mesh.geometry.groups.forEach((g, gi) => {
            if (r.shape.faceIndex?.[gi] !== entity.index || !index) return;
            for (let t = g.start; t < g.start + g.count; t += 3) {
              const [p0, p1, p2] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(position, index.getX(t + k))) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
              const area = new THREE.Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0)).length() / 2;
              candidates.push({ point: p0.clone().add(p1).add(p2).divideScalar(3), size: area });
            }
          });
        } else if (r.lines) {
          const position = r.lines.geometry.getAttribute("position");
          r.lines.geometry.groups.forEach((g, gi) => {
            if (r.shape.edgeIndex?.[gi] !== entity.index) return;
            for (let v = g.start; v + 1 < g.start + g.count; v += 2) {
              const a = new THREE.Vector3().fromBufferAttribute(position, v);
              const b = new THREE.Vector3().fromBufferAttribute(position, v + 1);
              candidates.push({ point: a.clone().add(b).multiplyScalar(0.5), size: a.distanceTo(b) });
            }
          });
        }
        candidates.sort((x, y) => y.size - x.size);
        // A point that a click hits reliably: whole pixels, and the same entity a few pixels around it.
        const margin = entity.kind === "face" ? 3 : 1;
        for (const { point } of candidates) {
          const p = toScreen(point);
          const x = Math.round(p.x);
          const y = Math.round(p.y);
          const around = [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]];
          if (around.every(([dx, dy]) => same(entityAt(x + dx!, y + dy!, entity.kind), entity))) return { x, y };
        }
        return undefined;
      },
    };
    (container as HTMLDivElement & { cadViewer?: ViewerTestHook }).cadViewer = hook;

    onCleanup(() => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      dispose([...group.children, ...overlayGroup.children]);
      for (const m of [...faceMaterials, ...lineMaterials, overlayMaterial]) m.dispose();
      renderer.dispose();
    });
  });

  return (
    <div class="cad-model__viewer" ref={container} data-hovered={hovered() ? `${hovered()!.body}:${hovered()!.kind}:${hovered()!.index}` : ""}>
      <canvas ref={canvas} />
    </div>
  );
}
