# Fused logits were on a ~100x-too-large scale; "Complex Score" replaced by genus

Branch `agent/fused-logits` (commit `f7a6e62`), base `main` @ `19d2b74`, repo
`10-github-pages/site/`. Two changes, both in `main.js` (plus two table headers in
`index.html`).

## Bug 1 — fused logits multiplied a log-probability by the logit scale

`fuseViews` recovered the fused cosine correctly and then did not use it:

```js
const lp = spP.map((p) => Math.log(Math.max(p, 1e-12)));
const best = Math.max(...lp);
const spCos = lp.map((l) => (l - best) / scale);   // cos_i - cos_best, recovered
...
logits[n] = lp[i] * scale;                         // <-- log-prob x scale, ~100x
```

`log p_i = scale*cos_i - logZ`, so `(log p_i - log p_best)/scale = cos_i - cos_best`.
`lp[i] * scale` is not that quantity; it is `scale` times a log-probability, which for
this model (`logit_scale` 98.86, temperature 2.5, so `scale` = 39.55) runs to −600 on a
photo the axis draws as −20..0. The fix makes line 956 read `logits[n] = scale * spCos[i]`,
the same expression the un-fused path uses at main.js:831.

Ranking survived the bug because the wrong transform is a positive rescale plus a
constant, which preserves argmax. What it broke is every comparison that is not within
one photo set: the pooling card's axis, and pooling across different photo sets.

### Verification

`scale * spCos[i] + shift === unfusedLogit[i]` for a single-view fusion, over 200
synthetic view draws at the model's own `logit_scale`:

```
logit_scale=98.8644790649414  TEMPERATURE=2.5  scale=39.546   species=16
[1] single-view: max |scale*spCos + shift - unfusedLogit| = 2.665e-15
[1] recovered spCos vs true spCos: max deviation from a constant = 1.110e-16
```

i.e. exact to floating-point. The recovered cosines differ from the view's real ones by
a constant only, which is the shift the code comment already describes.

### Pooled score min/max, before and after

Measured over 400 random photo sets of 2–6 photos, each photo fused from two views
(crop + full frame) as shipped, pooled with `updatePooling`'s equal-weight sum
(`aggLogits[sp] += p.logits[sp] * w`), then reported max-relative as the card does.
6400 species-level relScores per column:

| | min | max | values outside the −20..0 axis |
|---|---|---|---|
| before (`lp[i] * scale`) | **−428.1** | 0.0 | **5702 / 6400** |
| after (`scale * spCos[i]`) | **−10.8** | 0.0 | **0 / 6400** |

Every value after the fix sits inside the axis, and the extreme is at about half the
axis depth rather than 20x past it. Nothing else contributes: the −428 outlier was
fully explained by this one line.

The pre-fix magnitudes Cornelius saw (−128, −395, −600) are consistent with the −428
measured here; the exact per-photo values depend on the photos pooled.

## Bug 2 — "Complex Score" replaced by genus

`complexScores` grouped species by a hand-written `COMPLEX_OF` map of species complexes.
For a complex holding one species, the summed posterior *is* that species' posterior, so
the CSV's `Complex Score (%)` and `Species Score (%)` columns were the same number on
most rows — 58.9/58.9 and 71.7/71.7 in the export Cornelius read. `Aedes vexans`,
`Aedes geniculatus` and `Aedes cinereus` were all folded into a bucket called
"Other Aedes", which says less than the species name it replaced.

What changed:

- **`COMPLEX_OF` deleted.** `genusOf(name)` takes the first whitespace-delimited word of
  the label. Splitting on whitespace rather than the second word keeps the compound
  names inside their genus: `Culiseta annulata` and `Culiseta morsitans` both give
  `Culiseta`, and the `/`-joined labels the old map carried
  (`Culiseta annulata/morsitans`, `Aedes japonicus/koreicus`,
  `Anopheles maculipennis complex`) never appear as species labels, so they cannot
  split wrongly.
