# What the app may name, per head

Branch `feat/report-granularity`. Spec: `docs/REPORT-GRANULARITY-SPEC.md`.

## The problem, measured

`public/text_embeds_culico.json` gives 16 species only **8 distinct weight rows**.
Hashing each row (`Float32Array` → base64) on the shipped file:

```
Aedes albopictus | Aedes aegypti | Aedes japonicus | Aedes koreicus |   (4 singletons)
Aedes vexans | Aedes geniculatus | Aedes cinereus                        (one row)
Culex pipiens | Culex torrentium | Culex quinquefasciatus                (one row)
Culiseta annulata | Culiseta morsitans | Culiseta longiareolata          (one row)
Anopheles maculipennis | Anopheles claviger | Anopheles plumbeus        (one row)
```

Identical rows mean identical logits, so identical posteriors, so a tie that
breaks on list order — which is why `Aedes vexans` was observed winning
essentially every Aedes tie and the app printed it as an identification. The
whole of *Culex* is one class: nothing in this head can name
*Culex quinquefasciatus*.

Measured on this head: **22.6% species accuracy across the 16 columns, 94.9%
genus**; species argmax on the well-labelled 4-way Aedes subset ~70% against
H/14's 87.7%. The default engine is H/14, whose rows are all distinct, which is
why the app was usable and culico looked like a bad head rather than a
granularity problem.

This is the head, not the app. Nothing under `public/` was touched.

## Why exact row equality is the right grouping test

The obvious alternative is a cosine threshold — "group rows within 0.999 of each
other". It is wrong, and wrong in the dangerous direction:

* **Two rows that differ are two rows the model can separate**, however little
  they differ. A soft threshold suppresses species the head genuinely supports.
  That is the same defect as the one being fixed, pointing the other way: the app
  withholding a name it could have made.
* **Exact equality fails safe.** A head whose rows are merely *similar* yields no
  groups at all, every species is its own group, and the app reports species
  everywhere — which is exactly the behaviour of a head that can separate
  everything. The failure mode of the exact test is the correct behaviour of a
  good head.

So the test is `===` on the row's float32 bytes, after rounding through
float32 first (the precision the model computes in; two rows the JSON spells
differently but the weights cannot tell apart are the same row to the thing that
has to separate them). The rows in the shipped head are genuinely bit-identical,
so the test that fits this head is the one that will fit the refit.

One consequence worth stating: the cosine calibration cannot rescue a split
either. `PER_GENUS_COSINE_OFFSET` is keyed by genus, so members of one group
always receive the same offset — calibration cannot pull them apart even in
principle.

## The refit is the expected future, so nothing here is pinned to today's head

The iNat sweep added labelled photos for the species that share a genus row
today (vexans 3,445, quinquefasciatus 1,889, pipiens 732, geniculatus 678,
cinereus 131, torrentium 8), so a refit is expected to split these groups. Every
group in this work is derived from the loaded head at runtime and cached per head
in a `WeakMap`, so the split needs no code change: the groups become empty, the
capability becomes `"species"`, the dropdown note drops itself, and the score list
goes back to 16 rows.

`tests/report-granularity.test.ts` asserts that direction explicitly — a head
whose rows are all distinct produces no groups, names the species in the sentence
and in the label, shows one row per species, and prints nothing that says "not
separable". If a test failed there, the test would be pinning the bug.

The one place a fact is stated rather than derived is `ModelConfig.reports`,
which exists only so the **dropdown** can say "genus only" about an engine whose
head has not been fetched. Reporting never reads it: what the app prints comes
from `capabilityOf(head)`. A test asserts the declared value equals the derived
one for all four engines, so a refit that changes an engine's capability fails a
test rather than leaving a stale label.

## What each state looks like

`#score-uncertain` has a reserved 44 px box and is toggled by `visibility`, so
every row below is layout-neutral and no CLS assertion moved.

| verdict | top species | the sentence | the ranking's top row |
| --- | --- | --- | --- |
| species, singleton | *Aedes albopictus* | *(empty — the row below is the claim)* | `Aedes albopictus` 🔗 (Asian tiger mosquito) 90.0% |
| species, grouped | *Aedes vexans* | `Aedes (vexans / geniculatus / cinereus not separable)` | `Aedes (vexans / geniculatus / cinereus not separable)` 90.0% |
| genus, singleton leader | *Aedes albopictus* | `Definitely Aedes - most likely albopictus, possibly aegypti or japonicus` | unchanged |
| genus, grouped leader | *Aedes vexans* | `Aedes (vexans / geniculatus / cinereus not separable)` | the group row |
| unsure | — | `Not confident enough to name a genus` | — |
| non-mosquito | — | `This does not look like a mosquito - it looks like midge (93% of the match)` | the adjacent class |

