import { defineConfig } from "vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import externals from "@inkandswitch/patchwork-bootloader/externals";

// As src/cad's config; React and tldraw are bundled, the importmap doesn't provide them.
export default defineConfig({
  base: "./",
  plugins: [cssInjectedByJsPlugin({ relativeCSSInjection: true })],
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    sourcemap: true,
    cssCodeSplit: true,
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    rollupOptions: {
      external: externals,
      input: "./src/index.ts",
      output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
      preserveEntrySignatures: "strict",
    },
  },
});
