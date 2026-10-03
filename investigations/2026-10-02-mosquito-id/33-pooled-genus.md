# Pooled genus headline on the Combined result card

Branch `agent/pooled-genus`, off `origin/main` @ `b6ad1fb`. Compare:
https://github.com/corneliusroemer-agent/mosquito-id/compare/main...agent/pooled-genus

## What changed

`updatePooling()` already sums the pooled logits across included photos and ranks
species from them. It had no genus layer. The pooled card now leads with the
pooled genus verdict and keeps the species ranking below it unchanged.

## Where the posterior comes from

The pooled posterior is `softmax(aggLogits)` — the softmax of the logits
`updatePooling` already aggregates, not a second aggregation and not a mean of
per-photo verdicts. That is exact rather than approximate: a photo's stored
`logits` are `scale * cos`, and `log p = scale * cos - logZ`, so they are the
per-photo log-probabilities up to a constant. Softmax over their weighted sum is
therefore the pooled posterior directly.

Max-subtracted inside `pooledPosterior()` before exponentiating: raw pooled logits
run into the hundreds and a bare `exp()` overflows to `Infinity` on every species,
which would turn the whole pool into `NaN` and read as a verdict rather than as no
verdict. `pooledPosterior` returns `null` on any non-finite logit or a
non-positive total, and the headline is then omitted rather than rendered wrong.

`verdictFrom()` and `verdictSentence()` are reused unchanged, so "confident enough
to name a genus" means the same thing on the pooled card as on a single photo.

## Behaviour, and why

| Pooled verdict | Headline | Why |
| --- | --- | --- |
| `genus` | `Definitely Aedes - maybe aegypti or albopictus` | the pooled claim is coarser than the ranking; the headline carries it |
| `species` | absent | the ranking below already leads with the binomial, and `verdictSentence` returns `""` for a species verdict by existing design. A headline repeating the top row would add nothing |
| `unsure` | `Not confident enough to name a genus` | the pooled gate really did abstain, and the app says so rather than showing a dash |
| fewer than 2 photos | absent | `updatePooling` returns before aggregating; the card shows its "check two or more photos" prompt |

A photo whose own verdict is `unsure` is still excluded from the pool by the
existing filter, untouched. The pooled gate can only ever be as confident as the
evidence that got into the pool.

## Layout stability

The 240px reservation on `#combined-scores` was not changed. The headline is a
`position: sticky` child **inside** that box, so it consumes scroll content and
zero box height — sticky is in flow, so it cannot change the containing block's
height even when absent.

Measured card height with the real render path (`tests/pooled-genus-probe.mjs`,
clicking the app's own `#thumbnail-strip` checkboxes, `**/*.onnx` and `**/*.r2.dev`
aborted so the 1.26 GB classifier is never fetched):

| photos pooled | 0 | 1 | 2 | 3 | 5 confident | 5 torn |
| --- | --- | --- | --- | --- | --- | --- |
| card height @1280px | 369 | 369 | 369 | 369 | 369 | 369 |
| card height @420px | 361 | 361 | 361 | 361 | 361 | 361 |

Identical at every pool size, at both widths. The headline renders 30px tall and
`firstRowTop` is pinned by the sticky box, so no score row moves when it appears.

The last two columns are the control pair: same pool size, same code path,
different pooled posterior, opposite headline behaviour. The headline tracks the
pooled posterior and nothing else — not the pool size, not the photo count.

## index.html changes

Two things, both confined to the pooled card:

1. A new `.combined-genus-headline` rule (`position: sticky; top: 0`, card
   background so the ranking scrolls under it, 14px/600, hairline bottom border).
2. Nothing else. No existing rule was edited — `.combined-scores`, `.combined-card`,
   `.top-grid`, `.combined-header`, `.combined-axis` and every reserved-height rule
   are byte-identical to `origin/main`, so the concurrent top-row CSS work is not
   conflicted with.

## Constraints honoured

Untouched: the score-row flush, `#score-pending` / `#view-agreement` reservations,
the `Number.isFinite` bar guards (the new code adds its own guard but the existing
one on `relScore` is unchanged), the progress meter, `#score-uncertain`, delete-all
behaviour, `.top-grid` / `.combined-scores` heights, and the abstention rule in
`updatePooling`.

## Verification

- `node --check main.js` — passes.
- `node --test tests/gate.test.mjs` — passes (7 assertions, including the one that
  pinning `unsure` out of the pool still holds).
- `node tests/pooled-genus-probe.mjs` — PASS.

**Pre-existing failure, not from this branch:** `node tests/verdict-line-probe.mjs`
fails on `origin/main` as well, with the same two assertions (`torn: verdict line
not rendered`, `flat: verdict line not rendered`). Verified by running the
unmodified `origin/main` sources in a clean directory. Left alone — it is the
per-photo `#score-uncertain` line, which this branch does not touch.
