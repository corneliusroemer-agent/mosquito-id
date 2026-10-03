# Tier 2 — real inference

Opt-in. Loads a real ONNX model and classifies real photos through the app's own
pipeline, on CPU. **Not run by default**, and not reachable from `npm run test:e2e`.

```sh
npm run test:e2e:model
```

The Playwright project only exists when `MOSQ_E2E_TIER2=1` is set, so a bare
`playwright test` cannot download a model by accident.

## What this tier is for, and when to run it

Tier 1 proves the app's UI contract with the model stubbed. It cannot catch a
wrong *answer*, because it never computes one — it feeds the shipped arithmetic a
posterior and asserts the rendering. Tier 2 is the layer that can.

It is slow and needs the network, so it is a regression net rather than a
feedback loop:

- **before merging** a change to the classifier path, the crop, or the previews;
- **periodically**, as the manual check it replaces;
- **when a model changes**, which Tier 1 can never cover at all.

| | Tier 1 | Tier 2 |
| --- | --- | --- |
| Trigger | every push | before merges, and periodically |
| Command | `npm run test:e2e` | `npm run test:e2e:model` |
| Cost | **~34 s**, no model download | **~14 s** plus ~180 MB, once per run |
| Catches | UI contract, layout, reactivity, the fusion arithmetic | the verdict a real photo actually gets |

Tier 2 turns out to be cheap enough to be worth running far more often than
"periodically" implies.

## Measured, on the real path

Real CDN fetch, real `processFiles`, real sample photos, WASM EP:

| | |
| --- | --- |
| `modelsReady` | **6.3 s** (both downloads + both session creates) |
| First photo | **2406 ms** (detector 303, classifier 2029) |
| Subsequent photos | **2012 ms**, **1999 ms** |
| Total script | **13.9 s**, node peak RSS **549 MB** |
| Footer reads | `inference: BioCLIP B/16 FP16 (WASM CPU) · 1063ms/photo` |

Verdicts on real samples: `species` *Aedes vexans* p=0.70; `species` *Aedes
albopictus* p=0.61; `species` *Aedes albopictus* p=0.88 — all `crop_rejected: false`,
`is_cropped: true`, one detector box each.

A blank canvas comes back **`unsure`**, not `non-mosquito`: the detector finds no
box, so the whole photo is classified and the classifier is simply not confident.
A tier 2 spec must assert `unsure` for the blank case. Anything asserting
`non-mosquito` there is asserting a path this configuration does not reach.

## Two environment facts a harness must respect

Both were measured, and both fail as a **hang** rather than an error, so they are
the reason this file exists.

### 1. The R2 bucket's CORS policy is an allowlist

The models come from the bucket's public development URL. It answers
`Access-Control-Allow-Origin` for these origins only:

```
https://corneliusroemer-agent.github.io
http://127.0.0.1:4173  4199  4299  8100  8153  8907
http://localhost:4173  5173
```

For any other origin the header is absent and the app's own `fetch` throws
`TypeError: Failed to fetch`. `playwright.config.ts` therefore pins the preview
server to `127.0.0.1` on an allowlisted port, and **rejects an unlisted
`MOSQ_E2E_PORT` at config load** rather than letting tier 2 discover it as a
twenty-minute timeout.

`localhost` and `127.0.0.1` are listed separately and are not interchangeable.

`Access-Control-Expose-Headers: Content-Length, Content-Type, ETag` is
load-bearing — the download bar reads its percentage from `Content-Length`, and
without it the bar goes indeterminate with no error.

Adding a port means editing the bucket's CORS policy, which needs the Cloudflare
token and Cornelius's go-ahead. **A test must not do that.**

### 2. Headless WebGPU has no `shader-f16`, and the app hangs rather than falling back

WebGPU itself works headless: the SwiftShader adapter exists and both sessions
report the WebGPU EP. But the adapter lacks `shader-f16`, every remaining
registered engine ships FP16 weights, and every BioCLIP compute pipeline fails to
compile:

