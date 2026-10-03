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

// Several agents run this suite on one box, and `vite preview` binds a fixed
// port. Two of them picking 4173 collide and the loser's tests run against the
// WINNER's dist - a false pass on someone else's build, which is the exact trap
// BUILD-VERIFICATION.md warns about. The port is therefore per-worktree and
// derived from the directory name.
//
// DERIVATION IS CONSTRAINED BY THE R2 CORS ALLOWLIST. The model bucket answers
// `Access-Control-Allow-Origin` for these origins only:
//
//   https://corneliusroemer-agent.github.io
//   http://127.0.0.1:4173  4199  4299  8100  8153  8907
//   http://localhost:4173  5173
//
// Methods are GET/HEAD; ExposeHeaders is Content-Length, Content-Type, ETag.
// Content-Length is load-bearing - the app's download bar reads its percentage
// from it, and without it the bar goes indeterminate with no error.
//
// So the per-worktree port must be one of the LOCAL entries above, not an
// arbitrary offset from 4173: on any other port every model fetch dies with
// "blocked by CORS policy", and the app does not throw - initEngine's catch only
// paints the message, `window.modelsReady` stays false forever, and a tier2 test
// awaiting it HANGS instead of failing. 8907 is usually already taken on this
// box, so it is last in the list. An unlisted port needs the Cloudflare API
// token and Cornelius's explicit go-ahead; the account has no S3 route.
const CORS_LOCAL_PORTS = [4173, 4199, 4299, 8100, 8153, 8907] as const;
const PORT = Number(
  process.env.MOSQ_E2E_PORT ??
    CORS_LOCAL_PORTS[process.cwd().length % CORS_LOCAL_PORTS.length],
);

// Headless chromium on this box has a SwiftShader WebGPU adapter with no
// `shader-f16`. All three registered engines ship FP16 or INT8 weights, so every
// BioCLIP compute pipeline fails to compile:
//
//   Error while parsing WGSL: 'f16' type used without 'f16' extension enabled
//
// and the classifier then HANGS RATHER THAN THROWS - `InferenceSession.create`
// with `executionProviders: ["webgpu"]` SUCCEEDS, so the app's WASM fallback
// never fires; the pipelines are only invalid at dispatch time, so
// `processFiles` never settles and the photo stays `pending` forever. That is
// why tier2 must stub `navigator.gpu` before any app script runs, making the
// webgpu EP genuinely unavailable so the app's own try/catch takes the WASM
// branch. Measured on that path: models ready in ~6 s, ~2.0 s per photo.
//
// This is a property of the HEADLESS ADAPTER, not of the app: real Chrome runs
// WebGPU fine, which is where the ~164 ms/photo figure comes from.
//
// tier2 must also fail loudly rather than hang: bound the `modelsReady` wait
// and assert on the footer/EP text, so this class of silent failure surfaces as
// a readable assertion instead of a test timeout with no cause.

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
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects,
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});