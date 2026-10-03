import { defineConfig, devices, type Project } from "@playwright/test";

/**
 * Two tiers.
 *
 * `tier1` is the fast contract: no model, under a minute, run on every push. It
 * aborts the ONNX and the R2 model host, so it never pays the 1.26 GB download.
 *
 * `tier2` loads a real model and classifies real photos. It is NOT part of a
 * default run - the project is only added when `MOSQ_E2E_TIER2=1`, so a bare
 * `playwright test` cannot download a model by accident. See e2e/tier2/README.md.
 *
 * The served build is the point of both. `vite preview` serves `dist/`, and
 * `reuseExistingServer` is off unconditionally: with it on, a `dist/` left from an
 * earlier build is served in preference to a fresh one, so a test can pass
 * against a bundle that is not the one you just built - the trap
 * BUILD-VERIFICATION.md records. The webServer command builds first, so what runs
 * is what was built.
 */
const tier2 = process.env.MOSQ_E2E_TIER2 === "1";

const projects: Project[] = [
  {
    name: "tier1",
    testDir: "e2e/tier1",
    use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--no-sandbox"] } },
  },
  ...(tier2
    ? [
        {
          name: "tier2",
          testDir: "e2e/tier2",
          timeout: 15 * 60_000,
          // `grepInvert` rather than `grep`: a `-g` filter on the command line
          // then cannot reach a model-loading test by accident from the tier1 dir,
          // and a tier2 test still has to opt in by name.
          grepInvert: /@manual-only/,
          use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--no-sandbox"] } },
        } satisfies Project,
      ]
    : []),
];

export default defineConfig({
  // One worker locally: the tests are cheap but they share a served build and a
  // busy box. Two in CI, where nothing else is running.
  workers: process.env.CI ? 2 : 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects,
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});