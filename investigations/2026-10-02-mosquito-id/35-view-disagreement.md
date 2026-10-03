# The confidence gate could not see the two views disagree

Branch `agent/view-disagreement`, base `origin/main` (`b6eefdc`). Repo
`tmp/mosq-merge/`, worktree `tmp/disagree/`. Compare:
<https://github.com/corneliusroemer-agent/mosquito-id/compare/main...agent/view-disagreement>

Files touched: `main.js`, `tests/gate.test.mjs`, `tests/view-disagreement-probe.mjs` (new),
`analysis/` (three new scripts). `index.html` untouched — no CSS, no layout.

## The defect, confirmed

`verdictFrom(spP)` read the fused species posterior and nothing else. The fusion
(`main.js:958`) pools the two views' log-probabilities, so when the views name
different species the posterior it hands the gate is an average of two
contradictory opinions. An average of a wrong answer and a different wrong answer
is still wrong, and it carries a plausible-looking number, so the gate passes it
and a species is named. That is Cornelius's report verbatim: *"one can't tell what
- it still shows culex pipiens, albopictus etc depending on the crop."*

`viewAgreement()` was already computed at all three sites and already reached the
UI — but it reached the **presentation**, never the **decision**.

## What a disagreement is worth, measured

The corpus is the only labelled two-view one there is: the 07-benchmark's 180
rows, each with both the detector crop (`det`) and the whole frame (`asis`)
embedded by BioCLIP-2.5 ViT-H/14 — the shipped backbone, 1024-d, the app's own
16-species + 8-nuisance head and its own `logit_scale`. That is exactly the pair
of views `fuseViews` pools. Split 60/20/20 by source:class group, seed 0, the same
discipline `calibrate.py` used for `SPECIES_CONFIDENCE_FLOOR`. Scored at genus,
because `gt_class` is one of ten benchmark slugs and a slug like `culex` covers
several species.

```
genus correct   views agree      93.8% val  (n=16)   95.2% test  (n=21)
                views disagree   63.6% val  (n=22)   65.2% test  (n=23)
```

On the 102 rows whose truth is species-rank, the species claims the app makes on
**disagreeing** rows are right **18.2% val / 33.3% test**. That is the defect,
quantified: the species floor is answering, at 82–88% confidence, the exact
photos it was fitted to decline.

## The threshold, and why the constant is a boolean

The obvious graded form — abstain only when a disagreement is *also* narrow in the
fused margin — was fitted the same way, on val, read once on test. It is not
identified:

```
disagreeing rows, genus accuracy above a margin cut (val)
  margin >=  1pt  n=21  62%
  margin >=  5pt  n=18  67%
  margin >= 10pt  n=18  67%
  margin >= 20pt  n=17  65%
  margin >= 30pt  n=11  64%
```

Flat. So "demote every disagreeing species claim" — the val optimum — sits at the
**boundary of the grid** rather than inside it, which is a boundary-limited fit and
not a result. Grading it would be inventing a number this corpus does not contain,
and §9 trap 3 of the calibration report already records that failure mode once.

So the shipped constant is `VIEW_DISAGREEMENT_VETOES_SPECIES = true`: the whole of
what was measured, nothing more. A disagreement costs the photo its **species**
claim and the genus floor then decides the rest on its own — not past it. So
whether such a photo gets a genus or "not confident" stays the genus floor's call
and not this gate's.

