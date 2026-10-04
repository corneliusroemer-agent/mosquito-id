# The whole-frame view is optional, and what turning it off costs

## The setting

A cropped photo is classified twice — once on the detector's crop, once on the
whole frame — and the two are pooled log-linearly. That fusion is the largest
measured accuracy win in this app (+4.5 points of top-1 on the 112-image
Mosquito Alert benchmark, 84.8% → 89.3%). It was unconditional.

It is now a checkbox, `#chk-whole-frame`, in the gallery header row beside the
bulk actions, on by default and persisted under `mosquito_include_whole_frame`.
Unchecked, a cropped photo is judged on its crop alone. A photo with no crop is
judged on its whole frame either way, because the whole frame there is not an
addition to a crop, it is what there is.

The decision itself is `viewKinds(hasCrop, includeWholeFrame)` in
`src/app/viewSelection.ts`, and it returns a non-empty list in all four states.
All three places a photo gets classified ask it — the local batch path
(`classifyImage`), the server batch path, and the crop-release path
(`viewsFor` → `classifyViews`) — so a cropped photo cannot be judged on one view
by one path and two by another.

Two consequences of the setting are worth stating because they are easy to
assume the other way:

- **An excluded whole frame is not scored at all.** The crop-only path skips the
  whole frame's inference rather than computing it and leaving it out of the sum.
  Half the model cost per cropped photo, plus the R2 transfer on a cold cache.
- **Changing the setting re-classifies the photos already on screen.** A photo's
  verdict describes the views it was fused from, so a two-view verdict left
  standing under a one-view setting is precisely the disagreement between a
  photo's own verdict and the pooled card. Each affected photo is marked
  `pending` while its views re-run, the same treatment a crop release gets, so
  nothing is read as settled on a pool that is about to change. Photos that were
  never classified, or whose classification failed, are left alone.

## What it costs, measured

`analysis/whole_frame_ablation.py` runs both states on the only labelled
two-view cache there is: the 07-benchmark's 180 rows, each embedded by the
shipped BioCLIP-2.5 ViT-H/14 with the app's own 16-species + 8-nuisance head and
its own `logit_scale`, through `fuseViews`'s own arithmetic and the app's own
floor rule (species 0.373, genus 0.80).

```
                              genus acc   answered   abstained   acc|answered
whole frame ON  (2 views)        80.4%       89.9%       10.1%         85.7%
whole frame OFF (crop only)      76.0%       65.4%       34.6%         90.6%
```

45 of 180 rows answer on two views and abstain on one. **None goes the other
way** — no photo that abstains on the pair answers on the crop alone. The genus
named changes on 32 rows, of which 7 are answered in both states.

So turning the whole frame off does not make the app more willing to guess. It
makes it markedly more conservative, and more accurate on what it still says:
accuracy *of the answers given* rises by nearly five points while the answer rate
falls by a quarter. The same shape holds on the unrestricted 180 rows
(10.0% → 34.6% abstained, 85.8% → 90.6% accurate) and on the 179 of 180 rows
whose crop passes the nuisance gate and would therefore actually be classified
this way.

The intuition that a crop with nothing to fall back on names itself confidently is
**not** what happens here, and the reason is in the arithmetic rather than in the
data: the whole frame is a much harder view. It carries the whole photograph's
background, so its own posterior is flatter and it contributes less to the sum
than its nominal equal weight suggests — while still dragging the fused posterior
toward a broad, thinly-supported distribution. Removing it leaves the sharper
view, which is the one that was actually looking at the mosquito.

## What is not measured

**The false-positive side is not measured, and cannot be with what exists.** Every
one of the 180 rows is a photograph of a mosquito. So nothing here says how often
a crop-only photo names a species where the crop-and-frame pair would have
refused it, which is the `non-mosquito` half of the question. The nuisance mass
columns below show why that half is the open one:

```
nuisance mass over the 180 rows
  whole frame      median 3.9e-06   p99 1.5e-02   max 0.033
  crop view only   median 7.6e-06   p99 1.3e-01   max 0.553
  fused (as shipped, species + nuisance renormed together)
                   median 3.6e-04   p99 9.8e-01   max 1.000
```

The crop's nuisance tail is roughly an order of magnitude fatter than the whole
frame's (p99 0.126 against 0.015, max 0.553 against 0.033). A photo of a wall
would plausibly be *more* refused with the whole frame off, since the frame
dilutes the crop's nuisance evidence; a photo of a mosquito with a bad crop is
more likely to be refused too, which is the 34.6% abstention above. Which of the
two dominates cannot be read off positives alone — the same gap
`investigations/2026-10-02-mosquito-id/35-view-disagreement.md` reports for the
nuisance floor.

Closing it needs a labelled negative set with **both** views embedded, which does
not exist. That is a data-collection task, not a threshold sweep, and the number
would have to come from that set rather than from here.

## Reproducing

```sh
uv run --with numpy python3 analysis/whole_frame_ablation.py
```

Reads existing caches; produces no embedding and needs no model.