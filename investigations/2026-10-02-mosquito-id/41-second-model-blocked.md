# Shipping a second, small model is blocked — and one mechanism, not accuracy, is why

**Status: not shipped. Do not retry without clearing the non-mosquito blocker below.**

The idea was to ship `culico-net-cls-v1` (85 MB ONNX) alongside BioCLIP H/14 (1.26 GB),
default-selected on phones, with the large model selectable. The app side is genuinely
cheap: `src/confidence/` already takes a `Head` as a parameter, so a second model is a
second head plus a fetch. What stops it is that culico cannot supply a head at all.

## The blocker: two of the three embedding blocks have no source

A `Head` needs three embedding matrices (`src/confidence/types.ts`):

| block | what it carries | culico source |
|---|---|---|
| `species_emb` | 16 species rows | **producible** — see below |
| `nuisance_emb` | 8 "not an insect" prompts | **none** |
| `adjacent_emb` | 7 confusable families | **none** |

culico is a supervised 18-way mosquito classifier. It has no text encoder and no
background class, so there is nothing to produce "a photograph of a wall" in culico's
feature space. The consequence is concrete: `softmaxJoint` pools `nuisance_emb` into the
mass that the `nonMosquito: 0.60` floor gates on. With that block absent the gate can never
fire, and the app names a species on a photograph of a person.

This is measurable in the fitting agent's own output rather than inferred:
`culico_results.json` → `readout.non_mosquito_floor_0_would_return_every_row: true`, with
adjacent mass pinned at `max_adP: 7e-09`. The probe cannot express "not a mosquito" at all.

## The numbers, which would have been a regression anyway

On the 1,252-row genus test split, 6,086 uuids, 0 straddling rows:

| readout | genus | species-rank |
|---|---:|---:|
| H/14 zero-shot head, calibrated | **92.33%** | **76.69%** |
| culico linear probe | 82.99% | 64.22% |
| culico's own 18-way head, zero-shot | 44.4% | — |

culico's own head puts 67.5% of test rows into classes this corpus never labels. The
probe is the best available readout and is still 11.3 pp behind, so a phone default would
have been ~11 pp worse on exactly the devices it was meant to help.

The fitting agent also ruled out calibration for culico directly: *"No embeddings are
produced"*, and *"culico-net-cls-v1 cannot be shown to gain on `log p`. Do not ship a
calibration for it."* See `/Users/cr/code/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship/91-calibration-ship.md`.

## The caveat that still applies

culico-net-cls-v1 was fine-tuned on a mosquito dataset containing most of this corpus's
label space, so its figures are an **upper bound** — `07-benchmark.md` calls its 89.7%
in-lineage score "a ceiling estimate for a dedicated classifier, not evidence of
generalisation". The comparison is therefore better for H/14 than these numbers make it,
not worse. Fixing that would mean evaluating on held-out labels culico never trained on.

## The structural correction, so the next attempt starts here

`Head.species_emb` is **not** a CLIP text embedding. Its rows are arbitrary vectors
dot-producted against the image embedding (`softmax.ts:60`), so a linear probe's weight
matrix is structurally compatible and needs no text encoder — the embeddings file is just
the probe weights, renamed. An earlier brief assumed `W · tex` and therefore that culico
needed a text encoder; that assumption is what made the task look impossible rather than
merely unproven.

## What would unblock it

Both, not either:

1. **A readout that expresses non-mosquito rejection** — a background/outgroup class
   trained jointly with the probe, or the existing nuisance prompts mapped through a
   learned projection into culico's space.
2. **Evidence it beats 92.33% genus** on labels culico did not train on.

Until both hold, model size is the only argument for a second model, and accuracy argues
against it. Re-derive the genus/species numbers on a held-out split before treating the
82.99% figure as real.
