/** The feature library that models import. A model runs with replicad, OCCT and this library alone. */
export { any, edge, ref, Named, Ref } from "./refs.ts";
export { Body, Sketch, defineFeature } from "./feature.ts";
export type { Feature, FeatureDefinition, FeatureMeta, Frame, Profile } from "./feature.ts";
export { RegionRef } from "./profile.ts";
export { svg } from "./svg.ts";
export type { SvgOptions } from "./svg.ts";
export { registerFont } from "./text.ts";
export type { Curve, Fill, Path, Point, Segment } from "./profile.ts";
export type { ParamSpec } from "./schema.ts";
export { plane, rect, circle, polygon, sketch, extrude, fillet, chamfer, combine, move, body } from "./features.ts";
export type { BodySource } from "./features.ts";
export { paramSchema } from "./params.ts";
export type { ParamSchema, ParamsSchema, ParametrizedModel } from "./params.ts";
