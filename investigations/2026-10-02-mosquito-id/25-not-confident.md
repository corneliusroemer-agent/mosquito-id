# "Not confident" in the live app: a species gate, a genus gate, and what the pooled card does

Branch `agent/not-confident-gate` (pushed, not merged), from `c7c93d0`. Two commits:
`21ae4e4` the gate, `3c3f2cd` loading the embeddings without the classifier.

**Headline: the gate ships, and an abstaining photo is excluded from the pooled vote and
visibly marked as excluded.** A photo the classifier cannot place contributes nothing to the
combined card, is listed in the contribution table as `excluded - not confident enough to name a
genus` with a `-` share, and says so on its thumbnail's tooltip. Nothing is silently counted.

---

## 1. What the app now says

Three states, decided per photo from the **fused** posterior:

| State | Condition | The score panel says |
|---|---|---|
| Species | top species posterior ≥ 0.373 | (nothing above the ranking - the ranking *is* the claim) |
| Genus | species below 0.373, top genus ≥ 0.54 | `Definitely Aedes - maybe aegypti or vexans` |
| Unsure | neither | `Not confident enough to name a genus` |

The **full 16-species ranking stays visible in every state**, below the verdict line, with its
bars and percentages. That was the point: a coarser claim plus the evidence for it, never a
narrower one and never nothing.

The genus sentence names the two next species **inside** the genus it names, with the genus
prefix stripped - `Aedes aegypti` reads as `aegypti`. Naming a runner-up from another genus
would make the sentence self-contradictory ("definitely Aedes, maybe pipiens").

The same claim appears in the results table (`Aedes (genus only)` / `Not confident`) and in the
CSV export, so nothing leaving the machine claims a species the app declined to name.

### Genus derivation

`genusOf(name)` takes the first whitespace-separated token of the species name - from
`EMB.species`, not a hardcoded list. Whitespace first is what makes the compound epithets work:
`Culiseta annulata/morsitans` and `Anopheles maculipennis complex` stay inside *Culiseta* and
*Anopheles* rather than the slash or the trailing "complex" being read as a genus. The 16
shipping names resolve to `Aedes` (7), `Culex` (3), `Culiseta` (3), `Anopheles` (3); the index is
rebuilt whenever `EMB` changes.

A one-word label is its own genus. The first version returned `""` there, which filed every bare
name under a single empty genus; a unit test caught it.

## 2. The constants

Both at module scope in `main.js`, next to `COMPLEX_MARGIN`:

```js
const SPECIES_CONFIDENCE_FLOOR = 0.373;
const GENUS_CONFIDENCE_FLOOR = 0.54;
```

`SPECIES_CONFIDENCE_FLOOR` is the 90%-coverage point from
[`41-calibration.md`](../2026-10-03-rewrite/40-precision/40-calibration/41-calibration.md) §3 -
answers 88% of test images at 96.6% accuracy (CI 93.2–99.1) against the shipped argmax's 88.0%.

`GENUS_CONFIDENCE_FLOOR` is new, fitted the same way: the smallest value at which the top genus
is right on **every val row the species gate abstains on**. It is higher than the species floor
because a genus posterior is a sum over its species and is therefore larger by construction -
the same 0.373 would be no gate at all.

The comment above both records, as required: the values, that they are empirical, that 0.373 is
val-fitted, and that **the val→test transfer gap is the binding constraint** - a threshold
picked on val at 5% FPR got 60.0% recall on test against 86.0% for the test-oracle threshold, on
74 val rows. Genus answers are where that gap bites hardest and they are measured on very few
rows: at 0.54 the genus is right on **7 of 7** test rows the species gate abstains on, and wrong
on **2 of 16** at a floor of 0.30. Re-fit both when more labelled data exists; do not tune either
on the test split.

Measured by [`25-genus-gate.py`](./25-genus-gate.py) against the same 659-row cache, the same head and the same
val/test split `calibrate.py` uses. Fitted on val, read once on test.

## 3. Fused, not per view

`fuseViews()` computes the verdict from the pooled posterior it just built
(`verdict: verdictFrom(spP)`), and that is the only place a verdict is created. Gating per view
would abstain far more often than a photo deserves - fusion is what turns two undecided views into
a decided one - and it would let the two views disagree about the same photo's verdict. A unit
test pins this: two views at 0.34 and 0.60 fuse to a *species* verdict, where the 0.34 view alone
would not have answered.

## 4. The pooled card - the thing that made this unsafe before

**An abstaining photo is excluded from the pooled combination, and it is marked as excluded.**

