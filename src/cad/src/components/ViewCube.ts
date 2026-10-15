import * as THREE from "three";

/**
 * A region of the cube: a face, edge or corner, as the sign of each axis (−1, 0 or 1). It is also
 * the direction the camera looks from when the region is clicked.
 */
export type Region = [number, number, number];

const OPACITY = 0.7;

/** The share of a face's half-width that belongs to the edge and corner regions around it. */
const BORDER = 0.3;

/**
 * Each face's frame: its outward normal and the right and up directions of its label. Z is up;
 * the top face reads with Front at the bottom, the bottom face with Front at the top.
 */
const FACES: { label: string; normal: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }[] = [
  { label: "FRONT", normal: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
  { label: "BACK", normal: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
  { label: "RIGHT", normal: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1) },
  { label: "LEFT", normal: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, -1, 0), v: new THREE.Vector3(0, 0, 1) },
  { label: "TOP", normal: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
  { label: "BOTTOM", normal: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, -1, 0) },
];

/** All 26 regions: 6 faces, 12 edges, 8 corners. */
export const REGIONS: Region[] = [-1, 0, 1].flatMap((x) => [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z): Region => [x, y, z]))).filter((r) => r.some((c) => c !== 0));

export const regionKey = (r: Region) => r.join(",");

/** A region's name, e.g. "Front", "Front Right" or "Front Right Top". */
export function regionName([x, y, z]: Region): string {
  const parts = [y < 0 ? "Front" : y > 0 ? "Back" : "", x < 0 ? "Left" : x > 0 ? "Right" : "", z > 0 ? "Top" : z < 0 ? "Bottom" : ""];
  return parts.filter(Boolean).join(" ");
}

/** The camera direction for a region. Top and bottom tilt a little towards the front, so that Z-up orbit controls keep Front at the bottom of the screen. */
export function regionDirection(r: Region): THREE.Vector3 {
  const v = new THREE.Vector3(...r);
  if (r[0] === 0 && r[1] === 0) v.y = -1e-3;
  return v.normalize();
}

