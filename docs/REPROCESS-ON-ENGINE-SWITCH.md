# Re-running the loaded photos after an engine switch

Switching the engine changes what the NEXT photo will be scored by and nothing
about the photos already loaded. Before this, their scores stayed the ones the
previous engine gave them while the footer named the new one, so a user who went
from H/14 to culico read H/14's verdicts under culico's name.

Re-running is minutes of inference and a lot of battery on the phone this is
mostly used on, so it is not a consequence of the switch. `#btn-reprocess`, beside
the ENGINE label in the header, is the action, and **its presence is the signal
that the scores on screen are stale**. Two states, both pinned in
`tests/reprocess.test.ts` and `e2e/tier1/reprocess.spec.ts`:

- nothing on screen was scored by a different engine — hidden;
- something was — visible, and it says how many photos and on which engine.

## Staleness is per photo, not a flag

Each photo carries `scoredBy`: the engine whose arithmetic produced the scores it
is currently showing. It is written where scores land, not where the engine is
chosen — `commitScores` (every view-fusion commit) and `classifyImage` /
`commitBatchSlot` (the batch) — so it records what produced the numbers.

A single "the engine has been switched" boolean cannot answer the question the
button actually asks, and gets two real cases wrong in opposite directions:

- a photo dropped **after** the switch was scored by the new engine and is not
  stale, so a mixed gallery re-runs only what the switch left behind;
- switching **back** to the engine that scored the photos makes them current
  again, so the button withdraws instead of offering to re-run work already done.

A photo with no `scoredBy` is not stale: it is queued, still decoding, or its
classification failed, so nothing on screen is claiming to be another engine's
verdict.

## What "as if dropped fresh" meant to wire up

`processFiles` IS the fresh-drop entry point, and the re-run originally was a
call to it and nothing else — every loaded photo back through detection as well
as classification, on the reasoning that a re-run should behave as if the photo
had just been dropped. That is the one decision here that has since been
reversed, and the rest of this section describes the wiring it produced.

**The button's job is scores, not detections.** What it exists for is that the
numbers on screen came from an engine other than the one now selected, so it is
"recompute these scores with the current engine" — not "re-detect the mosquito
in every photo I already have crops for". A photo that already carries a crop
box, whether the detector's or one the user drew, has everything the classifier
needs, so it is re-classified from that box and never reaches the detector. The
box is left exactly as it was, which is what makes a manual crop survive a
re-run; under the old behaviour the detector replaced it and there was no undo.
A photo with no box still takes `processFiles`, because getting a crop is what
makes a second view possible at all.

Two things follow from keeping those photos in the gallery rather than emptying
it, and both are load-bearing:

- **They are marked pending for the whole re-run**, not from when the classify
  pass reaches them. Their scores are the previous engine's until it lands, and
  `updatePooling` runs in between, so leaving them settled would pool two
  engines' verdicts — the mixed gallery this button exists to remove, and an
  invisible one, since a pending photo is simply out of the pool. Inclusion is
  by index and sticky, so they come back when the pass settles them. `scoredBy`
  is deliberately *not* cleared: a press that failed to reach a photo has to
  leave the button offering again rather than withdraw over stale scores.
- **A photo whose earlier classification failed is no longer stranded.** The
  runner skips photos with an `error` on a whole-frame toggle, because there is
  nothing there to re-fuse. It does not for a re-run's own photos: the user
  pressing the button after a failure is asking for that photo to be retried,
  and `due` is scoped to them.

A photo the user **reverted to the whole frame** is on the classify side too,
under its own `revertedToFull` flag. `revertToFullPhoto` nulls the box, which on
the box alone is indistinguishable from the detector having found nothing — and
would send the photo back to detection, silently taking back a decision the user
made. `manual_full_photo` does not separate them, because the batch sets it on
both.

Measured per photo, one engine run each: **detection ~408 ms, classification
~661 ms, crop cut ~1 ms**, and classification runs *twice* per photo when the
whole-frame view is on. So detection was ~24% of a re-run's inference and
classification ~76% — skipping it is worth having, and it is not where the app's
time goes.

The split itself is `splitForRerun` in `src/app/reprocess.ts`, a pure function
over two fields, so the rule is checkable without a browser or a model. The
already-cropped photos are re-classified through `reclassifyQueue`'s runner, the
same one the whole-frame toggle uses, scoped by `rerunPhotos`: that runner is
what holds the single inference slot, and a second scheduler beside it would put
two runs on one onnxruntime session — the page freeze it exists to prevent.

Three things about `processFiles` are not obvious from the name and cost the
wiring most of the thought:

**It takes `File` objects and it PREPENDS.** It cannot be handed the already
loaded photos, and it will not replace them. So for the photos that need
detection the re-run marks them removed — the same mark `deleteAllPhotos` makes,
and for the same reason: it makes any inference still in flight for a photo drop
its result instead of writing into a slot that has left `previews` — and then
calls `processFiles` with their own files. The already-cropped photos are kept in
the gallery and re-classified in place. Every loaded photo is re-run, not only the
stale ones: selecting a subset would leave a gallery half on each engine, which is
the mixed state the button exists to remove.

