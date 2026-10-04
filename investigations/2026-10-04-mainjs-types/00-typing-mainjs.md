# 65 — Typing main.js by extraction

Issue #34. `src/app/main.js` was 2,849 lines, larger than every TypeScript module
in the project combined, and neither `allowJs` nor `checkJs` was set, so none of
it was type-checked. It is the file every agent edits, and it is where this
project's two worst bugs lived.

## Where it stands

| | lines | type-checked |
|---|---|---|
| `src/**/*.ts` | 5,852 | yes |
| `src/app/main.js` | 2,676 | **no** |
| extracted this session | 630 (`photoRecord.ts` 221, `views.ts` 253, `embedding.ts` 156) | yes |

`checkJs` on the remaining `main.js` alone reports **405 errors** — down from
415 before this work, which is the whole of the improvement available from
checking rather than extracting. 405 is not a task, and typing the state as it
stands measured 447, worse than leaving it alone. Extraction is the plan, and
three slices of it are landed.

`tsconfig.README.md` in the repo states the boundary, with these numbers, so the
next person does not assume `main.js` is covered.

## The three slices, and the bug each would have caught

Slices were ordered by blast radius, not size. Each is one green commit pushed
to `main` as it landed, each merged against a fresh `origin/main` first.

### 1. `photoRecord.ts` — the photo record and the rev guard

`beginRecompute`, `ownsRecompute`, `commitScores`, `markComputeFailed`,
`Superseded`, and `PhotoState`: the shape of one photo in the gallery.

**Bug it would have caught: 6647d05.** `pooledVerdict` was called with `adP` and
not `nuP`, so the pooled card read the adjacent block and never the nuisance one.
Fixing it meant adding `nuP: fused.nuP` at every photo site in `main.js` — three
sites — and nothing connected them. One site updated and one not is not a type
error; it is a photo set whose pooled verdict silently reads no nuisance
evidence. With `PhotoState` as one record written through `commitScores`, that
divergence is a property of a type rather than of what six call sites remember.

### 2. `views.ts` — the path around `fuseViews`

`viewsFor`, `viewResultFrom`, `classifyViewLocal`, `classifyViewServer`,
`serverView`, `classifyCanvasServer`, and the three log-summary helpers.

**Bug it would have caught: the `fuseViews` nuisance collapse.** `fuseViews`
collapsed a nuisance vector to a single index, so every non-mosquito verdict read
"a photograph of a person", and `verdictFrom` consumed that collapsed value. Both
modules were already TypeScript by the time those were found. What was **not**
typed was the code that *built* what they were handed: nothing required a view to
carry `scale` (the field `fuseViews` refuses to pool across), or a `spP` of the
head's width. Both constructors now return `ViewResult`, so a view missing either
is a compile error at the construction site.

Dependencies are injected (head, embed, scale, logger), so the whole path is
checkable without the 1.26 GB classifier and without a browser.

### 3. `embedding.ts` — canvas to embedding

`clipTensor`, `pickEmbedding`, `l2NormaliseFeatures`, `embedCanvas`.

**Bug it would have caught: 91029e3.** A model's outputs were read *positionally*.
culico's graph declares `1747` and `culico_embedding`; `Object.keys()` sorts the
integer-like key first whatever order the graph declares them in, so an 18-element
probe-logit vector reached a softmax whose rows are 1153 wide. Every product past
index 17 became `undefined * number` = NaN, and `verdictFrom`'s non-finite guard
returned "not confident" for **every** photo. Nothing threw: the app was working
perfectly on a number that meant nothing. `pickEmbedding` selects by width, then
by name, and throws naming what it saw when neither matches.

The same slice pins the second end: L2-normalising the *whole* vector divided the
probe's appended constant `1.0` by the feature norm, shrinking it ~40x and
discarding most of the bias. `l2NormaliseFeatures` stops at `head.dim`.

## What is still JavaScript, and why

| region | why it needs a restructure, not a move |
|---|---|
| `processFiles` (the batch loop) | reads and writes ~30 fields of the photo record in one function; extracting means passing the record and five render callbacks |
| `renderThumbnails` / `renderActivePhoto` / `buildTile` | DOM node caches keyed by photo slot; typed they need `Map<PhotoState, HTMLElement>` and a decision about slot replacement |
| `setupCropSurfaces` and the pointer handlers | the same, plus module-level drag state |
| `loadWebGPUModels` / `initEngine` | the order of module-state rebinding *is* the correctness, not the types |

That is the change of tack to flag: the next slices are no longer mechanical
moves. **The first three were all pure functions of injected inputs. Everything
left in `main.js` is DOM or module-state**, so continuing means deciding what a
photo record's identity is (for the node caches) and what a session's lifecycle
is (for the model load). That is a design decision and it is yours, not mine to
take silently.

## Two things found and filed rather than fixed

- **`commitScores` does not write `nuP`.** It never has. So the pooled card's
  non-mosquito gate reads no nuisance evidence at HEAD. Adding it is a behaviour
  change, not an extraction, so it is filed.
  `tests/photo-record.test.ts` pins the absence as a *fact about shipped
  behaviour*: the test says `expect(p.nuP).toBeUndefined()`, so adding the field
  later fails the suite until someone does it deliberately.
- **`pickEmbedding`'s name fallback matches `embedding`/`embed` and nothing else.**
  A graph naming its output `features` is not matched. Harmless today — every
  registered engine loads a head before the first inference, so the width check is
  the one that runs — and it throws rather than guessing without a head. Found by
  writing the tests. Recorded in the module.

## Gate

Every commit green, no assertion relaxed and nothing suppressed:

```
npx tsc --noEmit          clean
npx vitest run            493 tests, 31 files (404 at session start, +89)
npm run build             clean
tier1 e2e                 107 passed
actionlint pages.yml      clean
```

No `as any`, no `@ts-ignore`, no skipped test. `tests/photo-record.test.ts:29`
pins a *narrower* behaviour than before in one place, deliberately, and says so.

## A test that had to be retargeted rather than relaxed

`tests/view-selection.test.ts` read `main.js` **as text** to assert `viewsFor`
routes through `viewKinds`. `viewsFor` moved to `views.ts`, so that scan now
reads the module — and a second assertion was added that `main.js`'s adapter
still delegates to it. Reading a stale copy out of `main.js` is how a wiring
check passes against deleted code, which is the failure mode a text-based check
has and a compiler does not.

Verified the new assertion bites: replacing the delegate with a literal
`[{canvas: p.fullCanvas, box: null}]` fails it.

## What the boundary costs, measured

This session's own mistake is the evidence. Extracting `classifyCanvasServer` and
adding an adapter of the same name produced a duplicate declaration that **`tsc`
passed** and `vite build` caught. The build half of `npm run build` is currently
doing work `tsc` cannot, and that is what the remaining 2,676 lines cost.

## Timing

Session 08:28–09:35 CEST, ~67 minutes. `time` on each gate leg; the three
slice gates were ~2, ~4 and ~4 minutes, most of it the e2e run.