```
Error while parsing WGSL: 'f16' type used without 'f16' extension enabled
  var<storage, read_write> outputData: array<vec4<f16>>;
```

3,756 of those in 13 minutes. The trap is that `InferenceSession.create(...,
["webgpu"])` **succeeds** — it only warns that nodes are unassigned — so the
app's own `try { webgpu } catch { wasm }` never fires. The pipelines are invalid
only at dispatch, so `processFiles` never settles and the photo stays
`pending === true` forever.

This is a property of the *headless adapter*, not the app: real Chrome runs
WebGPU fine.

**A tier 2 harness must stub `navigator.gpu` before any app script runs**, so the
webgpu EP is genuinely unavailable and the app takes its own WASM branch. No app
change is needed:

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { get: () => undefined });
});
```

## Hazards for whoever writes the specs

These cost the probe most of its wall-clock:

- **`processFiles` queues silently.** With no session it returns immediately, so
  `await processFiles(...)` is *not* a completion signal. Poll
  `previews.find(p => p.file === file)?.pending === false`.
- **`window.modelsReady` never resets on failure.** A CORS failure or a dead
  engine leaves it `false` forever with no throw, so
  `waitForFunction(() => window.modelsReady)` blocks to the test timeout with
  nothing in the log. **Bound that wait**, and assert on the footer's EP text —
  it turns a silent failure into a readable one.
- **Never `route.fulfill()` a 172 MB body.** It kills the browser process through
  the Playwright IPC pipe, reproducibly. Redirect (302) to a local server.
- **Feed photos one at a time.** `isProcessingBatch` is module-level; a second
  drop queues behind the first.
- **`previews` is prepended**, so indices shift after every drop.
- **A typo in `?engine=` costs 1.26 GB.** The param is honoured only when the
  value is in the model table *and*, for fp16, `FP16_AVAILABLE`; otherwise it
  falls through to the default `webgpu-fp16`. Assert the footer names the engine
  you asked for before feeding a photo.
- **Weight the work**: `taskset -c 8-13 nice -n 10`.

## The model

`webgpu-b16` (172 MB) is what the harness runs, because it is registered, and a
real model on the real path beats a stub.

`culico-net-cls-v1` (85 MB) would be better — under half the download — but it is
**not in this repo and not on the bucket**, and its text embeddings are still
being generated. The harness is written against the registered model table in
`src/app/modelConfig.ts`, so swapping in culico is one entry there plus its
embeddings file, and nothing in the test.

B/16 is weak on real photos: 26.8% top-1 against the 1.26 GB model's 84.8%
(`investigations/2026-10-02-mosquito-id/07-benchmark.md`). **A wrong species from
B/16 is an expected result, not a failure.** A tier 2 spec asserts the pipeline
produced a *coherent* verdict — one of the four states in
`src/confidence/types.ts`, with the score panel, the results table and the pooled
card agreeing with each other — and must not assert a particular species until the
accuracy question is settled separately.

## Running against the deployed site

```sh
MOSQ_E2E_BASE_URL=https://corneliusroemer-agent.github.io/mosquito-id/ npm run test:e2e:model
```

The site's URL is **`/mosquito-id/`**, not the domain root — the root 404s. The
deployed origin is on the model's CORS allowlist, so no proxy is needed, and this
is the only run that exercises what users actually get: the same bundle as a local
run, but behind the deployed headers, caching and TLS path.

**Not usable yet.** The deployed bundle predates `window.__mosqAsync`, which every
test here reaches the app through, so tier 2 cannot drive the live site until the
seam is deployed. Once this branch merges and the site redeploys, the suite should
work against the URL above — worth trying then, since it would catch a
`dist/`-served-happy / deployed-broken split that nothing local can see.

Setting `MOSQ_E2E_BASE_URL` also switches the local webServer **off** rather than
starting and ignoring it: `reuseExistingServer: false` means a stale `dist/` is
otherwise a live alternative, and a run pointed at the deployed URL must not be
able to fall back to it.