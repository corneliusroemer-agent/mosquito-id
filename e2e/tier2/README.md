# Tier 2 — real inference

Opt-in. Loads a real ONNX model and classifies real photos through the app's own
pipeline. **Not run by default**, and not reachable from `npm run test:e2e`.

```sh
npm run test:e2e:model
```

The Playwright project only exists when `MOSQ_E2E_TIER2=1` is set, so a bare
`playwright test` cannot download a model by accident.

## What this tier is for, and when to run it

Tier 1 proves the app's UI contract with the model stubbed. It cannot catch a
wrong answer, because it never computes one — it feeds the shipped arithmetic a
posterior and asserts the rendering. Tier 2 is the layer that catches a wrong
answer.

It is slow and it needs the network, so it is a regression net rather than a
feedback loop:

- **before merging** a change to the classifier path, the crop, or the previews;
- **periodically**, as the manual check this replaces;
- **when a model changes**, which is the one case Tier 1 can never cover at all.

## Cadence

| | Tier 1 | Tier 2 |
| --- | --- | --- |
| Trigger | every push | before merges, and periodically |
| Command | `npm run test:e2e` | `npm run test:e2e:model` |
| Cost | ~34 s, no network | minutes, ~180 MB download |
| Catches | UI contract, layout, reactivity, the fusion arithmetic | the verdict a real photo actually gets |

## Status: NOT YET RUNNABLE

**Nothing in this directory runs today.** The specs are not written, and this
section says why, because the blocker is not a missing test — it is that real
inference does not complete in a headless browser on this machine. Both blockers
below were measured, not guessed.

### Blocker 1 — the R2 bucket's CORS allowlist excludes localhost

The models are served from the bucket's public development URL. It returns:

```
Access-Control-Allow-Origin: https://corneliusroemer-agent.github.io
```

and **no header at all** for `http://localhost:*`, `http://127.0.0.1:*`, or
`null`. So the app's own `fetch` of a model is blocked from a local test server,
and the failure surfaces as a `TypeError: Failed to fetch` that looks like a hang
rather than an error.

A Tier 2 harness must therefore either proxy the model host itself or run against
a deployed URL. `docs/CLAUDE`-adjacent note: the deployed site is unaffected,
because the Pages origin is on the allowlist. **Changing the bucket's CORS policy
is out of scope for a test** and needs its own decision.

### Blocker 2 — FP16 compute shaders do not exist on this machine's WebGPU

WebGPU itself works headless, and both sessions report the WebGPU EP:

```
--no-sandbox --enable-unsafe-webgpu --use-gl=swiftshader
navigator.gpu.requestAdapter() -> an adapter, no `shader-f16` feature
window.modelsReady === true
inference: BioCLIP B/16 FP16 (WEBGPU) · YOLO11n (WEBGPU)
```

Then every compute pipeline fails to build:

```
Error while parsing WGSL: 'f16' type used without 'f16' extension enabled
  var<storage, read_write> outputData: array<vec4<f16>>;
```

3,756 of these in 13 minutes. onnxruntime-web emits f16 WGSL for an FP16 model
regardless of adapter features, and `InferenceSession.create` still *succeeds* —
it only warns that nodes are unassigned. The app's
`try { webgpu } catch { wasm }` fallback therefore never fires, because nothing
threw: the kernels fail at dispatch. A photo sits at `pending === true` forever.

The fix for a harness is to remove `navigator.gpu` before the app boots, so
`create(..., ["webgpu"])` genuinely throws and the app's own WASM branch runs:

```js
await context.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { get: () => undefined });
});
```

**The WASM path has never been timed.** Per-photo cost on CPU is unknown, and it
is the number that decides whether this tier is usable at all.

## Measured so far

| | |
| --- | --- |
| Detector (10.6 MB) fetch | 1.4 s node-side, 1.7 s in-page |
| B/16 (172.7 MB) fetch | 4.2 s both (~41 MB/s) |
| `text_embeds_b16.json` | 84 ms |
| nav → `modelsReady` | 23.6 s |
| **per photo** | **never completed** |
| peak RSS | not measured; the runs were killed before reporting |

## The model

`culico-net-cls-v1` (85 MB) would be the right tier-2 model — 1/7th the download
of the default, and real inference. It is **not in this repo and not on the
bucket** (four plausible names all 404), and its text embeddings are still being
generated. The harness is written against the registered `WEBGPU_MODELS` table in
`src/app/modelConfig.ts`, so swapping in culico is one entry in that table plus
its embeddings file — nothing in the test.

Until then the tier runs `webgpu-b16`, which is a real model on the real path.
It is weak on real photos (26.8% top-1 against the 1.26 GB model's 84.8%, per
`investigations/2026-10-02-mosquito-id/07-benchmark.md`), so **a wrong species
from B/16 is an expected result, not a failure.** A Tier 2 test must assert the
pipeline produced a *coherent* verdict — one of the four states in
`src/confidence/types.ts`, with the panels agreeing with each other — and must
not assert a particular species until the accuracy question is settled separately.

## Hazards for whoever writes the specs

These cost the probe most of its wall-clock:

- **`processFiles` queues silently.** With no session it returns immediately, so
  `await processFiles(...)` is *not* a completion signal. Poll
  `previews.find(p => p.file === file)?.pending === false`, and fail on a timeout
  rather than waiting forever.
- **Never `route.fulfill()` a 172 MB body.** It kills the browser process through
  the Playwright IPC pipe, reproducibly. Redirect (302) to a local server
  instead.
- **Feed photos one at a time.** `isProcessingBatch` is module-level; a second
  drop queues behind the first.
- **`previews` is prepended**, so indices shift after every drop.
- **A typo in `?engine=` costs 1.26 GB.** The param is only honoured when the
  value is in the model table *and*, for fp16, `FP16_AVAILABLE` — otherwise it
  falls through to the default `webgpu-fp16`. Assert the footer names the engine
  you asked for before feeding a photo.
- **Pin the port.** `vite preview` binds a fixed port and several agents share
  this box; `playwright.config.ts` derives it per worktree for that reason.
- **Weight the work**: `taskset -c 8-13 nice -n 10`.