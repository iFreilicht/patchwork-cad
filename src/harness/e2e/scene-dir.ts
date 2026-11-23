import { join } from "node:path";
import { HARNESS_DIR } from "./stack.ts";

/** The scene tool package (patchwork-experiments/scene), a git submodule. Build it first (`pnpm build:scene`). */
export const SCENE_DIR = join(HARNESS_DIR, "..", "..", "vendor", "patchwork-experiments", "scene");
