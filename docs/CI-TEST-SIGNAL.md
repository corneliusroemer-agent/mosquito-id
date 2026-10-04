# Keeping the CI signal worth reading

`ci.yml` runs four things before the tier-1 browser suite: `actionlint` over every
workflow, `tsc --noEmit`, `vitest run`, and `vite build`. The browser suite is the
slowest leg and the noisiest, so it is worth being explicit about what each of its
assertions is for.

A red tick on `CI` means nothing on its own. It is only signal when it means one
thing, and a check that goes red for a reason nobody can act on trains people to
read the whole run as unreliable. Two checks earned that by accident; both are
fixed here.

## A long-task assertion must measure the window it names

`reactivity.spec.ts`'s "selecting a photo re-renders without a long blocking task"
bounds a click at 110 ms. It reads `A.worstLongTaskMs`, which is the running
maximum over **every long task the page has ever had** — the `PerformanceObserver`
is installed at module load, and the test reads the counter after `boot()` and
`populate()` have run.

So the number it compared against 110 ms was dominated by work that had nothing to
do with clicking: populating ten photos encodes ten 2400x1800 canvases to data
URLs, and each photo's first encode is the expensive one. That cost belongs to
`canvasUrl`'s cache missing, not to the click path, but it was being reported as
the click path's worst task.

Measured on the served build, with the observer scoped to each window:

| | elapsed (10 selections) | long tasks | worst |
| --- | --- | --- | --- |
| first pass over the ten photos | ~630 ms | 6 | 127–256 ms |
| second pass | ~200 ms | **0** | **0 ms** |
| third pass | ~190 ms | **0** | **0 ms** |

The second and third passes cost the same ~200 ms and register no long task at
all, because every frame is already encoded. The 234 ms and 256 ms CI reported
are first-pass numbers, reproduced exactly on a loaded box.

The fix is to make the loop select a photo it has already looked at, and to reset
the counter rather than subtract from it — so the bound cannot be met by a cheap
first pass followed by an expensive second one. That is the interaction a user
has when clicking back and forth between photos, and it is what the test's name
claims.

**The threshold did not move.** 110 ms is still the budget, and the fix removes
the reason it was sitting on the runner's noise floor rather than relaxing it.

### The check still catches the regression

A bound that nothing can trip is worse than a red build, so this one was verified
against the bug it exists for. With `canvasUrl`'s memo disabled in
`src/app/canvasCache.ts` (always re-encode instead of memoising):

```
worst long task on RE-selection was 335ms over 9 long tasks
```

Against 0 ms with the cache in place — a factor of ~100 either side of the
threshold, not a marginal pass. Restore the memo and it passes. The two tests
below it assert the cache is what makes the render cheap, and `npm run test:render`
bounds it numerically at 8 ms, so the first-pass cost is covered; it does not need
to be double-counted as the click path's cost.

## A row count is not an assertion

`empty-photo.spec.ts`'s "a photo with no mosquito cannot be opted into the pool"
asserted `#contribution-table tbody tr` had **2** rows for 3 photos. It went red
when `poolingPanel.ts` started listing checked-but-excluded photos as their own
rows — intended behaviour, and required by R4.10 in
`docs/THUMBNAIL-STRIP-SPEC.md`: a checked photo that silently contributes nothing
reads as an app bug rather than as a decision the card already reports.

The test predated that change and was never updated. The number was the whole
assertion, so nothing in it said *which* rows were required to be there, and it
could not survive a change to what the table lists.

It now asserts the property, not the count: three rows, the third carrying
`row-excluded` and the reason, the two mosquitoes' shares equal, the wall's a
dash, and `#inclusion-summary` naming the checked count. A future change to what
the table lists now fails here on the property rather than passing by coincidence.

## Flakes that are neither

On a box at load 40+ on 14 cores, tier 1 also produced failures in
`controls.spec.ts` ("the engine selector honours a `?engine=` query param") and
`shell.spec.ts` ("photos dropped before the model is ready are queued"), and
`shell.spec.ts` failed on a *different* test on unmodified `ab8e6b4`. These are
load-sensitive and unrelated to the two above; CI runs 2 workers on an idle
runner, where the suite is green. Worth knowing that a red tier-1 run on a busy
box is not by itself evidence of a defect.

`npm run test:render` is not part of `ci.yml` and reads ~8.9 ms against its own
8 ms budget on a loaded box; it is a local probe, and it is meant to be weighted
(`taskset -c 8-13 nice -n 10`) rather than run on whatever else the machine is
doing.
