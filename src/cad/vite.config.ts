import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import externals from "@inkandswitch/patchwork-bootloader/externals";

// The canonical bundled-tool config from the writing-patchwork-tools skill, plus
// an ES-module kernel worker.
export default defineConfig({
  base: "./",
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