The rule behind the table: **the sentence is spent exactly when the app is not
naming a species.** In the species state the ranking below already names it with
its common name and its guide link, and a second copy above it adds nothing.
Everything the ranking cannot say — a genus, a class the head cannot split — is
what the box is for.

On culico the ranking is 8 rows instead of 16: the four singletons plus the four
classes. Each class row carries one percentage, the largest among its members,
which they share by construction.

The dropdown:

```
⚡ culico-net-cls-v1 (experimental · 81 MB · genus only)
💻 WebGPU: BioCLIP 2.5 FP16 (1.25 GB) · Most accurate
```

Appended to the option's existing text at runtime, so the size and the
`experimental` marker each keep one source. No header caveat: that block moved
the page (0.27 CLS on desktop) and has been rejected twice, and
`e2e/culico-engine.spec.ts` already asserts the element is absent.

## What changed, and why each file

| File | Change |
| --- | --- |
| `src/app/granularity.ts` (new) | `resolvableGroups`, `equivalenceGroups`, `groupOf`, `capabilityOf`, `mergeUnresolvable`, `claimSentence`, and the active-head binding |
| `src/app/speciesLabels.ts` | `speciesLabelHtml` writes a group as the group before anything else runs — the one choke point every rendered species name comes from, which is also why the pooled card became correct without a change to `poolingPanel.ts` |
| `src/app/resultsTable.ts` | the "Top Species" cell and the CSV carry the same coarser claim |
| `src/app/modelConfig.ts` | `reports` per engine, and `capabilityNote` |
| `src/app/main.js` | bind the active head where the head is assigned; `claimSentence` in the panel; `mergeUnresolvable` in the ranking; the dropdown note |
| `index.html` | one CSS rule for `.species-unresolvable` (subdued, 11px — a qualifier on the genus, not a name) |

The active head is module state in `granularity.ts`, bound at the single place
`main.js` assigns `EMB`. Threading it through every call site is what produced
two divergent copies of a species label once already.

## verdict.ts: no change needed

`verdictSentence` is left exactly as it is, and that was a design constraint
rather than an accident. It decides the *shape* of the sentence from the verdict
state; `claimSentence` decides whether the sentence may name a species at all,
and for the one case that `verdictSentence` cannot express — a confident
posterior the head cannot spend on one species — it supplies the string itself.
For the genus state whose leader is namable but whose runner-ups are not, it
hands `verdictSentence` a copy of the verdict with those runners-up removed, so
the existing sentence format is reused rather than duplicated. Nothing in
`src/confidence/` was edited, so there is no change for the scoring agent to
make.

The pooled card calls `verdictSentence(pooledVerdict)` directly in
`poolingPanel.ts`, which is the pooling agent's file. It needs the same one-line
substitution (`claimSentence`) for the pooled sentence to be group-aware. The
card's candidate rows already are, through `speciesLabelHtml`. Worth doing when
that file is free; it is not a correctness hole today, because a pooled verdict
whose leader sits in a group prints an empty sentence and the candidates below it
read `Aedes (vexans / geniculatus / cinereus not separable)`.

## Tests

`tests/report-granularity.test.ts` (20): exactly four groups of three in the
shipped culico head and none in H/14 or B/16, asserted rather than assumed; a
head with all-distinct rows reporting species end to end; rows that are merely
similar staying separate; caching per head; every grouped species refused to every
rendered sentence, asserted on the string; a grouped species dropped from a
"possibly" list; a singleton still named; the sentence byte-identical to
`verdictSentence` on a head with no groups; one row per class in the ranking; the
label HTML.

`e2e/tier1/report-granularity.spec.ts` (6): the panel, the ranking (8 rows, no
unseparable binomial anywhere), the results table and the CSV, the singleton case
still named, the H/14 path unchanged, and the dropdown. The head is swapped
through `populate`'s new optional `embeds` argument rather than by selecting the
engine — tier 1 aborts every `.onnx`, so selecting culico never loads a model and
no posterior could be shaped.

## Verification status

* `npx vitest run` — 133 passed, 7 files.
* `actionlint .github/workflows/pages.yml` — clean.
* `npm run test:all` — typecheck, build and all six new e2e tests pass. Five
  tier1 tests failed in the one full run completed: `reactivity` "selecting a
  photo re-renders without a long blocking task" (also fails on a pristine
  `origin/main` checkout, so pre-existing), plus the shell drop-zone and the
  engine-selector tests, which are timing-sensitive and were still being
  re-run. The box had every CORS-allowlisted port held by another clone for long
  stretches, so several runs never got a server.
