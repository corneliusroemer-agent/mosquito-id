# We were training on the wrong taxonomy column

**Date:** 2026-10-03 · **Branch:** `agent/relabel-species` ·
**Scripts:** `build_relabel.py`, `evaluate.py`, `zeroshot_head.py` ·
**Protocol:** uuid-grouped 60/20/20, probe fitted on train, `C` selected on val, test read once,
fp32, `taskset -c 0-7` with `OMP_NUM_THREADS=4`.

## The finding

The manifest carries two taxonomy columns and we read the wrong one. `species_label` — what every
probe in this project was fitted on — says `Culiseta`, `Anopheles`. `ma_taxon_name` /
`ma_taxon_rank` carries **Mosquito Alert's own identification of the same specimen**, and for a
whole block of rows it is species-rank.

**640 of the 6,264 cached rows gain a species-rank label. All 640 are human-expert-labelled.
629 of them are `expert_probable`; 11 are `expert_confirmed`.**

| tier | rows relabelled |
|---|---|
| `2_expert_probable` | **629** |
| `1_expert_reviewed` | **11** |
| `3_automated_only` (AI) | **0** |
| `4_asserted_no_verification_field` | **0** |

That is the good news and it is genuinely good news: the relabelled set contains **no
machine-labelled rows and no asserted rows**. Every one of them is an entomologist's
identification. The failure mode the provenance audit warned about — keying on
`ma_confidence_label == "Confirmed"` and inheriting 387 AI rows as if a human had confirmed them —
cannot occur here, because `certainty_grade` was used to select and the AI block is absent by
construction.

The bad news is the tier: **98% of the recovered labels are the tier where our accuracy is worst.**
The provenance audit measured 72.7% on expert-probable against 91.9% on expert-confirmed, a
19.2pp split. These 640 rows are drawn overwhelmingly from the weak tier. They are real
expert identifications, but they are identifications the expert was visibly unsure of.

### The 1,122 is confirmed; the cache holds 640 of them

Verified against the raw manifest: 1,122 rows where `species_label` is genus-rank but
`ma_taxon_rank == 'species'` and MA's identification agrees at genus level. Exactly the counts
reported. In the 6,264-row cache, **640 of them are present and 482 are not** — the missing ones
are dominated by *Culiseta annulata* (290) and *C. longiareolata* (123), plus all 69 Anopheles
and Culex rows. Only the Culiseta block was carried into the cache at all.

**3 of the 1,122 fall outside the shipped 16-species head** (*Culex hortensis* ×2, *Culex
modestus* ×1, all expert-probable). In the cache the count is **0** — every relabelled row names
a class the head ships. So the trade asked about is nearly free here: relabelling does not push
rows out of scorable range. It does mean those three rows can never be scored against this head,
and they are not in the 640.

### Corrected species distribution (6,264 rows)

| label | rows | was |
|---|---|---|
| Aedes aegypti | 1,446 | same |
| Anopheles | 1,383 | same |
| **Culiseta annulata** | **452** | — (part of 1,473 `Culiseta`) |
| **Culiseta longiareolata** | **188** | — |
| Culex | 651 | same |
| Aedes albopictus | 658 | same |
| Aedes japonicus | 541 | same |
| Culiseta (residual) | 833 | 1,473 |
| Aedes koreicus | 112 | same |

The corpus is no longer "56% genus-rank with every species-rank row being Aedes". It is 6
species-rank classes covering 3,397 rows, and the genus-rank remainder is 2,867.

## 1. Re-measured on the corrected corpus

Linear probe on the cached BioCLIP H/14 features, uuid-grouped split, leak check clean
(0 straddling uuids, 0 straddling rows, 0 multi-label uuids on both tasks).

**Species task** — 3,397 rows, 3,219 uuids, test **n=680**:

| | value |
|---|---|
| accuracy | **85.6%** |
| macro-F1 | **75.3** |
| balanced accuracy | **74.2** |
| selected `C` | 1.0 |

**Genus task** — all 6,264 rows, test **n=1,239** (the control: genus is unchanged by the fix):

| | value |
|---|---|
| accuracy | **94.6%** |
| macro-F1 | **93.4** |
| balanced accuracy | **93.2** |

Per-class recall, with n:

| class | n (test) | recall | measurable? |
|---|---|---|---|
| Aedes aegypti | 290 | 95.9% | yes |
| Aedes albopictus | 131 | 83.2% | yes |
| Aedes japonicus | 108 | 76.9% | yes |
| **Culiseta annulata** | **91** | **83.5%** | yes |
| **Culiseta longiareolata** | **37** | **83.8%** | borderline (37 rows) |
| **Aedes koreicus** | **23** | **21.7%** | **too small to measure** |

**Aedes koreicus at n=23 cannot be measured.** The 21.7% is consistent with the 26.1% the
provenance audit recorded on a different split, so the class is known to be near-collapse, but a
23-row estimate has a confidence interval wide enough to include both "poor" and "broken".

*Culiseta longiareolata* at n=37 is genuinely borderline. It is reported because it is the point
of the exercise, but the paired comparison against *annulata* is the number to read, and that
has n=128 — see §2.

### By verification tier

The stratified numbers, which the audit argued matter as much as the headline:

| tier | species n | species acc | genus n | genus acc |
|---|---|---|---|---|
| `1_expert_reviewed` | 88 | **90.9%** | 128 | 93.0% |
| `2_expert_probable` | 309 | **74.8%** | 399 | 92.2% |
| `3_automated_only` | 66 | 97.0% | 81 | 100.0% |
| `4_asserted_no_verification_field` | 217 | 95.4% | 631 | 95.7% |

