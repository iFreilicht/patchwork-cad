// `pnpm dev`: the local stack with persistent storage and live tool modules.
//
//   node dev.ts <name>=<tool dir> ...
//
// Builds the site if it has no build yet, runs `vite build --watch` in every
// tool directory, and serves the tools as static modules of the site (see
// e2e/server.ts). State lives in <repo>/.dev and survives restarts.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HARNESS_DIR, startStack } from "./e2e/stack.ts";

const REPO = resolve(HARNESS_DIR, "..", "..");
const SITE_PORT = Number(process.env["PATCHWORK_DEV_PORT"] ?? 4173);
const SUBDUCTION_PORT = Number(process.env["PATCHWORK_DEV_SUBDUCTION_PORT"] ?? 4174);

const modules = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [name, dir] = arg.split("=");
    if (!name || !dir) throw new Error(`expected <name>=<tool dir>, got ${JSON.stringify(arg)}`);
    return [name, resolve(dir)];
  }),
);

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
  });
}

if (!existsSync(join(HARNESS_DIR, "site", "dist", "index.html"))) await run("pnpm", ["build"], HARNESS_DIR);

const watchers: ChildProcess[] = [];
for (const dir of Object.values(modules)) {
  await run("pnpm", ["build"], dir);
  // Rebuilds on every save; reload the page to load the new build.
  watchers.push(spawn("pnpm", ["exec", "vite", "build", "--watch", "--logLevel", "warn"], { cwd: dir, stdio: "inherit" }));
}

const stack = await startStack({ root: join(REPO, ".dev"), sitePort: SITE_PORT, subductionPort: SUBDUCTION_PORT, modules });
console.log(`\nPatchwork: ${stack.siteUrl}\nSubduction: ${stack.subductionUrl}\nState: ${join(REPO, ".dev")}\n`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  for (const watcher of watchers) watcher.kill("SIGTERM");
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
