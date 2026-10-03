# Evaluation audit — what our accuracy numbers measure, and what they cannot see

**Date:** 2026-10-03 · **Scope:** methodological audit of how this project evaluates the
mosquito-id head. No expensive re-runs; one small reproduction on cached posteriors. · **Companion
artefacts:** [`92-metrics-in-use.tsv`](./92-metrics-in-use.tsv), [`93-proposed-evaluation.md`](./93-proposed-evaluation.md)

---

## 1. The audit in five lines

The project's *measurement hygiene* is unusually good — uuid-grouped splits with a leak check, a
19.2pp label-provenance spread measured and published, a report that caught its own mistake about
posterior mass and said so. The problem is not discipline. It is **choice of question**.

Every headline number is `argmax over a fixed label set == the manifest label`. That single form
cannot express the three things the product actually does: it **abstains**, it **says "not a
mosquito"**, and it **says genus rather than species 56% of the time**. Those are not corner cases
in this product — abstention is a shipped feature and genus-rank is the majority of the corpus.

**The largest single gap: the risk-coverage curve has never been computed for the model that
ships.** The confidence gate `SPECIES_CONFIDENCE_FLOOR = 0.373` was fitted on the **zero-shot
head** (`41-calibration/41-calibration.md`), and the linear probe now replaces that head. The
gate constant and the model have diverged, and nothing in the tree would notice, because
risk-coverage is the only metric that would.

---

## 2. Phase 1 — the design I would have written before reading anything

Written first, deliberately unanchored on what the project does. Then compared against it.

**The product.** One phone photo, possibly a crop. Output is one of: species, genus, "not a
mosquito", "not confident". A user is not asking "what class did the argmax land in". They are
asking "can I trust this name, and how wrong would it be if I'm wrong".

**So the metric set I would reach for, in priority order:**

1. **Risk-coverage (selective accuracy vs coverage).** The decision *is* argmax-plus-abstain.
   A rule that declines to answer has no accuracy; it has a coverage and a risk. Report the whole
   curve; report risk at whatever coverage the product actually ships.
2. **Macro-F1 and per-class recall beside every accuracy.** With A. koreicus at 23 of 552 test
   rows, plain accuracy is a statement about A. aegypti.
3. **A cost-weighted error taxonomy, not a scalar.** Calling a midge *Culex pipiens* is a
   different failure from calling *Ae. koreicus* *Ae. aegypti* — different rank, different
   consequence. Report the confusion structure; let the product decide the weights.
4. **Calibration as per-class reliability + Brier**, not one pooled ECE.
5. **AUC for the ranking itself** (mosquito-vs-not, and confidence-vs-correct), because it is the
   only threshold-free statement about whether a gate is even worth fitting.
6. **Error rate among *confidently answered* species names** — the shipped gate exists to move
   this, so it should be a named metric with its own row in the table.

**What I would refuse to quote alone:** top-1 accuracy without a tier mix; any accuracy on the
species head over a test set that is 56% genus-rank; macro-F1 on the 16-way head while 12 of its
classes have zero rows.

---

## 3. Phase 2 — what we actually do, and the comparison

Full per-metric table with the adversarial column: [`92-metrics-in-use.tsv`](./92-metrics-in-use.tsv).
Headline agreements and gaps:

| | verdict |
|---|---|
| uuid-grouped split with explicit leak check | **Keep.** The best methodology in the project. `group_key` leak (47 rows, 3.7%) was found and fixed; `uuid_split.py` is correct. |
| Label-provenance tiering, published | **Keep, and promote.** 91.9 / 72.7 / 97.0 / 95.4 is the most informative table in the tree. |
| Macro-F1 + balanced accuracy beside accuracy | **Keep.** Added in `96`, correctly. |
| Top-1 accuracy as the headline | **Demote.** It is a component, not a verdict. |
| ECE as the calibration measure | **Replace** with per-class reliability + Brier. |
| Risk-coverage | **Compute and make primary.** Currently absent for the shipping model. |
| Non-mosquito detection at fixed FN budget | **Best metric in the table, wrong negatives.** |

### Where accuracy is *actively* misleading here

**It is two tasks averaged.** 3,507 of 6,264 rows (56%) carry a genus-rank label. `96` scores the
full 24-way head by **collapsing both sides to genus** — a defensible move, stated — but the
resulting 89.5% "accuracy" is a number about a task the product only performs sometimes, and it
is published next to the species number with no marker distinguishing them.