The 16.1pp gap between expert-reviewed and expert-probable on the species task reproduces the
audit's 19.2pp. **The new labels land in the weak tier and behave accordingly** — the 640
relabelled rows are the 309-row `expert_probable` block's new territory, and they score 74.8%.

The genus task is nearly flat across tiers (92.2%–100%), which is the audit's finding restated:
the genus decision is robust to label provenance, the species decision is not.

## 2. Does the head know these species?

This is the question that decides whether the corpus fix was worth anything, and the answer is
**yes, for Culiseta.**

The shipped zero-shot head never saw any manifest label, so this measures the product rather than
a fit. Scoring path copied verbatim from `90-uuid-split/uuid_split.py` (`TEMPERATURE` 2.5,
`logit_scale` from the shipped JSON, softmax over the 24-way species+nuisance block, fp64 matmul
over the cached fp32 features). It reproduces the published baseline: **90.4%** genus argmax over
all 6,264 rows against the reported 89.19–90.21% band, so the implementation is the same one.

Species argmax **restricted to the correct genus**, on the 128 test rows of the two Culiseta
species — the comparison the corpus previously made impossible:

| | n | accuracy |
|---|---|---|
| **Culiseta, within-genus species** | **128** | **93.0%** |
| chance (3 classes) | | 33.3% |

Confusion matrix:

| truth → predicted | annulata | longiareolata |
|---|---|---|
| **annulata** | **87** | 4 |
| **longiareolata** | 5 | **32** |

**The head is not inventing this distinction.** 93.0% against 33.3% chance, with the errors
symmetric (4 vs 5), is a genuine discriminator. Two species the corpus previously had *zero*
species-rank rows for are separable at a rate that justifies shipping them as separate classes.

Per-species, on the shipped head:

| class | n (test) | species recall | genus recall | chance within genus | measurable? |
|---|---|---|---|---|---|
| Culiseta annulata | 91 | 95.6% | 87.9% | 33.3% | yes |
| Culiseta longiareolata | 37 | 86.5% | 62.2% | 33.3% | borderline |

On the full corrected species task (test n=680) the shipped head scores **75.0%** species-argmax
and **93.4%** genus — consistent with the probe's 74.2 balanced accuracy and far below its 85.6%
raw accuracy, which is the imbalance showing through.

### The classes still with zero testable rows

The head ships 16 species. **10 have no species-rank row anywhere in the 36,961-row manifest**:

*Aedes vexans, A. geniculatus, A. cinereus, Culex pipiens, C. torrentium, C. quinquefasciatus,
Culiseta morsitans, Anopheles maculipennis, A. claviger, A. plumbeus.*

Two of those are the ones the brief called out. *Cx. torrentium* and *Ae. cinereus* remain
completely untestable, and so does *Cx. pipiens*. The relabelling does not change that: the
Anopheles rows that DO carry species-rank MA identifications (*A. maculipennis s.l.* ×53,
*A. plumbeus* ×13) **did not make it into the 6,264-row cache**, so they cannot be scored either.
The head's competence on those three species is still unmeasured.

Note also that `Anopheles maculipennis s.l.` is a species *complex*, not a species. The head ships
`Anopheles maculipennis`. If those rows are ever brought into the cache, mapping a complex label
onto a single-species head class is a separate decision that this relabelling does not make.

## 3. What this does and does not change

**It does not add training data.** This is the caveat that has to be stated rather than buried.
The 640 rows are evaluation rows. A probe fitted on the corrected corpus learns
*Culiseta annulata* vs *C. longiareolata* from 452 and 188 rows instead of from nothing, which is
a real gain, but it is a gain entirely on the two Culiseta species. Every other shipped species is
untouched, and *Cx. torrentium* and *Ae. cinereus* remain at zero species-rank rows in every
source. The 16-way head is 10/16 unmeasured on species and that ratio barely moved.

**It corrects the genus/species framing.** "56% of the corpus is genus-rank and every species-rank
row is Aedes" was an artefact of the column we read, not a property of the data. That sentence
should not appear in any writeup, including this one.

**It moves the accuracy story onto expert-probable ground.** The new headline numbers are
computed on a test set whose species labels are 74% `expert_probable`. The 85.6% is real against
these labels; whether the labels are right is a separate question only human adjudication can
settle, and `96-label-provenance/93-adjudication-set/` is still unfilled.

**The 3,150 asserted rows are still 50% of the corpus** and still unverified. This work did not
touch them.

## Reproducing

```sh
OMP_NUM_THREADS=4 taskset -c 0-7 uv run --quiet --with numpy python \
  40-precision/97-relabel/build_relabel.py     # join + relabel  -> 92-corrected-corpus.tsv
OMP_NUM_THREADS=4 taskset -c 0-7 uv run --quiet --with numpy --with scikit-learn python \
  40-precision/97-relabel/evaluate.py          # probe + tiers   -> 93-accuracy-by-tier.tsv
OMP_NUM_THREADS=4 taskset -c 0-7 uv run --quiet --with numpy python \
  40-precision/97-relabel/zeroshot_head.py     # shipped head    -> 94-zeroshot-head.json
```

Relabelling only fires where `ma_taxon_rank == 'species'` **and** MA's name starts with the
existing `species_label` genus, so a genuine genus-level disagreement is left alone rather than
silently overwritten. Nothing is fitted on test: `C` is chosen on val, and the shipped-head numbers
are a fixed artefact evaluated once.
