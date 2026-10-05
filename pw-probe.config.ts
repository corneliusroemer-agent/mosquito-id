import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e/tier1",
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:8153" },
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--no-sandbox"] } } },
  ],
  webServer: {
    command: "npm run build && npx vite preview --host 127.0.0.1 --port 8153 --strictPort",
    url: "http://127.0.0.1:8153",
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
