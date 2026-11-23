// `pnpm build:scene`: installs the scene tool's dependencies from its own lockfile.
//
//   node scene.ts install
//
// The scene (patchwork-experiments/scene) is a git submodule, pinned to the commit the tests run
// against; it has its own pnpm workspace and lockfile, outside ours.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SCENE_DIR } from "./e2e/scene-dir.ts";

if (!existsSync(join(SCENE_DIR, "package.json"))) {
  console.error(`The scene tool isn't checked out at ${SCENE_DIR}. Run \`git submodule update --init\` in the repository.`);
  process.exit(1);
}
const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: SCENE_DIR, stdio: "inherit" });
process.exit(result.status ?? 1);