**The genus margin is decorative.** I reproduced the decomposition on the species-4 test set:
483/552 correct species, 69 wrong species with the **right genus, 0 wrong genus entirely**. The
genus margin on that task is identically 100% — it carries no information, because all four
classes are Aedes. Reporting "genus is right on 100% of species-4 rows" would be true and
worthless. The four-way-vs-sixteen-way problem is real, and on the *current* species task it is
degenerate.

**Confidence does not know about label quality.** Mean max-posterior is 0.899 on rows we get
right and 0.642 on rows we get wrong — the signal is real (AUROC 0.882). But it does not separate
label tiers, and neither does any gate:

| tier | n | acc @100% cov | acc @90% cov | acc @70% cov |
|---|---:|---:|---:|---:|
| `expert_confirmed` | 86 | 0.919 | 0.961 | 0.983 |
| `expert_probable` | 183 | **0.727** | **0.770** | **0.844** |
| `ai_ai` | 66 | 0.970 | 1.000 | 1.000 |
| `research_grade` | 209 | 0.967 | 0.989 | 1.000 |

The 19.2pp expert-confirmed/probable gap **survives the gate almost intact**. A confidence gate
buys accuracy against the model's own errors; it cannot buy accuracy against label noise. That is
the honest ceiling on this axis, and no threshold work will move it.

**The gate sheds the hard classes, and no report in the tree records that.** At the 90%-coverage
threshold, the drop rate is wildly non-uniform across classes (χ²(drop ~ class, df=3) = **46.6**,
p ≪ 0.05):

| class | n | dropped @90% cov | recall @100% | recall @90% |
|---|---:|---:|---:|---:|
| A. aegypti | 290 | 5.5% | 0.966 | — |
| A. albopictus | 131 | 6.9% | 0.832 | — |
| A. japonicus | 108 | **19.4%** | 0.815 | — |
| **A. koreicus** | **23** | **43.5%** | 0.261 | 0.174 |

Koreicus loses 43.5% of its rows to the gate against a 10.1% global rate. The *mechanism* is good
news — the gate is doing its job, concentrating abstention on rows the model is unsure about, and
8 of the 10 koreicus rows it drops were already wrong. **The headline recall barely moves (0.261 →
0.174) because n=23 makes that a two-row difference**, which is a reminder that per-class recall at
this n is not a reportable quantity.

The finding that matters is the **exposure asymmetry**: a gate tuned on pooled accuracy offers
japonicus and koreicus users a materially different product than it offers aegypti users, and the
pooled curve is blind to it. This is a distributional-equity property of the shipped gate, and
nothing in the tree would surface it. See the correction in §6 — I initially overstated this as a
recall effect and the adversarial pass caught it.

### AUC vs accuracy — the honest answer to the question

Cornelius asked "AUC, why not? Why accuracy?" The answer is that **both are already used and they
are answering different questions**:

- **Accuracy** is used for the 4-way/16-way species and genus tasks, where the decision is a
  single label and there is a true label to compare to. AUC is *not* meaningful there: one-vs-rest
  AUC over 4 classes of wildly unequal size rewards ranking that accuracy would call identical.
  On this task accuracy is the right family of metric.
- **AUC is used correctly where it belongs** — `37-non-mosquito` (0.9657 shipped / 0.9906 fitted)
  and the aegypti–albopictus pair (0.978). Both are ranking questions, both are threshold-free,
  both are the correct tool.
- **The missing third metric is the one that matters most.** Neither accuracy nor AUC measures
  *"given the app answers, how often is it wrong"* — that is risk-coverage, and it is the only one
  of the three that matches the shipped gate's actual job.

`41-calibration/41-calibration.md` is a good example of a metric being correctly rejected: it
proves **temperature cannot change a single argmax**, so CV-fitting NLL to 2.172 was tuning a
knob with no effect on output. That is NLL used on a decision that has no decision in it. The
lesson generalises — pick the metric that matches the decision, not the one that is most rigorous.

### The four-way-vs-sixteen-way problem

Most metrics are computed by **marginalising species posteriors to genus**. That is an operation
on the model, not on the task. What is measured directly against a species label set:

- `97-relabel/93-eval-report.json` — the **only** directly species-rank evaluation, and only
  because a companion agent relabelled 640 rows: n=680 test, 85.6% acc / 75.3 macro-F1 /
  74.2 balanced, six classes.
- `96` scores the shipped 16-way head by collapsing to genus, and says so.

So the answer to "what is measured directly against a species label set" is: **almost nothing, and
it is six classes wide.** Twelve of the sixteen have zero species-rank rows in the corpus.

