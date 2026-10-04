# 70 — Resize once, reuse: one full-resolution read per photograph removed

2026-10-04. Goal J follow-up, the `drawImage` half of `60-thumbnail-perf.md`.

## The short answer

One full-resolution read of every photograph is genuinely gone: **158.19 → 131.23 MP of source read per photo, −17.0%, identical in both rounds to the byte.**

**The time does not follow.** Across two matched pairs the effect on wall clock is −13.7% in one round and +109% in the other, i.e. the sign is decided by which arm happened to run on a loaded box and not by the code. At n=2 on a box running at load 12–21 on 14 cores, with a stray four-core process from another agent live through most of it, the wall-clock effect of this change is **not resolvable**. I am reporting that as the answer rather than as a number.

Against the established baseline, this **does not recover the `drawImage` regression**: the encoding fix took `toDataURL` from 11,685 → 154 ms (−98.7%) and paid for it with `drawImage` 6,707 → 12,260 ms (+83%). Resize-once-reuse removes one of the four full-resolution reads in the classify path — it does not touch the three that remain, which is where that 12.3 s lives.

## What changed

`classifyImage` read the decoded photograph at full resolution twice: once in `letterbox` (the detector's 640² input) and once in `clipEmbed(fullCv)` (the classifier's 224² whole-frame view). Both resample the whole 12–50 MP frame to something under 1 MP.

`letterbox` (`src/app/detector.ts`) now resamples the photograph into an unpadded `content` canvas at the detector's own scale (`dw` × `dh`), blits that 1:1 into the padded 640² input, and returns `content`. The blit is a copy at scale 1, so the detector's tensor is the same one it was. `clipEmbed(sourceCanvas, preScaled)` scales from `content` when `isUsableIntermediate` (`src/app/downscale.ts`) agrees the substitution is sound, and reads the photograph when it does not.

`isUsableIntermediate` refuses two cases: a different aspect ratio (a resize scales both axes by one factor, so a different shape would stretch the result), and an intermediate whose short edge is under 224 — the detector's intermediate is as small as it gets on a panorama, where an 8:1 frame lands with a 78 px short edge at 640, and scaling that *up* to 224 is a blur the direct path never took. All 30 corpus photographs pass the guard, so none fell back.

## Measurement

`bench/resample.mjs`, derived from `bench/thumb.mjs` with one addition: **source pixels per `drawImage`**. The existing bench attributes a draw its *destination* area, which is why a 50 MP → 252 px downscale reads as 0.1 MP in it — and that is why "megapixels resampled" barely moved while `drawImage` time nearly doubled in report 60.

Source area is taken from the call's own arguments: the nine-argument form names its source rectangle at indices 3 and 4; the three- and five-argument forms read the whole source element. **I got this wrong first.** The initial helper keyed on `a.length >= 5`, which reads the *destination* extents of a five-argument draw as source — so every thumbnail-chain step, the one place the app makes a five-argument `drawImage`, was counted at destination size. It undercounted the before-arm total by ~2% here (the thumbnail chain reads the crop canvas, which is small) and would undercount catastrophically on a corpus of no-detection photographs, where it reads the full frame. The numbers below are from the corrected helper; the two runs taken before the fix were discarded.

Alternating A/B, 2 matched rounds, arms run `before, after` within each round off two separate builds served from `bench/ab.sh`. Corpus: the hand-adjudicated 30 Pixel photographs, **827 MP total, 27.6 MP mean**. Denominator: 30 photographs, 20 classifications, every arm 30/30 settled, `detN` 30 and `clipN` 56 in all four runs.

### Deterministic — identical in both rounds, load-independent

| | before | after | |
|---|---|---|---|
| **source read per photo** | **158.19 MP** | **131.23 MP** | **−17.0%** |
| source read, whole batch | 4,746 MP | 3,937 MP | −809 MP |
| destination written, whole batch | 1,968 MP | 1,977 MP | +0.5% |
| `drawImage` calls | 373 | 403 | +30 |

809 MP over 30 photographs is **27.0 MP removed per photograph**, which is exactly one 27.6 MP read of the source. The +30 calls are the 1:1 blits. This is the whole claim, and it is not in dispute: the pixels are gone, not relocated.

### Timing — not resolvable at n=2

| | before | after | delta |
|---|---|---|---|
| wall clock (median of 2) | 141,870 ms | 122,445 ms | −13.7% |
| inference | 108,658 ms | 92,397 ms | −15.0% |
| non-inference | 33,212 ms | 30,049 ms | −9.5% |
| non-inference share | 23.6% | 25.7% | +2.1 pp |
| `drawImage` ms | 28,337 ms | 25,891 ms | −8.6% |
| long tasks ≥ 50 ms | 32 | 32 | — |

Per round, unmedians:

| | before | after |
|---|---|---|
| round 1 wall | 203,221 ms | 76,087 ms |
| round 1 `drawImage` ms | 39,825 ms | 17,779 ms |
| round 2 wall | 80,518 ms | 168,803 ms |
| round 2 `drawImage` ms | 16,848 ms | 34,002 ms |

Round 1 says the change is 2.7× faster; round 2 says it is 2.1× slower. The ~22 s swing in `drawImage` time is the same size in both rounds and opposite in sign. **That is contention, not signal.** Load average was 21.4 during the first before-arm and 11.0 later; a stray `probe.mjs` from a finished agent was pinning four cores with `taskset -c 10-13` through most of the session and was killed at 11:38 — so **round 1 (both arms) ran with it live and round 2 (both arms) partly without**, which spreads the noise across arms rather than confounding one of them, but does not remove it.

