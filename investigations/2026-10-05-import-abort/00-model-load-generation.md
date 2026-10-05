# The model load is a generation-counter problem, and the counter is the whole fix

Branch `fix/import-abort`, for issue #70. Companion finding for #61 and for the
idle-release work, all three of which are the same shape.

## The shape

A long async pass over app state that publishes by assignment after several
awaits, and the world can change under it while it is in flight. The repo already
has the idiom for this in three places, and a fourth place now follows it:

| where | counter | guards |
|---|---|---|
| `photoRecord.ts` | `p.rev` | one photo's crop/revert recompute |
| `progress.ts` | `loadGeneration` | a superseded load's byte reporter |
| `idleRelease.ts` | `generation` | a slow release landing after a restore |
| `main.js` `loadWebGPUModels` | `modelLoadGeneration` | a superseded load publishing a session |

`progress.ts`'s counter is the near miss worth knowing about: it already stopped
the abandoned load's byte reporter driving the new load's bar, and the comment
says why ("an engine switch re-enters `loadWebGPUModels` without cancelling the
previous fetch"). It protected the *bar* and nothing else — the same load still
assigned `sessClip` and `EMB`. Same counter, two fewer guards.

## onnxruntime-web 1.30.0 has no cancellation at all

Read out of the pinned typings, not guessed. The app loads the runtime from a
CDN (`index.html`, `onnxruntime-web@1.30.0/dist/ort.all.min.js`), so it is **not
in `node_modules`** — grep there finds nothing and looks like the feature is
missing. Fetch the typings instead:

    curl -sSLO https://cdn.jsdelivr.net/npm/onnxruntime-common@1.30.0/dist/esm/inference-session.d.ts

What is there:

- `InferenceSession.create(buffer, options?)` — `options` is `SessionOptions`,
  which has ~40 fields and **no `signal`**.
- `run(feeds, fetches?, options?)` — `options` is `RunOptions`, which has
  `logSeverityLevel`, `logVerbosityLevel`, `terminate`, `tag`, and an
  `extra` bag. **No `signal`.** `terminate` is documented as WebAssembly-backend
  only and terminates *all* incomplete runs, not one.
- `grep -i "abort\|signal\|cancel"` over both files returns nothing.

So an inference or a session creation cannot be stopped. `AbortController` is
available for `fetch` and `createImageBitmap` and nothing else on this path.

**Therefore:** a counter is the fix and an abort is an optimisation. An
`AbortController` that nothing downstream observes is decoration — cancelling the
fetch stops the transfer and leaves the (uncancellable) `create` free to publish
over the engine the user selected. The counter is what prevents the write.

## What each is for

- **Counter** — correctness. Claims the generation at entry; every publish site
  checks `superseded()` and returns without touching app state. This is the
  thing that stops the losing load winning.
- **Abort** — cost. An `AbortSignal` threaded through `fetchWithCache` into
  `fetch` so switching away mid-download stops a 1.2 GB transfer for an engine
  nobody is waiting for. On its own it is worth having; it is not the fix.

Both bump the same `modelLoadGeneration`, so either alone is sufficient — checked
by removing each in turn and the test still passes, and removing both fails it.

## The publish sites that need a guard

Every one of these is an assignment the losing load used to make:

- `sessDet` / `detEP` — the detector, built into locals first so a superseded load
  cannot leave a session no load claims to have set up. Released, not cached: it
  is not per-engine, so caching it would pin memory for a tab nobody asked for.
- `clipSessions[engineKey]` / `sessClip` / `clipEP` — cached *before* the check.
  A switch back is exactly what a user who changed their mind does next, and
  re-running `create` on 1.2 GB to rediscover the session is the expensive part.
- `loadedClipEngine`, `EMB`, `setActiveHead`, the footer, `clearProgress`,
  `window.modelsReady = true`, `drainQueuedBatches`.

## The trap worth naming

An aborted fetch **rejects**. The switch handler's `catch` therefore has to tell
an abandoned load from a failed one, or a switch overtaken by the next switch
paints an error for an engine the reader has already left and blocks the re-run
button for the engine that is actually loading. `err.name === "AbortError"` —
named rather than `instanceof DOMException`, since a page can be reached where
that constructor is not the one the request threw.

## Making the defect observable in tier 1

Tier 1 aborts every model request, so a real load cannot be raced — the two
switches just both fail. What works:

- **Seed `A.clipSessions[engine]`** with a fake session, so `loadWebGPUModels`
  takes its already-loaded branch and no download happens. The seam is
  `window.__mosqAsync`.
- **Park the load on the head JSON** with a delayed `page.route`. `stubModel`
  aborts `*.onnx` and `*.r2.dev/**` but deliberately **not** `text_embeds*.json`,
  so the head is reachable — and it is the last await in a load, which is
  exactly the window the defect lives in.
- **Assert on `EMB.dim`, not `loadedClipEngine`.** The two shipped heads differ
  in width (fp16 1024, culico 1153), which makes a stale publish a number. And
  `loadedClipEngine` is assigned *before* the head, so waiting on it races.
  Tag each fake session with its engine key to assert on `sessClip` too.

Two earlier attempts passed against main and were therefore testing nothing:
waiting on `loadedClipEngine` (raced, and null on a failed tier-1 boot), and
waiting on `EMB` before it was ever set (null deref).

## Open

`#61` — delete during a re-run — was not investigated here; scope was cut. It is
the same shape: the strip's delete is live throughout a pass, `deletePhoto`
splices, and the pass's `due()` snapshot and the runner's per-photo `rev` are the
machinery already in place to notice. Untested by me.