---

## 4. Phase 3 — the ground-truth question (Cornelius's framing)

**The genus ceiling is a property of how we harvested, not of what Mosquito Alert records.** MA's
`species_label` in *our manifest* says `Culiseta`; MA's own `ma_taxon_name` says *Culiseta
annulata* on 742 rows and *C. longiareolata* on 311. The companion agent's relabel has landed
(`97-relabel`): 640 rows relabelled, zero downloads, and the species task grew from 4 classes to
6.

### What the relabel resolves, and its ceiling

**Resolves:** four of the twelve missing species gain rows; the species task is no longer
all-Aedes; `97-relabel` is now the only directly species-rank evaluation in the project, with a
macro-F1 and balanced accuracy that move 3–6pp once Culiseta enters. Cost: zero network.

**Does not resolve, and it is important to be exact about this:**

- **It does not touch *Cx. pipiens* or *Cx. quinquefasciatus*.** Neither exists in MA's taxon tree
  (`10-datasource-inventory`: MA runs to 49 *Aedes*, 14 *Anopheles*, 17 *Culex*, 11 *Culiseta*
  species — none of them these two). The two species that matter most for the Basel use case
  cannot come from MA at all.
- **It is not independent ground truth.** It is MA's identification read from a different field of
  the same record by the same experts. It fixes *granularity*, not *provenance*.
- **629 of the 640 relabelled rows are `expert_probable`** — the tier with 72.7% accuracy and a
  19.2pp spread. The new classes arrive pre-loaded with the project's least reliable labels. That
  is a real caveat, and `97-relabel/93-accuracy-by-tier.tsv` does let you see it.

### Independent ground truth — what is genuinely constructible

The `96` report's §4 conclusion ("the adjudication set is the only route to independent ground
truth, and none can be constructed from the corpus") is correct **about that corpus** and wrong as
a general statement. It proved no specimen appears in both GBIF and MA, so there is no cross-source
conflict to mine. That is a fact about what we already hold, not about what exists.

Four candidate sources, with genuinely different failure modes:

| source | label quality | domain match | independence | volume for our 12 |
|---|---|---|---|---|
| **iNaturalist research grade** | community consensus (2 agreeing IDs, or 1 curator/organisation ID) | **phone photos, wild insects — exact match** | **high** — no shared pipeline with MA or with our models | **6,181** RG observations |
| **Observation.org** | community, European, every record species-rank | phone photos | high | **966** media, incl. *Cx. pipiens* 212 |
| **GBIF expert-curated (museum, e.g. NMNH)** | curatorial-grade | **poor** — mostly pinned/barcoded specimens | very high | 7,433 media, ~5,900 in-domain |
| **BOLD barcodes** | COI-sequenced, effectively authoritative | **poor** — specimen photography | very high | content already inside BIOSCAN-5M; own API unreachable from here |

The two are not substitutes and must not be pooled. iNaturalist RG is the **only** source that
matches the deployment domain *and* is independent; its weakness is community consensus, which
errs in a known direction (popular species accumulate agreeing-but-wrong IDs — the GBIF
albopictus-in-aegypti contamination is 4–8% by prior estimate, unmeasured at scale). Museum and
BOLD records are taxonomically *stronger* but photograph pinned or sequenced specimens, which the
project has already measured as non-transferring (BIOSCAN and MosquitoDL both "wrong domain").

**The key separation, and the one that resolves Cornelius's worry:** an evaluation set does not
have to be production-representative to be useful — it has to answer the question asked of it.

- *Can it distinguish pipiens from quinquefasciatus at all?* → a verified **museum** image of
  *C. pipiens* is exactly right, and its domain mismatch makes it **more** diagnostic (if the
  representation separates them on a pinned specimen, the information is in the encoder).
- *Will it name a Basel backyard photo correctly?* → only phone-photo RG data answers this, and
  it must be scored separately from the museum set.

A test set that answered both at once would answer neither.

---

## 5. Recommendations

Each carries its counter-argument, because a recommendation without one is not finished.

### R1 — Make risk-coverage the headline, stratified per class

Ship the full curve (coverage → risk among answered) for whatever model actually ships, and
report it **per class and per label tier**, not just pooled.

*Already measured here, on the species-4 probe (n=552):* risk 0.125 at 100% coverage, 0.079 at
90%, 0.048 at 80%, 0.007 at 50%, 0.000 at 30%. AUROC of max-probability vs correctness is 0.882 —
low enough that no gate gets to zero error at useful coverage, which is the honest headline.
Reproduce with `risk_coverage.py` in this directory.