Two further reasons the timing column carries little even at larger n: the WASM-CPU path dominates this box (73–77% of wall is inference), and a headless Chromium without WebGPU is not the shipping configuration. Absolute milliseconds here do not transfer. The split between inference and image plumbing is identical code on both paths, but at 27.6 MP per photograph the plumbing is a smaller share of this box's time than of a phone's.

**Verdict: the source-bytes win is real and measured; the time win is inside the noise and I am not claiming it.** The three full-resolution reads that remain — the `bitmap → fullCv` copy, the letterbox's own read, and the crop's — are untouched by this change, and they are where the 12.3 s is.

## The adversarial review, answered

An independent agent was briefed on the diff and the requirement, not on my reasoning. Each finding, accepted or rejected.

**1. Is the work removed or moved? — accepted.** Confirmed from the code and from the bucket counts: 809 MP fewer read, 27.0 MP per photo, exactly one source read. The reviewer noted one case where the after arm reads *more* — when `isUsableIntermediate` refuses, the photograph is read as before and the change has added a 0.3 MP blit and a ~1.2 MB canvas allocation. Correct, small, and never taken on this corpus (30/30 accepted).

**2. Is the detector's input still bit-identical? — accepted as reasoning; not measured.** The geometry is right: same source rectangle, same `dw`/`dh`, same `Math.round(dx)`, same fill before the blit, and the only resampling kernel in either arm is the same single photo→`dw`×`dh` draw. The reviewer's concern that no browser applies a colour conversion or an unpremultiply to a 1:1 blit between two untagged sRGB canvases is right but untested. **This is the load-bearing unverified claim in the change** and I did not settle it: settling it needs a browser comparing `chwFromCanvas` output between the old and new builds over the corpus, which I did not run. Flagged, not resolved.

**3. Is the embedding still correct? — accepted, and this is the real risk.** The whole-frame view now comes from a two-step chain (27.6 MP → 0.31 MP → 0.05 MP) where before it was one step (27.6 MP → 0.05 MP). The geometry is scale-invariant and the centre crop lands on the same content. The reviewer's argument that this is not an aliasing regression is a good one and I agree with it: two box-filtered steps beat one 114× step, which is the same reasoning `canvasCache.ts` already documents. **But nothing here measured the prediction delta**, and the head and its cosine offsets were fitted against the one-step tensor. A photo's whole-frame posterior can now move by an amount nobody has bounded. That is the strongest reason to treat this as shipped-but-unproven rather than settled.

**4. Do the tests catch a broken resample? — accepted, and fixed.** The reviewer's sharpest finding. My fake recorded only whether ink propagated, so it could see a blank `content` but not a mis-scaled one: drawing the photograph into `content` at twice the size, or blitting at the wrong offset, left every assertion satisfied. The fake now records each draw's arguments and the tests assert the actual rectangles — `[0,0,4000,3000,0,0,640,480]` for the resample and `[0,0,640,480,0,80,640,480]` for the blit. That is what turns "the ink survived" into "the resample happened at the detector's scale and the blit was 1:1".

The reviewer also caught that loosening the `view-selection` regex to `clipEmbed\(fullCv[^)]*\)` stopped constraining the thing the change is about — deleting `, lb.content` restores the double read and the test still passes. **Accepted and tightened** to require the second argument.

**5. Does the bench measure source reads? — accepted, and fixed before the reported runs.** Same five-versus-nine-argument mistake, independently found. Also accepted and stated rather than left implicit: the figure excludes `toDataURL` (measured separately, 62 encodes and ~0.7 MP per photo — the full-resolution encodes are one per run for the selected photo, not per photo), `getImageData` (the 640² and 224² tensor reads, not resamples), and `createImageBitmap` (the JPEG decode, timed but not counted). There is no canvas→GPU upload in this path — the tensors are built by hand from `getImageData` and handed to `ort.Tensor` as `Float32Array`s — so nothing is missed there.

**6. "There is no time win." — accepted. That is the finding.**

**7. Two paths still do the old thing. — accepted, not fixed, and worth naming.** `executeCrop` and `revertToFullPhoto` go through `classifyViews`, which has no `lb` to be given, so after a manual re-crop the whole-frame view is computed the old way while the batch computes it the new way — and those two are pooled by `fuseViews`. Both are valid embeddings; they are just not the same one. Out of scope for this slice, and recorded here so the next person does not read it as an oversight.

Also accepted, out of scope, and the larger fish: `decodeStage` builds `slot.fullCanvas` from `slot.bitmap` and `classifyImage` then builds a *second* `fullCv` from the *same bitmap*. Passing one to the other would delete a 27.6 MP bitmap→canvas draw per photograph outright, with no image-quality consequence and no new geometry. **That is a bigger win than this change and it is the obvious next slice.**

## Reproducing

```sh
npm ci
npx vite build --outDir dist-before          # on origin/main
git switch -c fix/resample-once && npx vite build --outDir dist-after
cp /Users/cr/code/claude-devcontainer/tmp/mosquito-id/30picsload.zip dist-{before,after}/
./bench/ab.sh before 1 && ./bench/ab.sh after 1      # and round 2, alternating
python3 - <<'PY'
import json,statistics as st
for a in ("before","after"):
    ds=[json.load(open(f"/tmp/resample-{a}-{r}.json")) for r in (1,2)]
    print(a, st.median(d["drawSrcMPPerPhoto"] for d in ds),
             st.median(d["drawMs"] for d in ds), st.median(d["wall"] for d in ds))
PY
```

Do not read the timing columns off a loaded box. The `drawSrcMPPerPhoto` column is the one that means anything here, and it does not care.

## Tests

`tests/resample-reuse.test.ts` (10 tests) covers the guard's five accept/refuse cases and the two draws that decide whether the detector sees the photograph. `npm run test:all` and `actionlint .github/workflows/pages.yml` are green; full suite 484 passed.