I checked the one alternative severity measure, the weaker view's own confidence
(`min` over views of that view's top posterior). It is worse: disagreeing rows with
`minP >= 0.373` are **more** accurate (80% val, 75% test) than the disagreeing
rows below it. The dangerous set is a flat view arguing with a decided one, and
the species floor already handles that case — it is not where the residue is.

## The change

```js
// verdictFrom(spP, agreement)
const vetoed = Boolean(agreement && !agreement.agree && VIEW_DISAGREEMENT_VETOES_SPECIES);
if (!vetoed && topSpeciesP >= SPECIES_CONFIDENCE_FLOOR) { ... species ... }
if (topGenusP >= GENUS_CONFIDENCE_FLOOR) { ... genus ... }
return { state: "unsure", ... };
```

`viewAgreement` now runs **once**, inside `fuseViews`, over the views actually
pooled, and hands its result to `verdictFrom`. The three call sites that recomputed
it (`main.js:1580`, `main.js:1752`, `main.js:2453`) read `fused.agreement` instead,
so there is one disagreement measure and the gate reads the same one the UI shows.
A second call site recomputing it would have been a second measure free to drift.

The pooled-across-photos headline calls `verdictFrom(pooledSpP)` with no agreement,
and that is correct as it stands: a pool of photos is one claim, not a photo with
two views, and there is no pair of views to disagree.

`SPECIES_CONFIDENCE_FLOOR` (0.373) and `GENUS_CONFIDENCE_FLOOR` (0.80) are
untouched, as instructed.

## Verification

`node --check main.js`; `node --test tests/gate.test.mjs` — all passing. Five new
assertions, and four of them **fail against `VIEW_DISAGREEMENT_VETOES_SPECIES =
false`**, so they are not vacuous.

`tests/view-disagreement-probe.mjs` drives the real `fuseViews()` in Chromium with
`**/*.onnx` and `**/*.r2.dev` routed to `abort()` — the 1.26 GB classifier is never
fetched, and the probe fails if no model request was aborted. Three fixtures that
differ **only** in whether the two views name the same species:

| photo | views | fused top species | verdict before | verdict now |
|---|---|---|---|---|
| `flip.jpg` | disagree | 42.9% (floor 0.373) | species, one of the two | `Definitely Aedes - maybe aegypti or japonicus` |
| `undecided.jpg` | disagree | 54.5%, genus 0.688 | species | `Not confident enough to name a genus` |
| `agree.jpg` | **agree** | 99.0% | species | species, `Aedes aegypti` (unchanged) |

Both halves hold. The disagreeing photo that pools to a decisive-looking 42.9% no
longer names a species — and the ranking still shows both candidates at 42.9%, so
nothing is hidden. The agreeing photo is untouched, so this is not a gate that
abstains on everything.

`node_modules` was symlinked in from another worktree to resolve `playwright`, then
removed; it is not in the branch.

## The bigger half: there is no "not a mosquito" outcome

`nuP` is computed, used at `main.js:1520` to decide whether to keep the detector
crop (on a nuisance win the app reverts to the whole frame with `fallback = true`),
and then discarded. A species ranking is rendered regardless. A perfect
confidence gate would still say "confidently *Culex pipiens*" about a wall.

What it would take, on the positives side (`analysis/nuisance_gate.py`, the
6,264-image cache, H/14 whole-photo embeddings through the shipped head):

```
nuisance mass over 6,264 true mosquitoes
  median 3.1e-06   p90 1.6e-04   p99 2.4e-02   p99.9 1.0e-01   max 0.325

  gate at nuP >= 0.05   drops 0.43%  (27 of 6,264 true mosquitoes)
  gate at nuP >= 0.10   drops 0.11%  ( 7 of 6,264)
  gate at nuP >= 0.20   drops 0.02%  ( 1 of 6,264)
```

So **0.05 is roughly where the gate has to sit** to keep the loss of true
mosquitoes under half a percent, and the positives' own tail reaches 0.325, which
is a hard ceiling: anything above ~0.33 loses nothing and anything at 0.05 is
already costing 27 real mosquitoes. That is the cheap half.

**The false-positive rate cannot be measured, and that is the finding.** The
6,264-row cache is four sources (GBIF 3,172, Mosquito Alert API 2,866, MA dump 187,
Wikimedia Commons 39), seven labels (two of them genus-rank), and **zero
negatives** — every row is a photograph of a mosquito. A threshold fitted on it
has no way to see a wall, a hand or a table, so no FPR at 0.05 can be quoted, and
any number produced that way would be fiction. Fitting it needs a labelled
negative set first; that is a data-collection task, not a threshold sweep.

Two things already exist and would make it cheap once negatives exist:

- The 180-row two-view benchmark shows the same positives-side shape at much lower
  amplitude (max `nuP` 0.033 over 180 rows, all of it from Mosquito Alert), so a
  gate at 0.05 would cost that corpus nothing. It cannot calibrate anything
  either — same reason, all positives.
- `tmp/abstain-cal/` holds five synthetic non-mosquito photographs (wall, sky,
  table, foliage, skin) from an abandoned attempt at exactly this. They are not
  embedded and the classifier is not runnable in this container (`torch` is not
  installed, and H/14 has no fp32 ONNX export), so they were not scored. They are
  a start, not a set — five images of synthetic texture would not estimate an FPR
  for user photographs either.

The honest summary of the boundary: **the gate can be fitted to the positives today
and not to the negatives, so the app can be made to know where its floor is and not
where its ceiling is.**

## Reproducing

```sh
cd /workspaces/claude-devcontainer/tmp/disagree
python3 analysis/disagree_fit.py       # agreement vs accuracy, margin thresholds
python3 analysis/disagree_species.py   # species claims on disagreeing rows
python3 analysis/nuisance_gate.py      # nuisance posterior over true mosquitoes
node --test tests/gate.test.mjs
node tests/view-disagreement-probe.mjs # Chromium, models aborted
```

All read existing caches; none produces or downloads an embedding. The scripts
live in the branch so the constants can be refitted when a better corpus exists.

## Caveats

- 180 rows, 38 val / 44 test after the split. The agreement gap (94% vs 65%) is far
  larger than that sample can be noise, and it transferred val→test within 1.4 pp
  in both directions — but the disagreeing-row counts behind the finer numbers are
  20–23, so the secondary tables should not be read to their decimal places.
- 102 of the 180 rows have species-rank truth; the 78 genus-rank rows are excluded
  from the species readout and stated as excluded, not silently dropped.
- This corpus is the 07-benchmark's, which is harder and more varied than the
  6,264-row cache the floors were fitted on. The direction transfers; the absolute
  rates do not, and the coverage numbers here are not a coverage estimate for the
  cache.
- Half the rows in this corpus disagree (84 of 180), which is why full abstention
  on disagreement costs ~45 points of coverage and why the shipped rule demotes
  rather than silences. If real-world photos disagree at that rate, the genus floor
  — not this gate — is where the coverage loss would land, and it is worth
  watching rather than assuming.