/** A quad centred at `center`, spanning ±`u` and ±`v`, facing u × v, with UVs along u and v. */
function quad(center: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): THREE.BufferGeometry {
  const corners = [
    center.clone().sub(u).sub(v),
    center.clone().add(u).sub(v),
    center.clone().add(u).add(v),
    center.clone().sub(u).add(v),
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(corners.flatMap((c) => c.toArray()), 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/** The span along one face axis of a region's quad: the middle for 0, the border towards the sign otherwise. */
const span = (sign: number): [number, number] => (sign === 0 ? [0, 1 - BORDER] : [sign * (1 - BORDER / 2), BORDER / 2]);

export interface ViewCubeColors {
  face: THREE.Color;
  hover: THREE.Color;
  line: THREE.Color;
}

/**
 * The ViewCube's scene: a unit cube split into its 26 regions, drawn into a corner of the viewer's
 * canvas with the main camera's orientation. Picking works in the coordinates of that corner.
 */
export class ViewCube {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 10);
  readonly #regions = new Map<string, THREE.Mesh[]>();
  readonly #pickable: THREE.Mesh[] = [];
  readonly #material: THREE.MeshBasicMaterial;
  readonly #hoverMaterial: THREE.MeshBasicMaterial;
  readonly #disposables: { dispose(): void }[] = [];
  readonly #raycaster = new THREE.Raycaster();
  #hovered: string | undefined;

  constructor(colors: ViewCubeColors) {
    // Translucent, so that the cube doesn't hide the model behind it. Only front faces are drawn, so the back of the cube doesn't show through.
    const face = (color: THREE.Color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: OPACITY, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.#material = face(colors.face);
    this.#hoverMaterial = face(colors.hover);
    this.#disposables.push(this.#material, this.#hoverMaterial);

    for (const region of REGIONS) {
      const meshes: THREE.Mesh[] = [];
      const r = new THREE.Vector3(...region);
      for (const face of FACES) {
        // A region lies on every face whose normal it points along.
        if (r.dot(face.normal) !== 1) continue;
        const [cu, hu] = span(r.dot(face.u));
        const [cv, hv] = span(r.dot(face.v));
        const center = face.normal.clone().addScaledVector(face.u, cu).addScaledVector(face.v, cv);
        const geometry = quad(center, face.u.clone().multiplyScalar(hu), face.v.clone().multiplyScalar(hv));
        const mesh = new THREE.Mesh(geometry, this.#material);
        mesh.userData["region"] = region;
        mesh.userData["normal"] = face.normal;
        this.#disposables.push(geometry);
        meshes.push(mesh);
        this.#pickable.push(mesh);
        this.scene.add(mesh);
      }
      this.#regions.set(regionKey(region), meshes);
    }

    const box = new THREE.BoxGeometry(2, 2, 2);
    const edges = new THREE.EdgesGeometry(box);
    // Transparent too, so that it's drawn after the faces, whose depth hides the back edges.
    const lineMaterial = new THREE.LineBasicMaterial({ color: colors.line, transparent: true });
    const outline = new THREE.LineSegments(edges, lineMaterial);
    outline.renderOrder = 2;
    this.scene.add(outline);
    this.#disposables.push(box, edges, lineMaterial);

    for (const face of FACES) {
      const texture = new THREE.CanvasTexture(label(face.label, colors.line));
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
      const geometry = quad(face.normal.clone(), face.u.clone(), face.v.clone());
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.#disposables.push(texture, material, geometry);
    }
  }

  /** Turns the cube's camera like `camera`, looking at the cube's centre. */
  orient(camera: THREE.Camera): void {
    this.camera.quaternion.copy(camera.quaternion);
    this.camera.position.set(0, 0, 5).applyQuaternion(camera.quaternion);
    this.camera.updateMatrixWorld();
  }

  /** The region under a point in normalised device coordinates of the cube's corner. */
  regionAt(ndc: THREE.Vector2): Region | undefined {
    this.#raycaster.setFromCamera(ndc, this.camera);
    const hit = this.#raycaster.intersectObjects(this.#pickable, false)[0];
    return hit?.object.userData["region"] as Region | undefined;
  }

  /** A point on the region in normalised device coordinates, if it faces the camera. */
  pointOf(region: Region): THREE.Vector2 | undefined {
    const towards = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    const facing = (mesh: THREE.Mesh) => (mesh.userData["normal"] as THREE.Vector3).dot(towards);
    // The quad that faces the camera most; one seen edge-on lies on the cube's outline.
    const meshes = (this.#regions.get(regionKey(region)) ?? []).filter((m) => facing(m) > 0.2).sort((a, b) => facing(b) - facing(a));
    for (const mesh of meshes) {
      const box = new THREE.Box3().setFromObject(mesh);
      const p = box.getCenter(new THREE.Vector3()).project(this.camera);
      const ndc = new THREE.Vector2(p.x, p.y);
      const at = this.regionAt(ndc);
      if (at && regionKey(at) === regionKey(region)) return ndc;
    }
    return undefined;
  }

  hover(region: Region | undefined): void {
    const key = region && regionKey(region);
    if (key === this.#hovered) return;
    for (const mesh of this.#regions.get(this.#hovered ?? "") ?? []) mesh.material = this.#material;
    for (const mesh of this.#regions.get(key ?? "") ?? []) mesh.material = this.#hoverMaterial;
    this.#hovered = key;
  }

  dispose(): void {
    for (const d of this.#disposables) d.dispose();
  }
}

/** A face label, drawn on a transparent canvas. */
function label(text: string, color: THREE.Color): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = `#${color.getHexString()}`;
    context.font = "700 30px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 64, 64, 116);
  }
  return canvas;
}
