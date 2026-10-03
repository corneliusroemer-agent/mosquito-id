# Report granularity — behavioural spec

What the app is allowed to *name*, per model, and what it prints in each case.

Every rule here is stated so a test can check it. `tests/report-granularity.test.ts`
and `e2e/tier1/report-granularity.spec.ts` encode the tables below as assertions;
a change that breaks a rule here fails those tests rather than passing review.

## 0. Where the fact comes from

A head (`public/text_embeds*.json`) gives each species one weight row. Where two
species' rows are **byte-identical**, the model cannot separate them: for any
photo the two logits are the same number, so the two posteriors are the same
number, and the tie breaks on list order. That is not a threshold that can be
tuned; it is a property of the weights.

**R0.1 The grouping is DERIVED from the loaded head, never hardcoded.**
`resolvableGroups(head)` compares the rows and returns one entry per set of
species the head cannot tell apart. A refit that separates them removes the
groups with no code change. Hardcoding the four culico groups would keep the app
claiming a genus limitation for a head that no longer has one, which is the same
class of defect as the one this is fixing.

**R0.2 The grouping test is exact float equality, and that is the right test.**
A near-duplicate test (cosine > 0.999) would group rows that differ in the last
bits, and two rows that differ are two rows the model *can* tell apart — a
soft threshold would suppress a name the model actually supports, which is the
same failure as naming one it does not. Exact equality degrades the safe way: a
head with merely similar rows yields no groups, every species is its own group,
and the app reports species everywhere. The rows in the shipped culico head are
genuinely bit-identical (verified by hashing each row), so the test that fits
this head exactly is the same one that fits the refit.

**R0.3 The result is cached per head object.** The head is reloaded on an engine
switch; the grouping is pure in the head, so it is computed once per loaded head
and never recomputed per photo.

**R0.4 What is reported is what the head supports, and the head wins.** The
capability in `ModelConfig` (`reports: "species" | "genus"`) exists so the engine
dropdown can say "genus only" *before* that engine's head has been fetched. Once
the head is loaded, the derived grouping is authoritative for what the app
prints. `tests/report-granularity.test.ts` asserts the two agree for every engine
that has a shipped head, so a refit that changes an engine's capability fails a
test instead of quietly leaving a stale label in the dropdown.

## 1. What a species is named as

`resolvableGroups` entries render in ONE format everywhere — the sentence box, the
score list, the results table and the CSV:

```
Aedes (vexans / geniculatus / cinereus not separable)
```

**R1.1 A species that belongs to a multi-member group is never printed as a bare
binomial.** Not in the sentence, not as a ranking row, not in the table, not in
the CSV. The phrase is a *class*, and every place that would have named one of its
members prints the phrase instead. Asserted on the rendered string, not on an
intermediate value, because the defect this prevents was a name appearing in
prose that no intermediate ever held.

