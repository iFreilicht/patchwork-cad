// `pnpm run publish <sync server> <package url>`: publishes the CAD tool
// (src/cad) into an existing pushwork package, e.g.
//
//   pnpm run publish wss://subduction.sync.inkandswitch.com automerge:3PkuqYnPLga4DGQqaYsVet2bRcaJ
//
// Builds the tool, clones the package into a temporary directory, replaces its
// files with src/cad's (files git tracks or doesn't ignore, plus the fresh
// dist/), and syncs. The package keeps its URL, so every Patchwork account that
// has it installed loads the new version.
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const HARNESS_DIR = import.meta.dirname;
const REPO = resolve(HARNESS_DIR, "..", "..");
const TOOL_DIR = join(REPO, "src", "cad");
const PUSHWORK = join(HARNESS_DIR, "node_modules", ".bin", "pushwork");

const [server, packageUrl, ...rest] = process.argv.slice(2);
if (!server || !packageUrl || rest.length > 0) usage();
if (!/^wss?:\/\//.test(server)) usage(`the sync server must be a ws:// or wss:// URL, got ${JSON.stringify(server)}`);
if (!/^automerge:[1-9A-HJ-NP-Za-km-z]+$/.test(packageUrl)) usage(`expected an automerge: URL without heads, got ${JSON.stringify(packageUrl)}`);

function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: pnpm run publish <sync server, e.g. wss://subduction.sync.inkandswitch.com> <automerge:package url>");
  process.exit(2);
}

/** Runs a command with inherited stdio, or with stdout captured (and still shown) if `capture`. */
function run(command: string, args: string[], options: { cwd: string; capture?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, PUSHWORK_SUBDUCTION_SERVER: server },
      stdio: ["inherit", options.capture ? "pipe" : "inherit", "inherit"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
  });
}

/** Paths below TOOL_DIR that git tracks or doesn't ignore, excluding dist/ and files deleted from the working tree. */
async function sourceFiles(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "."], { cwd: TOOL_DIR });
  return [...new Set(stdout.split("\0"))].filter((path) => path && !path.startsWith("dist/") && existsSync(join(TOOL_DIR, path)));
}

await run("pnpm", ["--filter", "patchwork-cad", "build"], { cwd: REPO });
const files = await sourceFiles();

const work = await mkdtemp(join(tmpdir(), "patchwork-cad-publish-"));
const clone = join(work, "package");
try {
  await run(PUSHWORK, ["clone", packageUrl, clone], { cwd: work });

  for (const entry of await readdir(clone)) {
    if (entry !== ".pushwork") await rm(join(clone, entry), { recursive: true });
  }
  for (const path of files) {
    await mkdir(dirname(join(clone, path)), { recursive: true });
    await cp(join(TOOL_DIR, path), join(clone, path));
  }
  await cp(join(TOOL_DIR, "dist"), join(clone, "dist"), { recursive: true });

  // pushwork exits with 0 even if the server hasn't confirmed every change.
  const output = await run(PUSHWORK, ["sync"], { cwd: clone, capture: true });
  if (!output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").some((line) => line.trim() === "SYNCED")) {
    throw new Error(`pushwork did not report SYNCED; retry with \`PUSHWORK_SUBDUCTION_SERVER=${server} ${PUSHWORK} sync\` in ${clone}`);
  }
} catch (error) {
  console.error(`publishing failed; the working directory is kept at ${work}`);
  throw error;
}
await rm(work, { recursive: true });
console.log(`published ${TOOL_DIR} to ${packageUrl} via ${server}`);
