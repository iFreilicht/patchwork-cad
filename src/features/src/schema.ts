/**
 * Parameter schemas of the built-in features, without any kernel code, so that an editor can
 * render forms and recognize feature calls without loading replicad.
 */

export type ParamSpec =
  | { kind: "length" | "number"; label: string; optional?: boolean; default?: number }
  | { kind: "choice"; options: readonly string[]; label: string; optional?: boolean; default?: string }
  | { kind: "sketch" | "body" | "profile"; label: string; optional?: boolean }
  /** Face or edge references; `multi`: an array of references. */
  | { kind: "faces" | "edges"; multi: boolean; label: string; optional?: boolean }
  /** An origin plane (`plane("XY")`) or a planar face reference. */
  | { kind: "plane"; label: string; optional?: boolean }
  /** Code that makes shapes, e.g. a function with replicad calls; edited as code, not in a form. */
  | { kind: "code"; label: string; optional?: boolean };

export interface FeatureSchema {
  label: string;
  /** A lucide icon name. */
  icon: string;
  params: Record<string, ParamSpec>;
}

export const schemas = {
  sketch: {
    label: "Sketch",
    icon: "PenLine",
    params: {
      plane: { kind: "plane", label: "Plane" },
      profile: { kind: "profile", label: "Profile" },
      body: { kind: "body", label: "Body of the face", optional: true },
    },
  },
  extrude: {
    label: "Extrude",
    icon: "ArrowUpFromLine",
    params: {
      sketch: { kind: "sketch", label: "Sketch" },
      distance: { kind: "length", label: "Distance", optional: true, default: 10 },
      operation: { kind: "choice", label: "Operation", options: ["new", "join", "cut"], optional: true, default: "new" },
      target: { kind: "body", label: "Target body", optional: true },
      extent: { kind: "choice", label: "Extent", options: ["distance", "through"], optional: true, default: "distance" },
    },
  },
  fillet: {
    label: "Fillet",
    icon: "SquareRoundCorner",
    params: {
      body: { kind: "body", label: "Body" },
      edges: { kind: "edges", label: "Edges", multi: true },
      radius: { kind: "length", label: "Radius" },
    },
  },
  chamfer: {
    label: "Chamfer",
    icon: "Slash",
    params: {
      body: { kind: "body", label: "Body" },
      edges: { kind: "edges", label: "Edges", multi: true },
      distance: { kind: "length", label: "Distance" },
    },
  },
  body: {
    label: "Body",
    icon: "Box",
    params: {
      source: { kind: "code", label: "Shapes" },
    },
  },
} as const satisfies Record<string, FeatureSchema>;

export type FeatureType = keyof typeof schemas;

export const isFeatureType = (name: string): name is FeatureType => Object.hasOwn(schemas, name);
