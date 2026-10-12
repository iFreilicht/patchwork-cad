import { setOC } from "replicad";
import init from "replicad-opencascadejs";

let loaded: Promise<void> | undefined;

/** Loads OCCT and hands it to replicad, as a model's host would. */
export const loadOC = () => (loaded ??= init().then((oc) => setOC(oc)));
