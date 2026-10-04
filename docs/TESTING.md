# Testing this app

## The one thing that surprises everyone

**`npx playwright test` exits 0 when it never runs.** If the preview server cannot bind
its port it prints an error and returns success, so any gate scripted on the exit code is
green having tested nothing. This has happened twice in one session and both times a merge
went through on a "passing" browser leg that never started.

Check the run actually produced test lines, not just exit status.

## Why the preview port is restricted

The app's model weights are served from an R2 bucket (`mosquito-id-models`), and that
bucket's **CORS allowlist contains six fixed origins**:

```
http://127.0.0.1:4173   4199   4299   8100   8153   8907
```

A page served from **any other origin cannot fetch the models at all** — the request fails
before any model code runs, so the failure looks like a bug in the app rather than a
configuration error. This is why `playwright.config.ts` rejects an unlisted port.

The constraint is the **bucket's CORS policy**, not Playwright, not the browser, and not
the port number itself.

## How to run the browser tests

```sh
MOSQ_E2E_PORT=4173 npx playwright test --project=tier1
```

Pick a free port **from the list above**. Check first:

```sh
ss -ltn | grep -E ':(4173|4199|4299|8100|8153|8907)'
```

Six agents, six ports, and orphaned preview servers from finished agents hold them after
they are done. **Release your port in the same command that reports**, not in a follow-up.

## The better fix: serve the models same-origin

`resolveModelUrl()` in `src/app/modelConfig.ts` returns an absolute URL untouched, so an
engine can be pointed at any host. If the model files are served from the **same origin as
the preview**, the fetch is same-origin, CORS does not apply, and **the test can use any
port it likes.**

To do that, put the two shipped models next to the built site:

```sh
# 81 MB + 172 MB, once
curl -o public/culico-net-cls-v1-17-embed.onnx  "$MODEL_BASE/culico-net-cls-v1-17-embed.onnx"
curl -o public/bioclip_visual_b16_fp16.onnx     "$MODEL_BASE/bioclip_visual_b16_fp16.onnx"
```

Then point `WEBGPU_MODELS` at relative paths. This trades ~253 MB of disk for the ability
to run browser tests without contending for six fixed ports, which has been the single
biggest source of wasted agent time on this project.

The YOLO detector (`yolo11n-mosquito-det-640.onnx`, 10 MB) and an int8 H/14 build
(`bioclip_2_5_int8.onnx`, 608 MB) already exist locally under
`investigations/2026-10-03-rewrite/20-probe/pub/`.

Widening the bucket's CORS allowlist is the alternative, but it needs the Cloudflare
credential, which is opt-in per task.

## Tier structure

| tier | what | command |
|---|---|---|
| unit | pure functions, no browser | `npx vitest run` |
| tier1 e2e | the fast browser contract | `npx playwright test --project=tier1` |
| tier2 | slower, model-heavier | `npx playwright test --project=tier2` |

## Known reds that are not yours

**None at time of writing** — CI is green on `main` (`08f0ba7`: 259 unit tests, build
clean, tier-1 91 passed / 0 failed). Both entries that used to be here were fixed in
`08f0ba7`, and the reasons below are kept because they recur:

| test | what it was | why it was not a threshold problem |
|---|---|---|
| `reactivity.spec.ts:81` | asserted worst long task < 110 ms; got 143–256 ms | `worstLongTaskMs` is a **lifetime** max — the observer is installed at module load, so the number was dominated by ten 2400x1800 canvas encodes at boot, not by clicking. The observer is now scoped to the window the test names. **The 110 ms budget is unchanged.** |
| `empty-photo.spec.ts:89` | `toHaveCount(2)`, received 3 | `poolingPanel.ts` lists excluded photos as their own rows, which R4.10 requires, so 3 is correct. The assertion now checks the **property** (an excluded row with its reason, its weight shares, and a summary naming 3) rather than a bare count. |

`reactivity.spec.ts` **can still fail on a heavily loaded box** — it is a wall-clock
measurement, and shared runners are shared. If it goes red in a way that looks
unrelated to a change, check whether the runner was busy before treating it as a
regression. Tier 1 as a whole is flaky under load: it can fail a *different*
unrelated spec each run (`controls`, `shell`, `tile-states`, each passing 3/3 in
isolation), which was proven by running untouched upstream `main`.

Full reasoning: `docs/CI-TEST-SIGNAL.md`.

## CI

Two workflows run on every push to `main`:

- **`CI`** — red on every commit, for the reasons above.
- **`Deploy to GitHub Pages`** — green on every commit.

They are independent. **Red CI is not evidence that a change broke something**, and a
green CI would not currently be evidence that it didn't.