- **`complexScores` → `genusScores`**, `COMPLEX_MARGIN` → `GENUS_MARGIN`. Same margin
  test, same `p.demoted` flag, same consumers.
- **CSV header**: `Top Complex,Complex Score (%)` → `Top Genus,Genus Score (%)`. The
  species columns are unchanged.
- **Results table headers** in `index.html`: same rename.
- **`updatePooling`**: the candidate's `complex` field is now `genus` (it feeds the
  per-candidate tooltip; the displayed rows are unaffected).
- **The demotion label** drops its "-level only" suffix: the reported label is already a
  genus, so it reads `"Aedes - low confidence"`. The consumer at main.js:2133 matches on
  the substring `"low confidence"`, so it still fires.
- **A demoted photo now reports its genus alone**: species becomes `"not determined"`
  and the species score `-` in both the table and the CSV. A photo whose top two genera
  are within `GENUS_MARGIN` has no species verdict, and printing one anyway was the old
  behaviour this replaces.

The genus score is *not* a duplicate of the species score and so kept its column: with
7 Aedes, 3 Culex, 3 Culiseta and 3 Anopheles in the label set, a genus score is the sum
over its species and differs from the top species' own posterior.

### CSV before/after

Same eight synthetic photos, real code path, no classifier loaded:

```
--- BEFORE (species complexes) ---
Filename,Status,Cropped,Top Complex,Complex Score (%),Top Species,Species Score (%)
"IMG-20261003-WA005.jpeg","auto crop",false,"Other Aedes",44.8,"Aedes vexans",44.2
"IMG-20261003-WA002.jpeg","auto crop",true,"Aedes japonicus/koreicus",69.5,"Aedes koreicus",69.4
"IMG-20261003-WA000.jpeg","auto crop",true,"Culiseta longiareolata - low confidence, genus-level only",54.4,"Culiseta longiareolata",54.4

--- AFTER (genus) ---
Filename,Status,Cropped,Top Genus,Genus Score (%),Top Species,Species Score (%)
"IMG-20261003-WA005.jpeg","auto crop",false,"Aedes",66.7,"Aedes vexans",44.2
"IMG-20261003-WA002.jpeg","auto crop",true,"Aedes",75.7,"Aedes koreicus",69.4
"IMG-20261003-WA000.jpeg","auto crop",true,"Culiseta - low confidence",55.1,"Culiseta longiareolata",54.4
```

Row 0 of each set is the shape Cornelius reported: before, the two score columns are the
same number (54.4/54.4). After, the genus score is the sum over the genus (66.7 against
44.2) and the two columns say different things.

## Test method

All checks are pure arithmetic over the app's own `text_embeds.json` and transcribed
`softmaxJoint` / `fuseViews` / `updatePooling` code — no browser, no ONNX. The one
browser pass (Playwright, Chromium, served over plain HTTP on port 8153 from the
worktree) loaded the page with `**/*.onnx` and `**/*.r2.dev` routed to `abort()`, so the
1.26 GB classifier was never fetched: **2 model requests aborted, 0 bytes of model
downloaded**. It confirms the table headers render as
`["File","Top Genus","Genus Score (%)","Top Species","Species Score (%)"]` and that the
only console errors are the expected aborted model fetches. No photos were classified —
that needs the classifier, which is out of bounds here.

`node --check main.js` passes.

## Not done

- No live end-to-end run with real photos, so the −10.8/0.0 pooled range is measured over
  synthetic cosines in the range this model produces, not over a real photo set. A real
  set with an unusually flat posterior could exceed −20; the pooled card clamps bar
  width to 0 there but the number would still print.
- `p.scores` is still keyed by whatever `genusScores` produced, so the low-confidence
  suffix remains part of the key. That was already true before this change and nothing
  downstream splits on the key.

## How this landed

Commit `f7a6e62` on `agent/fused-logits`, pushed, and subsequently merged to `main` by
the coordinator. Two files, no test config added, no new UI text.
