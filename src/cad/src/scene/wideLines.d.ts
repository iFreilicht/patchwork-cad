// Types for wideLines.js: three.js's own wide-line classes, made with the three.js given.
import type * as Three from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import type { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

export function wideLines(THREE: typeof Three): {
  LineSegmentsGeometry: typeof LineSegmentsGeometry;
  LineMaterial: typeof LineMaterial;
  LineSegments2: typeof LineSegments2;
};
