import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  build: { minify: false, sourcemap: true, target: "es2022" },
  preview: { port: 4181, strictPort: true },
});
