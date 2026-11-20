// Types for the part of glb.js this package uses. glb.js is the scene's GLB encoder, copied whole and never edited (its own header says why), so it stays JS beside this declaration.

type Floats = Float32Array | number[];
type Color = string | [number, number, number] | [number, number, number, number];

export interface GlbPrimitive {
  positions: Floats;
  normals?: Floats;
  indices?: Uint32Array | Uint16Array | number[];
  mode?: number;
  color?: Color;
  metallic?: number;
  roughness?: number;
  doubleSided?: boolean;
  unlit?: boolean;
  blend?: boolean;
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
