import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  build: { minify: false, sourcemap: true },
  preview: { port: 4180, strictPort: true },
});
