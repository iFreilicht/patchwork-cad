import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSIC_SENTINEL, SUBDUCTION_SENTINEL } from "../site/sentinels.ts";

export const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE_DIR = join(HARNESS_DIR, "site");
const DIST_DIR = join(SITE_DIR, "dist");
const VITE = join(HARNESS_DIR, "node_modules", ".bin", "vite");

export interface Stack {
  /** http://localhost:<port> */
  siteUrl: string;
  /** ws://127.0.0.1:<port> */
  subductionUrl: string;
  /** Requests (e.g. WebSocket upgrades) sent to the classic sync-server address, which nothing serves. */
  classicRequests: () => number;
  /** Connections to it that never sent anything, e.g. from <link rel=preconnect>. */
  classicPreconnects: () => number;
  stop: () => Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stack: ${what} not ready after ${timeoutMs}ms`);
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

/** Plain node:http rather than fetch: see the setTypeOfService note in the harness README. */
function httpOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once("error", () => resolve(false));
  });
}

function host(url: string): string {
  return url.replace(/^\w+:\/\//, "");
}

/** Copies dist/ (copy-on-write where supported), with the sentinels replaced. */
async function patchedSite(into: string, replacements: Map<string, string>): Promise<void> {
  await cp(DIST_DIR, into, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const patched: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ([".js", ".html"].includes(extname(path))) {
        const text = await readFile(path, "utf8");
        let next = text;
        for (const [from, to] of replacements) next = next.replaceAll(from, to);
        if (next !== text) {
          await writeFile(path, next);
          patched.push(path);
        }
      }
    }
  };
  await walk(into);
  if (patched.length === 0) throw new Error("stack: no sentinel found in dist/ — rebuild the site");
}

function kill(name: string, child: ChildProcess, log: string[]): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.push(`[stack] ${name} ignored SIGTERM for 5s, sending SIGKILL`);
      console.warn(`[stack] ${name} ignored SIGTERM for 5s, sending SIGKILL`);
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => (clearTimeout(timer), resolve()));
    child.kill("SIGTERM");
  });
}

function spawnLogged(name: string, command: string, args: string[], cwd: string, log: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const append = (chunk: Buffer) => log.push(...chunk.toString().split("\n").filter(Boolean).map((l) => `[${name}] ${l}`));
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

/**
 * Starts a Subduction server and the built site on free ports, with fresh
 * storage. The site build must exist (`pnpm build`).
 */
export async function startStack(): Promise<Stack & { log: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "patchwork-harness-"));
  const log: string[] = [];
  const children: [string, ChildProcess][] = [];

  // Nothing speaks the classic protocol locally; this sink only counts attempts.
  let classicRequests = 0;
  const classicSockets = new Map<net.Socket, boolean>();
  const classicSink = net.createServer((socket) => {
    classicSockets.set(socket, false);
    socket.once("data", () => {
      classicSockets.set(socket, true);
      classicRequests++;
      socket.destroy();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => classicSink.listen(0, "127.0.0.1", r));
  const classicPort = (classicSink.address() as net.AddressInfo).port;

  const stop = async () => {
    await Promise.all(children.map(([name, child]) => kill(name, child, log)));
    classicSink.close();
    for (const socket of classicSockets.keys()) socket.destroy();
    await rm(root, { recursive: true, force: true });
  };

  try {
    const subductionPort = await freePort();
    const subductionUrl = `ws://127.0.0.1:${subductionPort}`;
    children.push([
      "subduction",
      spawnLogged(
        "subduction",
        "subduction_cli",
        ["server", "--socket", `127.0.0.1:${subductionPort}`, "--data-dir", join(root, "subduction"), "--ephemeral-key"],
        root,
        log,
      ),
    ]);

    await patchedSite(
      join(root, "site"),
      new Map([
        [host(SUBDUCTION_SENTINEL), host(subductionUrl)],
        [host(CLASSIC_SENTINEL), `127.0.0.1:${classicPort}`],
      ]),
    );
    const sitePort = await freePort();
    const siteUrl = `http://localhost:${sitePort}`;
    children.push([
      "site",
      spawnLogged(
        "site",
        VITE,
        ["preview", SITE_DIR, "--outDir", join(root, "site"), "--port", String(sitePort), "--strictPort", "--host", "localhost"],
        HARNESS_DIR,
        log,
        // The patchwork plugin sets preview.port from PORT, overriding --port.
        { PORT: String(sitePort) },
      ),
    ]);

    await waitFor("subduction", () => tcpOpen(subductionPort));
    await waitFor("site", () => httpOk(siteUrl));
    return {
      siteUrl,
      subductionUrl,
      classicRequests: () => classicRequests,
      classicPreconnects: () => [...classicSockets.values()].filter((sent) => !sent).length,
      stop,
      log,
    };
  } catch (error) {
    await stop();
    throw new Error(`${String(error)}\n${log.join("\n")}`);
  }
}
