import { existsSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import externals from "@inkandswitch/patchwork-bootloader/externals";

/** The fonts SVG texts are drawn in, from the devshell (flake.nix), bundled as assets of the kernel worker (src/kernel/fonts.ts). */
const fonts = process.env["CAD_FONTS"];
if (!fonts || !existsSync(fonts)) throw new Error("CAD_FONTS isn't set: build inside `nix develop`, which provides the fonts SVG texts are drawn in");

// The canonical bundled-tool config from the writing-patchwork-tools skill, plus
// an ES-module kernel worker.
export default defineConfig({
  base: "./",
  resolve: { alias: { "cad-fonts": fonts } },
  plugins: [solid(), cssInjectedByJsPlugin({ relativeCSSInjection: true })],
  worker: { format: "es" },
  build: {
    sourcemap: true,
    cssCodeSplit: true,
    emptyOutDir: true,
    minify: false,
    // The entry is parsed in a worker; keep it free of the DOM-touching preload helper.
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
