import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

export interface SiteServerOptions {
  /** The (patched) site build to serve. */
  root: string;
  /**
   * Tool packages served live as static modules of the site, by name: each
   * directory's package.json and dist/ appear at /packages/<name>/, and
   * /modules.json lists them after the site's own modules.
   */
  modules?: Record<string, string>;
}

export interface SiteServer {
  port: number;
  /** Requests served, in order, for timing and cache checks. */
  requests: { path: string; status: number }[];
  close: () => Promise<void>;
}

/** Resolves a URL path inside `dir`, or undefined if it escapes it. */
function inside(dir: string, path: string): string | undefined {
  const file = normalize(join(dir, decodeURIComponent(path)));
  return file === dir || file.startsWith(dir + sep) ? file : undefined;
}

/**
 * A static server for the site, in place of `vite preview`: the same CORS and
 * immutable-asset headers as the patchwork plugin's preview server, plus live
 * module mounts. Hashed assets, the site's and the modules' (OCCT's wasm),
 * are immutable; everything else is revalidated, so a rebuilt module shows up
 * on reload.
 */
export async function startSiteServer(port: number, options: SiteServerOptions): Promise<SiteServer> {
  const modules = Object.entries(options.modules ?? {});
  const requests: SiteServer["requests"] = [];

  const resolve = async (path: string): Promise<{ file: string } | { body: string } | undefined> => {
    if (path === "/modules.json" && modules.length) {
      const settings = JSON.parse(await readFile(join(options.root, "modules.json"), "utf8")) as { modules: string[] };
      settings.modules.push(...modules.map(([name]) => `./packages/${name}/`));
      return { body: JSON.stringify(settings, null, 2) };
    }
    for (const [name, dir] of modules) {
      const prefix = `/packages/${name}/`;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest !== "package.json" && !rest.startsWith("dist/")) return undefined;
      const file = inside(dir, rest);
      return file ? { file } : undefined;
    }
    const file = inside(options.root, path.endsWith("/") ? `${path}index.html` : path);
    return file ? { file } : undefined;
  };

  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status: number, headers: Record<string, string>, body?: string | NodeJS.ReadableStream) => {
      requests.push({ path, status });
      response.writeHead(status, { "Access-Control-Allow-Origin": "*", ...headers });
      if (body === undefined || request.method === "HEAD") response.end();
      else if (typeof body === "string") response.end(body);
      else body.pipe(response);
    };
    resolve(path)
      .then(async (found) => {
        if (!found) return send(404, {});
        const hashed = path.startsWith("/assets/") || /^\/packages\/[^/]+\/dist\/assets\//.test(path);
        const cache = hashed ? "public, max-age=31536000, immutable" : "no-cache";
        if ("body" in found) return send(200, { "Content-Type": "application/json", "Cache-Control": cache }, found.body);
        const info = await stat(found.file).catch(() => undefined);
        if (!info?.isFile()) return send(404, {});
        send(
          200,
          {
            "Content-Type": CONTENT_TYPES[extname(found.file)] ?? "application/octet-stream",
            "Content-Length": String(info.size),
            "Cache-Control": cache,
          },
          createReadStream(found.file),
        );
      })
      .catch((error: unknown) => send(500, {}, String(error)));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "localhost", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
