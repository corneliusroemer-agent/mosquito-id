# Testing this app

## The one thing that surprises everyone

**`reuseExistingServer: true` lets the suite pass against someone else's build.** Playwright
then skips the launch entirely and just probes the `webServer` URL. If another agent's preview
server is on that port, the probe succeeds, the tests run green, and they have tested a `dist/`
this working tree never built — with nothing in the output to say so.

This repo is not exposed to it: `playwright.config.ts` sets `reuseExistingServer: false`
unconditionally and passes `--strictPort` to `vite preview`. Both are load-bearing. See
`BUILD-VERIFICATION.md` for the incident that motivated them.

Playwright itself reports failures correctly. Measured on 1.63.0 against this repo's own config,
every one of these exits **1**, not 0:

| situation | what it prints |
|---|---|
| port occupied by a server answering HTTP | `Error: http://127.0.0.1:4173 is already used...` |
| port occupied by a dead listener | `Error: Process from config.webServer was not able to start. Exit code: 1` |
| `webServer` command exits before the URL is reachable | `Error: Process from config.webServer exited early.` |
| no tests match the selection | `Error: No tests found` |

The third row is worth knowing: a `webServer` that exits **0** before becoming ready is still an
error. Playwright does not consult the child's exit code, it checks whether the URL came up.

So a gate on the exit code is sound here. Two things still break it, both outside Playwright:

- **`--pass-with-no-tests`** turns an empty selection into exit 0, printing nothing at all. Do
  not pass it in a gate.
- **A shell wrapper.** The same failing run returns `$?` 1 bare, but **0** under `|| true`, under
  a pipeline without `set -o pipefail`, or when a later command in a compound sets the status. The
  error text still scrolls past while `$?` says 0.

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

## Gating the browser suite

Four things, all already true of this repo's config — recorded so a future change does not
quietly undo one of them:

1. **`reuseExistingServer` off.** Otherwise a stale `dist/` from another agent's clone can answer
   the probe and the suite tests that instead of yours.
2. **`vite preview --strictPort`.** Without it vite silently shifts to the next free port, so the
   configured URL is not what is actually serving.
3. **No wrapper that masks the exit code** — no `|| true`, no pipeline without `set -o pipefail`,
   no trailing command in a compound that resets `$?`.
4. **No `--pass-with-no-tests`.** It makes an empty selection exit 0.

As an extra safeguard, assert that the JSON or JUnit report contains at least one **executed**
test, rather than trusting the exit status alone.

## CI

Two workflows run on every push to `main`: **`CI`** (actionlint, `tsc --noEmit`, vitest,
`vite build`, then the tier-1 browser suite) and **`Deploy to GitHub Pages`**. Both are
expected to be **green on every commit**. A red CI means something is wrong and it gets
fixed — it is never accepted as background noise.

**The convention when CI is red and it is not your change:**

1. **File an issue** with the failing job, the test name, the assertion, and what you
   verified (does it reproduce on a clean `origin/main`? does it fail in isolation?).
2. **Flag it to the coordinator immediately** rather than at the end of a run — do not sit
   on it, and do not treat it as a known condition.
3. Do **not** merge into a red `main`, and do **not** relax an assertion to get green. A
   green tick bought by widening a budget or deleting a check is worse than a red run,
   because it removes the signal.

A wall-clock threshold on shared hardware is a **test-design** problem, not an excuse.
The previous one was fixed by fixing the measurement (`docs/CI-TEST-SIGNAL.md`), not by
moving the number.

If the suite is genuinely flaky under load, the answer is to make the assertion robust —
scope the measurement to the window it claims, or compare against a baseline measured in
the same run — not to accept intermittent red.
