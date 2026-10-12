import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import patchwork from "@inkandswitch/patchwork/vite";
import { CLASSIC_SENTINEL, SUBDUCTION_SENTINEL } from "./sentinels.ts";

/**
 * Remote URLs hardcoded in the base modules. Each is rewritten to a local
 * path that 404s, which the modules already handle as "unavailable".
 */
const REMOTE_URLS = [
  // threepane seeds a new account's Examples folder from these init scripts.
  "https://patchwork-tools.netlify.app/init.js",
  "https://patchwork-base.netlify.app/init.js",
];

function hermetic(): Plugin {
  let outDir = "";
  return {
    name: "harness-hermetic",
    apply: "build",
    configResolved: (config) => void (outDir = resolve(config.root, config.build.outDir)),
    // Runs after @patchwork/static has copied the base modules into outDir.
    closeBundle: {
      order: "post",
      async handler() {
        const found = new Set<string>();
        for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
          const path = join(entry.parentPath, entry.name);
          const text = await readFile(path, "utf8");
          let next = text;
          for (const url of REMOTE_URLS) {
            if (!next.includes(url)) continue;
            found.add(url);
            next = next.replaceAll(url, `/harness-blocked/${new URL(url).host}${new URL(url).pathname}`);
          }
          if (next !== text) await writeFile(path, next);
        }
        const missing = REMOTE_URLS.filter((url) => !found.has(url));
        if (missing.length) throw new Error(`harness-hermetic: not found in the build, update REMOTE_URLS: ${missing.join(", ")}`);
      },
    },
  };
}

// A minimal copy of github.com/inkandswitch/patchwork.inkandswitch.com. Both
// sync servers are compile-time defines; the harness replaces the sentinels
// with local URLs in a per-run copy of dist/ (see e2e/stack.ts).
export default defineConfig({
  plugins: [
    patchwork({
      title: "Patchwork (harness)",
      storagePrefix: "patchwork-harness",
      syncServers: { subduction: SUBDUCTION_SENTINEL, classic: CLASSIC_SENTINEL },
      icons: false,
      netlify: false,
      buildInfo: false,
      static: ["@inkandswitch/patchwork-pkg-base"],
      preview: { cors: false },
    }),
    hermetic(),
  ],
});