**It releases the slot's `File`.** `commitBatchSlot` used to do
`slot.file = undefined` alongside `slot.bitmap = undefined`. Only the bitmap goes
now, because a re-run re-drops the photo that needs detection and releasing the
File would make it re-encode the photo's own canvas — a second generation of
JPEG — instead of feeding the batch the bytes that were dropped. `sourceFileFor` in
`src/app/reprocess.ts` keeps the canvas fallback for a photo that never had a
File.

What retaining it costs is bounded but not zero, and not for every intake. It
applies only to the photos a re-run detects again; an already-cropped one never
asks for its bytes back, since it is re-classified from the canvas it holds. A
dropped or picked file is a reference to bytes the browser holds outside its
heap. A **zip entry**, a **clipboard paste** and a **sample fetch** each build
their File from an in-memory Blob, so a session that keeps those photos on screen
now also keeps their encoded bytes. That is bounded by what is already retained
— `fullCanvas` is an order of magnitude larger and was never released either —
but larger is not the same as bounded, and a 300-entry zip is the case where it
would show.

**The name has to carry an extension.** `processFiles` filters on
`/\.(jpe?g|png|webp|bmp)$/i` and drops a file without one in silence, so
`sourceFileFor` appends `.jpg` to a name that has no recognised extension rather
than letting a re-run silently lose the photo.

## The window where a click would run the wrong engine

Between choosing an engine and its weights landing, `sessClip` still holds the
PREVIOUS engine's session and `EMB` still holds its head. A re-run started in
that window would re-run the old classifier and stamp the new engine's name on
the result — the exact confusion this button exists to end.

The button is therefore `disabled` while `!window.modelsReady`, with the reason
in its tooltip, and stays visible: the scores are still stale while it is
loading. `loadWebGPUModels` clears `modelsReady` at its first line and sets it at
its end, so the button unblocks on its own. It is also disabled while a batch is
running, for the ordinary reason that a batch is writing into the gallery a
re-run would empty.

`updateReprocessButton()` is called from `renderThumbnails()`, beside
`updateStripActions()`: staleness changes wherever the photos do. The engine
change handler and `loadWebGPUModels` call it too, since neither renders the
strip.

## The selector is blocked for the length of a pass

A batch pins its engine per photo — `inferSlot` reads `currentEngine` once and
threads it through — so a switch landing mid-pass left the photos already scored
on the old engine and the ones behind them on the new one. Measured before this
was fixed: `scoredBy = ["webgpu-fp16", "webgpu-culico", "webgpu-culico"]`, with
nothing on the page saying so. The re-run button below is what removes that
state afterwards; it says nothing about it while it exists.

So the engine `<select>` is `disabled` for the whole pass, with the reason in its
`title` and its accessible name — the same rule and the same shape as the
button's `REPROCESS_BLOCKED_BATCH`. Deferring the switch to the end of the pass
instead would need a queue for it and a way to show a choice that has not taken
effect yet, and neither is a state this app has anywhere else.

The `change` handler is guarded as well as the control, because `disabled` is a
statement about the `<select>` and not about the batch: a `change` dispatched
from anywhere else would still reach it. The handler puts the value back and
logs `engine_switch_blocked`, so the dropdown never names an engine that is not
the one scoring. `e2e/tier1/engine-switch-mid-batch.spec.ts` covers both halves.

`docs/THUMBNAIL-STRIP-SPEC.md` R4.4 keeps the strip's delete button live
mid-inference, and it is the one control here that stays live: mid-batch
deletion is safe because `commitBatchSlot` guards on the photo's revision and
identity. Switching engines is not the same kind of action — it changes what
every later photo is scored by — so it is blocked rather than left to land
wherever it lands.

## Where the engine is pinned

Four places read `currentEngine` during a computation, and all four now read it
once at the start and thread it through:

- `classifyImage` — every `cosineOffsetsFor` in the body.
- `inferSlot` — which branch the photo takes, and the `scoredBy` it commits.
- `classifyViews` — a two-view pass spans several frames, so a switch between the
  crop's view and the whole frame's would fuse two engines: a verdict from
  neither, stamped with whichever engine the pass ended on.
- `commitScores` — defaults to the live engine, so a caller that has not pinned
  one cannot forget to say which engine it meant.

## Two things that are not about this button

**The engine `<select>` change listener now catches a failed load.** It is
`async`, so a rejected `loadWebGPUModels` was an unhandled rejection with nothing
on the page, and `modelsReady` stuck false with the dropdown naming an engine that
could not load. It now reports through the progress slot, the way a failed initial
load already did.

**`__mosqAsync.clipSessions` is exposed.** Tier 1 cannot download a model, so a
switch there never completes and nothing downstream of it can be exercised.
Writing an entry makes `loadWebGPUModels` take its already-loaded branch, so the
switch rebinds the head, the session and the footer through the shipped code with
no fetch.