`updatePooling()` splits the checked photos: `abstained` is every photo whose verdict state is
`unsure`, and `included` is everything else. Only `included` is weighted and summed into
`aggLogits`. This is the trap from the parked work - an abstaining photo still contributed a
fabricated species to the pooled vote, which is worse than not gating at all, because the card
would fold in exactly the call the app had just declined to make.

A photo that reached only the **genus** state still contributes: its evidence is sound and only
its resolution is coarser, and the card's output is a relative-affinity ranking rather than a
verdict. It is labelled `genus only: Aedes` in the contribution table so the coarser claim is
visible where the sum is shown. That is the split I chose and why: the card's failure mode is a
wrong aggregate, and a genuine-but-weak posterior does not cause it, whereas a photo the app calls
unreadable does.

Marked in four places so it cannot be missed: the contribution table row (`-` share, with the
reason), the results table cell, the CSV row, and the thumbnail checkbox tooltip.

## 5. Layout

The verdict line sits directly above two boxes that already reserve their height, so showing and
hiding it would have pushed every score on screen down the panel. `#score-uncertain` now toggles
`visibility` against a reserved 44px two-line box with the full text in the tooltip, matching the
pattern `#score-pending` and `#view-agreement` already use. A browser test asserts the score
list's top edge does not move across the three states.

No new processing-state text anywhere. Removing the embeddings-loading split (§6) happened to
delete the "Loading species embeddings…" progress line that lived in that block.

## 6. One enabling change: `ensureEmbeds`

`loadWebGPUModels` set `EMB` as its last step, so nothing that only needed the label set could
get it without downloading the 1.26 GB classifier. `ensureEmbeds(path)` / `useEmbeds(path)` split
that out; the app's own path is unchanged (`loadWebGPUModels` calls `useEmbeds`). This is what
makes the gate testable without the model, and it is also correct on its own terms - the label set
is 2 MB and nothing else needs the classifier.

## 7. Verification

**Unit (`tests/gate.test.mjs`, `node tests/gate.test.mjs`, no browser, no model - 12 checks, all
passing).** The test lifts the functions out of `main.js` by reading the source and evaluating
those declarations against the real 16-name label set, so a copy of the logic cannot drift from
what ships, and it reads the two constants out of the file by regex. It covers genus derivation
(including `annulata/morsitans` and `maculipennis complex`), all three states, the exact-floor
boundary (`>=`, not `>`), a leading genus below the genus floor not being claimed, an empty
posterior degrading to `unsure` rather than throwing, the gate firing on the fused posterior, and
the pooling predicate.

Two real bugs were caught this way and fixed: `genusOf` returning `""` for a one-word name, and
`verdictFrom` initialising `topSpecies = -1` so the argmax loop (`i = 1`) could never select
species 0 - which silently made every photo read as unconfident.

**Browser ([`25-verify-notconfident.js`](./25-verify-notconfident.js), Playwright/Chromium - 24 checks, all passing).**
Three photos with hand-built posteriors are scored through the app's own `fuseViews` →
`commitScores` → render path, with every `.onnx` and `.r2.dev` request aborted. Confirms: each
state's verdict; the genus sentence rendering; all 16 species scores still shown with real
percentages in both non-species states; the verdict line not moving the layout; the contribution
table containing the confident and genus-only photos with shares and **not** the unsure one; the
results table and CSV carrying the coarse claim and never a fabricated species; and no model
session created (`sessClip`, `sessDet`, `window.modelsReady` all falsy). `initEngine` does attempt
the detector on load - that is the app's own startup - and every attempt was aborted.

The posteriors are injected rather than produced by the model, deliberately: the gate is
arithmetic over `spP`, so a real run would test the classifier rather than the gate, at 1.26 GB
a load.

## 8. What is not done

- **Nothing has been measured on real fused two-view posteriors.** Every number above is
  single-view, from the calibration cache. Fusion raises the posteriors, so both floors will
  abstain less often on the fused path than the table in §2 suggests. The `0.373` was fitted the
  same way and is already the shipped recommendation; `0.54` inherits the same caveat and is
  fitted on 9 val rows.
- **The genus floor is fitted on very few rows** (9 val, 7 test). It is the weakest number in
  this change and the one most likely to need re-fitting.
- No change to `TEMPERATURE`, `COMPLEX_MARGIN` or the nuisance gate. The gate composes with both;
  it does not replace either.
- Not merged. `agent/not-confident-gate` is pushed and waiting.

## 9. Reproducing

```sh
cd /workspaces/claude-devcontainer/tmp/notconfident   # worktree
node tests/gate.test.mjs
OMP_NUM_THREADS=2 taskset -c 0,1 nice -n 10 python ../25-genus-gate.py

# Browser: needs a static server on the worktree (09-async-crop/serve-branch.js, shifted ports)
node ../25-verify-notconfident.js
```
