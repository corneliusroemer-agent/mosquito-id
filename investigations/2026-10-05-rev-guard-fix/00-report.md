# The batch rev-guard, and the window it did not close

`rev` is one counter per photo. `beginRecompute` (`src/app/photoRecord.ts`) bumps
it, a computation holds the number it was started with, and `ownsRecompute` lets
that computation write only while the photo still carries it. Strict monotonicity
is the whole protocol: last release wins, and an earlier one still in flight finds
its number gone and drops its result.

Two writers of `rev` are legitimate (`beginRecompute` on a crop release, on a
revert-to-full, and on a whole-frame toggle) plus one that was not. A batch
result payload carried `rev: 0`, and `commitBatchSlot` copied it onto a record
that already had a revision. That is the root cause of both halves of this bug.

## The window before `inferSlot` starts

`processFiles` builds every placeholder for the batch up front and prepends them
to `previews` with `rev: 0`, then runs `decodeStage` concurrently with a serial
inference loop. Inference is serial because onnxruntime-web holds the main thread
for the length of a run, so photo *i*'s `inferSlot` runs only after photos
0..*i*-1 have been classified.

A placeholder becomes fully draggable as soon as **its own decode** lands:
`decodeStage` records `fullW`/`fullH` and paints `displayCanvas` per photo, and
nothing anywhere checks `isProcessingBatch` at the crop surface — not
`pointer-events`, not a disabled state, at any of the six sites. So for the whole
duration of the batch, every already-decoded photo is live and grabbable,
including the ones queued behind the current one.

PR #111 closed the window a crop opens *during* inference by capturing the
revision before `inferSlot`'s first `await`. It could not close the window *before*
`inferSlot` runs, because a capture taken at `inferSlot`'s first line is already
inside it. When the capture reads `slot.rev` and the photo was cropped while the
batch was still working through earlier photos, the capture reads the crop's own
revision:

    cropRev:  1     beginRecompute, from the placeholder's 0
    startRev: 1     inferSlot's capture, reading slot.rev
    slot.rev AFTER: 0   Object.assign wrote the payload's rev: 0 back

`startRev === slot.rev`, so the guard compares the photo against itself and cannot
fire. `Object.assign` puts the detector's crop box, its canvases and its scores
over the crop the user drew. The crop's own classification then fails
`ownsRecompute` and is discarded, and the crop silently reverts to the detector's
box — the exact failure #111 set out to fix, one step earlier in the timeline.

## The second consequence: reissued revisions

`beginRecompute` allocates from the current value (`p.rev = (p.rev || 0) + 1`).
A writer that moves the counter backwards therefore does not merely lose one
revision, it hands the same number out twice:

    crop A   beginRecompute -> 1        A's inference is in flight
    batch    commits, writes rev: 0     counter is now BEHIND A
    crop B   beginRecompute -> 1        the number A already holds
    crop A   returns, ownsRecompute(p, ..., 1) is TRUE
             -> stale scores land over the newer crop

Every consumer of `rev` assumes strict monotonicity and none of them defends
against reuse, so a reissued number is indistinguishable from a current one. This
is the more dangerous half: the first half loses the user's crop, this one puts
wrong scores on screen and reports the photo as settled.

## What the code does now

`rev` has exactly one writer. A batch result is a set of findings to apply, not a
claim on the counter, so `commitBatchSlot` destructures `rev` off the payload
before `Object.assign`. That removes the rewind, and with it the reissue — both
findings have one cause and this closes both.

The pre-inference window needs a baseline that nothing in between can move. A
placeholder now carries `batchRev`, the revision the batch claimed it at, stamped
where the slot is created; `inferSlot` captures that. A capture of a value fixed
at queue time covers every window, including ones not yet thought of, because
there is no interval during which it can become stale.

The tempting alternative is to gate the crop surface while `isProcessingBatch` is
set. That closes the window by removing the user's ability to crop at all, which
is the wrong trade: R4.4 of the strip spec requires delete to stay live
mid-inference because a photo must always be removable, and a photo you can
remove but not crop is strictly worse than one where the crop wins the race. The
guard is also the cheaper place to be correct — one comparison against a number
that cannot lie, versus a UI gate that has to be re-established at every crop
entry point, including ones added later.

## The test, and what makes it fail

`tests/batch-slot-rev-race.test.ts` drives the real guard: it reads
`commitBatchSlot`'s body out of `main.js` and compiles it with `previews` and
`sendLog` supplied, and reads `inferSlot`'s capture expression out of `main.js`
and evaluates it at the point in the timeline the test needs it read. Both are
evaluated rather than reimplemented because the guard and the capture *are* the
thing under test — a copy would pass whether or not `main.js` still has one. The
two races differ only in *when* the capture expression runs relative to
`beginRecompute`, which is precisely what distinguishes the two windows.

The mutation that makes the new tests fail: in `src/app/main.js`,
`inferSlot`'s `const startRev = slot.batchRev;` back to `const startRev =
slot.rev;`. That single expression is what the pre-inference window turns on. The
`rev` half has its own mutation — dropping the `const { rev: _claimed, ...fields }
= res;` line in `commitBatchSlot` — which is what makes the two tests in "the
revision a batch result carries" fail. Both were verified RED against reverted
source and green against the fix.

## Remaining hazards

- Any future writer of `rev` other than `beginRecompute` reintroduces the reissue.
  The type does not prevent it (`rev: number` is writable), and nothing asserts
  single-writer. A `readonly` rev with a bump function would make it a compile
  error instead of a silent one.
- `processFiles` remains reachable while a reclassify pass is in flight. The
  `ownsRecompute` `previews[idx] === p` term is what covers that today; the same
  single-writer reasoning applies to anything else that rewrites a record field a
  guard depends on.