**R1.2 The epithets are the species' own names without the genus**, matching how
the existing genus sentence shortens a binomial ("Definitely Aedes - most likely
albopictus").

**R1.3 A species whose group has one member is named normally** — binomial, guide
link, common name, exactly as before. Groups of one are not "unresolvable groups
with one member"; they are not groups at all, and must not print the phrase.

**R1.4 A head with no multi-member group prints exactly what it printed before.**
Every rule below is written so that the H/14 and B/16 heads — all 16 rows distinct
in both — fall through to the previous behaviour byte for byte. This is the
regression guard for the refit: if it lands and the heads are still distinct, no
test changes and no output changes.

## 2. The score panel sentence (`#score-uncertain`)

The box has a reserved height and is toggled by visibility, so every row of this
table is layout-neutral.

**R2.1 The sentence is empty exactly when the app names a species.** In the
species state the ranking below already names it in full, with its common name and
its guide link, and a second copy above it says nothing the ranking does not. The
box's existing 44 px is spent on the cases where the ranking does *not* say what
the app claims.

**R2.2 The app's claim, per state.** `T` is the verdict's top species and `G` its
group.

| `verdict.state` | `T` | Sentence printed | Why |
| --- | --- | --- | --- |
| `species` | singleton | *(empty)* | The ranking's top row is the claim (R2.1) |
| `species` | multi-member | `Aedes (vexans / geniculatus / cinereus not separable)` | A confident posterior the model cannot spend on one species |
| `genus` | singleton | `Definitely Aedes - most likely albopictus, possibly aegypti or japonicus` | The floor declined a species; the genus is the claim |
| `genus` | multi-member | `Aedes (vexans / geniculatus / cinereus not separable)` | Same as above — naming the genus plus why it stops there |
| `unsure` | — | `Not confident enough to name a genus` | Unchanged |
| `non-mosquito` | — | `This does not look like a mosquito - it looks like midge (93% of the match)` | Unchanged |

**R2.3 The wording is the same shape for every photo.** A reader who sees a genus
on one photo and a species on another can tell from the text alone which case each
is in, without knowing which engine is loaded or what the app's floors are. The
phrase in the `multi-member` rows is the whole explanation: it does not say "low
confidence", and it is not a hedge.

**R2.4 A runner-up the model cannot separate is dropped from the "possibly" list.**
`Definitely Aedes - most likely albopictus, possibly vexans or geniculatus` is a
sentence naming two species that are the same classifier output. Where the
leader's group is a singleton the list is rebuilt from the runners-up that are
individually namable; if that leaves none, the sentence drops the clause
entirely (`Definitely Aedes - most likely albopictus`) rather than filling it with
a species the head cannot resolve.

**R2.5 The pooled card's sentence follows the same rules.** It is the same
function over a `pooledVerdict`, which has no `runnersUp`; every state above still
applies.

## 3. The score list

**R3.1 Species in the same multi-member group are ONE row**, labelled with the
group phrase (R1.1) and carrying one percentage. A ranking that lists three
identical bars under three different names is a ranking that asserts the model
distinguished them. The percentage shown is the largest among the members' — they
are equal by construction (identical rows, and the per-genus cosine offset is
per genus, so members of one group always share it), and reading it as "the
class's score" is correct either way.

**R3.2 Rows for singleton species are unchanged** — same markup, same order, same
guide link, same common name.

**R3.3 Row order is unchanged.** Rows are ordered by the score of their class's
best member, descending; the rows the app would have shown keep their relative
order.

**R3.4 The non-mosquito row is unaffected.** A photo called not-a-mosquito shows
the adjacent class, not a species group, and hides the species rows below it.

## 4. The results table and the CSV

**R4.1 The "Top Species" cell carries the app's claim, at the app's granularity.**
A group phrase where the leader is unresolvable, the bare binomial where it is
not, and `Aedes (genus only)` / `Not confident` in the coarser verdict states as
before.

**R4.2 The CSV carries the same string as the table.** The export exists so a
photo the app would not name cannot leave the machine looking named, and the
grouping is part of what the app declines to name.

**R4.3 The percentage column is unchanged.** It is the top species' score, which
is the same number as the group class's score (R3.1).

## 5. The engine dropdown

**R5.1 The dropdown says what the engine reports, before the engine is chosen.**
The option reads `⚡ culico-net-cls-v1 (experimental · 81 MB · genus only)`. It
keeps "experimental", and it is set at runtime from `ModelConfig` so the label
has one source.

**R5.2 No header caveat.** There is no `#engine-caveat` and nothing is added above
the content: that block moved the page (0.27 CLS on desktop) and has been
rejected twice. The dropdown is where an engine is chosen, so it is where the
limitation is read. `e2e/culico-engine.spec.ts` asserts the element's absence.

**R5.3 No animated or transitional UI is added.** The score list changes the
number of rows it draws, which is content, not motion.

## 6. What is NOT here

- **The head is not fixed.** `public/text_embeds_culico.json` is what it is; the
  refit is separate work. Nothing in this document asks for a re-export.
- **No threshold is added.** Whether the app names a species is still the floors'
  decision; this only removes names the head cannot support from a claim that
  already passed them.
- **The pooled card's own markup** (`src/app/poolingPanel.ts`) is unchanged: it
  renders candidate names through `speciesLabelHtml`, which now knows the groups,
  so its rows are correct without a change there.