**Revised per the adversarial pass (A2):** stratify per class only where n ≥ 100. For n < 100
report the **drop-rate asymmetry** — a stable statistic — not a per-class curve. See §3.

**Counter-argument:** risk-coverage on a 552-row test set with a 23-row koreicus class has wide
error bars at low coverage (0/166 correct is CI-upper 7.6%). A curve this sample-poor invites
over-fitting the operating point to noise — and `41-calibration` §4 already found ~a quarter of
achievable recall lost in val→test threshold transfer. **This is why R1 must come with more val
rows before any new gate constant is fitted**, and why the existing 0.373 must not be re-fitted on
the probe until then.

### R2 — Re-fit or retire the shipped confidence gate

`SPECIES_CONFIDENCE_FLOOR = 0.373` was fitted on the zero-shot head. The probe that replaced it
has a different confidence distribution. Either re-fit on val with the new head, or state
explicitly that the constant is inherited and unvalidated.

**Counter-argument:** re-fitting needs the H/14 backbone runnable, which `41-calibration` §7 says
is not reachable in this container (`torch`/`onnxruntime` absent, no fp32 H/14 ONNX). This may be
blocked on environment, not on method — in which case the honest deliverable is a documented
"unvalidated constant", not a new number.

### R3 — Never quote an accuracy without its tier mix and n

Make it a hard rule for the results table: `acc | macro-F1 | balanced acc | n | tier mix | task`.

**Counter-argument:** this is a reporting convention, not a measurement improvement, and it will
make every table in the project longer. True — and the 19.2pp spread is already published, so the
cost is only typographical.

### R4 — DROPPED (was: replace pooled ECE with per-class reliability + Brier)

One ECE over a 4-way task with a 23-row class is not interpretable, which is true and not worth
acting on. Brier is a proper scoring rule, and ECE at T=2.5 is already 0.0486 — comfortably
good. Adding a second calibration metric is reporting theatre on a task whose calibration is not
the problem. **The calibration problem here is not ECE, it is coverage.**

The adversarial pass in §6 is stronger than the counter-argument I originally attached: *recommending
a metric change while conceding it buys nothing is incoherent.* This recommendation is withdrawn
rather than demoted. It survives only as a note in `93-proposed-evaluation.md` §6.

### R5 — Build an independent, domain-matched species-rank test set

iNaturalist research grade (6,181 obs) + Observation.org (966 media), pulled **only for species we
lack**, deduplicated on content hash against the manifest, scored **separately** from MA rows and
never pooled into the headline.

**Counter-argument — and this is the strongest objection in the audit.** iNat RG is *community*
consensus, and the `96` report's own tiers show community-verified labels are not benign
(`research_grade` rows score 95.4–96.7%, which is high, but that is measured against the label,
not against truth). Adding RG rows with their own ~5–10% error rate to a corpus whose measured
problem is a 19.2pp label-quality spread **adds the same disease**. RG data is excellent for
*training and for closing coverage gaps*; as a **test set** it is a second opinion, not ground
truth. The genuinely independent test set remains the **90-row human adjudication set**
(`96/93-adjudication-set/`) — and it is still unjudged, which makes it the highest-value unfinished
item in the entire project, worth more than any metric swap proposed here.

### R6 — Separate museum/BOLD sets from phone-photo sets

A verified pinned *C. pipiens* answers "can the encoder separate this at all"; it does not answer
"will it work on a phone photo". Keep them in separate sets with separate claims.

**Counter-argument:** adding a pinned-specimen set risks being read as a species-rank accuracy
headline, and pinned-specimen accuracy is known not to transfer — `10-datasource-inventory`
already records this for BIOSCAN and MosquitoDL. There is a real risk of creating a misleading
second headline. Mitigation is naming, not measurement: the set must be called
*discriminability*, never *accuracy*.

### What I would not change

Top-1 accuracy stays, as a component. The uuid split stays. Tier stratification stays. The
`41-calibration` temperature analysis is exactly right. The `96` provenance work is the strongest
piece of measurement in the project and the model for how the rest should be reported.

**And the single highest-value action is not a metric.** It is judging the 90-row adjudication
set. Every number in this project is agreement with a label; the adjudication set is the only
artefact in the tree that can convert one into an accuracy.

---

## 6. Adversarial review — the case against this audit

