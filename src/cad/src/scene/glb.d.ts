// Types for the part of glb.js this package uses. glb.js is the scene's GLB encoder, copied whole and never edited (its own header says why), so it stays JS beside this declaration.

type Floats = Float32Array | number[];
type Color = string | [number, number, number] | [number, number, number, number];

/** A PNG or JPEG as a primitive's base colour (glb.js v4). */
export interface GlbTexture {
  image: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  smooth?: boolean;
  repeat?: boolean;
}

export interface GlbPrimitive {
  positions: Floats;
  normals?: Floats;
  /** TEXCOORD_0 per vertex; (0, 0) is the image's top left. */
  uvs?: Floats;
  indices?: Uint32Array | Uint16Array | number[];
  mode?: number;
  color?: Color;
  metallic?: number;
  roughness?: number;
  doubleSided?: boolean;
  unlit?: boolean;
  blend?: boolean;
  texture?: GlbTexture;
  /** The material's `extras`, e.g. `{ colorScheme: "light" }` for a picture drawn for a light background (glb.js v5). */
  materialExtras?: object;
}

export interface GlbMesh {
  name?: string;
  primitives: GlbPrimitive[];
  extras?: object;
}

export interface GlbNode {
  name?: string;
  mesh?: number;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  children?: number[];
  extras?: object;
}

export interface GlbScene {
  meshes: GlbMesh[];
  nodes?: GlbNode[];
  extras?: object;
  generator?: string;
  copyright?: string;
  units?: string;
}

export type Bounds = { min: [number, number, number]; max: [number, number, number] };

export const MODE: Readonly<{ POINTS: 0; LINES: 1; LINE_LOOP: 2; LINE_STRIP: 3; TRIANGLES: 4; TRIANGLE_STRIP: 5; TRIANGLE_FAN: 6 }>;
export function encodeGLB(scene: GlbScene): Uint8Array;
export function computeBounds(positions: Floats): Bounds | null;
export function computeNormals(positions: Floats, indices?: Uint32Array | Uint16Array | number[]): Float32Array;
export function parseGLB(bytes: Uint8Array): { json: any; bin: Uint8Array | null };
