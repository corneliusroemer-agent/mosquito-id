import { defineConfig } from "vite";

/**
 * The site is a static GitHub Pages deploy served from /mosquito-id/, so every
 * asset URL in the bundle must be relative to the document. `base: "./"` is what
 * makes that true without a rebuild per deployment path.
 *
 * No plugin for the model: the 1.26 GB classifier and the text embeddings are
 * fetched at RUNTIME from Cloudflare R2 (see src/model/fetch.ts), and a static
 * import of either would try to inline ~1.9 GB into the bundle. Nothing under
 * src/ imports a .onnx, a .json model, or an R2 URL at module scope.
 */
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    // The bundle replaces main.js as the single script the page loads, so it is
    // one file. Splitting it would buy one extra request against a 1.26 GB
    // model fetch and cost a cache-buster to keep straight.
    rollupOptions: {
      output: { inlineDynamicImports: true, entryFileNames: "assets/[name]-[hash].js" },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests read text_embeds.json (660 KB) and construct synthetic heads; none of
    // them touch the model or a browser.
    environment: "node",
  },
});
