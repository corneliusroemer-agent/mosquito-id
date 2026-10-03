import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // One worker: these are cheap but they share a served build, and six agents
  // share this box.
  workers: 1,
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
