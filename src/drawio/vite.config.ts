import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import externals from "@inkandswitch/patchwork-bootloader/externals";

/**
 * Copies draw.io's web app, which the editor's iframe loads, next to the bundle as dist/drawio. It
 * comes from the devshell (`DRAWIO_WEBAPP`, a release pinned by hash in webapp.nix).
 */
function drawioWebapp(): Plugin {
  return {
    name: "drawio-webapp",
    apply: "build",
    closeBundle() {
      const from = process.env["DRAWIO_WEBAPP"];
      if (!from || !existsSync(from)) throw new Error("DRAWIO_WEBAPP isn't set: build inside `nix develop`, which provides draw.io's web app");
      cpSync(from, join(import.meta.dirname, "dist", "drawio"), { recursive: true, force: true });
    },
  };
}

// The canonical bundled-tool config from the writing-patchwork-tools skill, plus draw.io's web app.
export default defineConfig({
  base: "./",
  plugins: [drawioWebapp()],
  build: {
    sourcemap: true,
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    rollupOptions: {
      external: externals,
      input: "./src/index.ts",
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
      preserveEntrySignatures: "strict",
    },
  },
});
