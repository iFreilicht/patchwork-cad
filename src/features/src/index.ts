/** The feature library that models import. A model runs with replicad, OCCT and this library alone. */
export { any, edge, ref, Named, Ref } from "./refs.ts";
export { Body, Sketch, defineFeature } from "./feature.ts";
export type { Feature, FeatureDefinition, FeatureMeta, Frame, Profile } from "./feature.ts";
export type { ParamSpec } from "./schema.ts";
export { plane, rect, circle, polygon, sketch, extrude, fillet, chamfer, body } from "./features.ts";
export type { BodySource } from "./features.ts";