I wrote §1–§5 and then went back to attack them. Three of my own claims did not survive, and one
of my recommendations is probably the wrong priority. The corrections are integrated above; the
case is recorded here because an audit that only lists agreement with itself is not an audit.

### A1 — I overstated the koreicus finding, and the correction is load-bearing

**What I originally wrote:** the gate drops koreicus, koreicus recall falls 0.261 → 0.174, "a new
finding; no report in the tree computes it."

**The attack:** n=23. 0.261 of 23 is 6 rows; 0.174 is 4 rows. **That is a two-row difference**,
and reporting a per-class recall shift of 8.7pp from two rows is exactly the error I criticised
`41-calibration` §6 for committing with its `DELTA` result ("four rows out of 82 is the entire
difference... not a rate any reader should act on"). I had held a 4-row effect to be
non-shippable and then shipped a 2-row effect as a headline finding.

**What survives, verified:** the **drop-rate** asymmetry is real and large — χ² = 46.6, df=3 —
with koreicus at 43.5% dropped versus 10.1% globally. The finding is about *exposure*, not
*recall*, and it is a better result than the one I claimed, because it is robust where the recall
number was not. The mechanism is favourable too: the gate concentrates abstention on rows the model
genuinely finds hard.

**The general lesson, which I should have applied to myself:** I introduced a metric change, found
a striking number, and reached for a causal story before running the test that would have told me
whether the number was 2 rows or a structural effect. The audit's own subject matter is
small-n discipline. I committed the error I was auditing.

### A2 — My proposed stratification is partly uncomputable

**R1 mandates risk-coverage stratified per class.** The same audit reports that koreicus has n=23
and that per-class recall at that n is not reportable. Per-class risk-coverage on a 23-row class
has the same problem — a curve whose points are 23 Bernoulli draws.

**The fix, and the honest version of R1:** stratify per class only where n supports it, and
mandatory per class for any class with n ≥ 100 (aegypti, albopictus, japonicus, and post-relabel
*C. annulata*). For n < 100, report the **drop-rate asymmetry** (§3), which is a stable
single-number statistic, instead of a per-class curve. Reporting what is computable beats
mandating what is not.

### A3 — I may have the priorities backwards

**The strongest objection to this entire audit:** the gap I call largest — no risk-coverage for
the shipping model — is a *reporting* gap on a metric already computed for the head that shipped.
Meanwhile `97-relabel` has just handed the project a genuine species-rank evaluation for the
first time (n=680, six classes, macro-F1 75.3), and **10-datasource-inventory** lists thousands
of uncollected rows against a label base that is 50.3% unverified.

If the binding constraint is label quality, then the highest-value action is **data and
verification**, not metric choice. On that reading this audit is a well-argued note about the
second-order problem, filed while the first-order problem is untouched.

**Where I think the objection is wrong, and where I am not:** it is right about sequencing — the
adjudication set and iNat/Observation.org pulls come first, and §8 orders them that way. It is
wrong that metric work is worthless meanwhile: the stratified drop-rate result (A1) is a
*distributional property of the shipped gate* that nobody would have found without doing this, and
it is cheap (minutes, on cached posteriors). But I concede the audit would be a lower priority
still if the 90-row adjudication set had been judged.

### A4 — The counter-arguments I attached to my own recommendations are the weakest part

R4's counter-argument ("calibration is not the problem") is strong enough that R4 should probably
be dropped rather than demoted — recommending a metric change while conceding it buys nothing is
incoherent. And several counter-arguments in `92-metrics-in-use.tsv` argue that a metric is
"correct and load-bearing" — i.e. I list the metric as fine while filing it under "what our
metrics fail to see". That column conflates *the metric is wrong* with *the metric is under-used*,
and a reader cannot tell which is which.

**What I did not do:** find an independent reviewer. I attacked myself, and I am not an
independent reviewer — I chose the framing, the reproduction, and the order of the recommendations.
The specific failure mode that survives self-review is **selection of the interesting finding**:
I computed one reproduction and it produced one striking number, which I then built a section
around. A real reviewer would ask what else those 552 posteriors show that I did not go looking
for, and I have no way to know whether I looked.

### A5 — What would make me drop the whole framing

If the product decision is "always show the top species, never abstain" — the shipped behaviour —
then risk-coverage measures a capability nobody intends to use, and R1/R2 are solving for a
requirement that does not exist. The `0.373` gate exists and `41-calibration` recommends shipping
it, so abstention **is** intended. But it is worth naming that the entire case for risk-coverage
rests on a product choice that is Cornelius's to confirm, not a statistical finding.