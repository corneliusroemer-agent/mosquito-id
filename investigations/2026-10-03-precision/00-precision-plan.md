# Mosquito ID: what would actually make it identify more species and be right more often

Built 2026-10-03. Question: given the model is **frozen** and everything up to step 4 runs
**CPU-only**, what is the cheapest, highest-value change?

**How to read this.** Every number is either *measured* — produced by re-running the project's
own harness (`investigations/2026-10-02-mosquito-id/04-local-models/`, `07-benchmark/`) or by
operating on embeddings it had already computed — or *plausible*, and labelled as such.
Nothing is from literature. Scripts are in numbered subdirectories and re-runnable.

**The short answer.** The model is not the main problem, and neither are the labels. Three
findings reorder the priorities:

1. **The albopictus/japonicus confusion that dominates the error list is a readout failure,
   not a representation failure** — a linear probe separates those two at 94% from the very
   same frozen embedding. A small trained head fixes it, on CPU, in seconds.
2. **Adding species labels to the zero-shot prompt set buys nothing** — measured across 17
   candidate species, zero previously-correct predictions change and zero new labels ever win
   on real photos. This answers "can we just add more labels?" with a measured no.
3. **Fusing several photos of the same mosquito is worth +4.5 points** (84.8% → 89.3%) and
   the view-agreement signal separates accuracy 0.943 from 0.500. Bigger than any head.

Alongside those: the shipped confidences are **overconfident by ~9 points** and one constant
fixes that (T = 2.5), and **aegypti is a genuine representation ceiling** that no head can fix.

---

## Part 1 — What the current pipeline actually does

You asked for the machinery, not the entomology.

**Stage 1 — detector.** A YOLO11n object detector (`culico-net-det-v1-nano`) runs on the
whole photo at `imgsz=1600`, default confidence 0.25, and takes the **highest-confidence
box**. That box is cropped out. If no box is found the whole photo is used instead. In
`main.js` the app additionally prefers a *larger box that contains ≥90% of the best box* and
has ≥2× its area — a policy that is **not** the one the 84.8% benchmark was measured with.

**Stage 2 — precomputed text embeddings.** BioCLIP 2.5 ViT-H/14 is a dual-encoder CLIP. The
*text* tower is run **offline, once**, over 16 species names × 3 prompt templates
(`"a photograph of {}."`, `"a mosquito of the species {}."`, `"{}, family Culicidae."`). The
three vectors per species are averaged and L2-normalised; the 8 nuisance prompts ("a person",
"a wall", "an empty background", …) get one vector each. Everything lands in
`text_embeds.json`: 16 × 1024 + 8 × 1024 floats, plus `logit_scale = 98.86`.

**Why offline.** This is what makes a browser app possible. The text tower never ships; only
the image tower (ONNX, via onnxruntime-web) and this 546 KB JSON of precomputed vectors.
**The model cannot name anything that is not already in that JSON** — adding a species means
running the text tower once and regenerating the file, which takes seconds on a machine with
the weights.

**Stage 3 — runtime scoring.** For one photo: image tower → 1024-d vector → L2-normalised →
cosine against all 24 vectors → multiply by `logit_scale` → softmax jointly over 16 species
**and** 8 nuisance classes. The 8 nuisance prompts are what make the "this crop is a wall"
gate work. The per-species probabilities that reach the UI are **marginals after softmax over
a joint distribution** — they sum to 1 across species *and* nuisance.

**What the softmax-over-cosine is not.** It is not a probability that the mosquito is species
X. It is a normalised similarity. Three consequences, all measured below: it is
**overconfident** (0.940 mean confidence against 0.848 accuracy), it is **not comparable
across different label sets** (adding a label shrinks every other label's mass — top-3 drops
from 0.938 to 0.920 when 17 labels are added), and it is **not a posterior over specimens**,
which is why pooling several photos with it is unsafe.

**Where the design is weak, in order of how much it costs:**
- **aegypti vs albopictus is not resolvable in this embedding** (measured: probe recall 0.167).
  No amount of label work or head-training changes that.
- **Zero-shot confidences are uncalibrated** and overstate certainty by ~9 points.
- **Priors and pooling are not in the model at all.** The current pooling is a correlation
  heuristic with an assumed ρ = 0.5 and no empirical basis; measured ρ is 0.5–0.76 depending
  on view type.
- **The label set is a European artefact** and the training signal that exists (Mosquito Alert
  train) has only 6 classes.

---

## Part 2 — The measured findings

### 2.1 Calibration: the confidences are wrong, and one constant fixes it

Measured on the 112 held-out Mosquito Alert crops (`01-analysis/probe.py`, `temp_study.py`):

| | NLL ↓ | ECE ↓ | mean confidence | accuracy |
|---|---|---|---|---|
| as shipped (T=1) | 0.966 | 0.118 | 0.940 | 0.848 |
| **T=2.5** | **0.595** | **0.067** | ~0.85 | 0.848 |

The app shows a 94% number for an 85%-accurate model. **T = 2.5 cuts NLL by a third and
roughly halves ECE, with zero change to top-1** (temperature is monotone, so it cannot
reorder predictions — it buys honesty, not accuracy).

**The trap, and why the shipped value is hand-set rather than fitted.** When I fit T by
5-fold cross-validation (fit on 4 folds, apply to the 5th), *every fold independently chose
T ≈ 8.7* — and held-out NLL got **worse**, 2.172 versus 0.966 at T=1. The in-sample optimum
is ~2.5; the cross-validated optimum is ~8.7 and is simply wrong. At n=112 the temperature is
not identifiable.

> **Production value: T = 2.5, hardcoded, never fitted at runtime.** The evidence is the
> in-sample optimum (2.0–3.0, NLL 0.595 at 2.5 against 0.966 at T=1) combined with the
> measured failure of CV fitting at this sample size. A calibration constant in shipped code
> needs stated provenance precisely because someone will otherwise try to "fix" it by fitting.

### 2.2 Representation or readout? The experiment that partitions the problem

Leave-one-out linear probe on the frozen embedding, 112 images, no extra data
(`01-analysis/transfer_test.py`):

| pair | n | LOO probe accuracy |
|---|---|---|
| albopictus vs japonicus-koreicus | 50 | **0.940** |
| culex vs culiseta | 50 | 0.920 |
| culex vs albopictus | 56 | 0.982 |
| culiseta vs albopictus | 50 | 0.980 |
| anopheles vs albopictus | 34 | 0.941 |
| albopictus vs aegypti | 34 | 0.882 |
| aegypti vs japonicus-koreicus | 28 | **0.786** |

Full 6-class LOO probe: **86.6% top-1**, against 84.8% zero-shot. Per-class recall:

| class | probe LOO recall | n |
|---|---|---|
| albopictus | 1.000 | 28 |
| culex | 1.000 | 28 |
| japonicus-koreicus | 0.864 | 22 |
| culiseta | 0.818 | 22 |
| anopheles | 0.500 | 6 |
| **aegypti** | **0.167** | 6 |

**This is the key result of the investigation.** Zero-shot's dominant error is
japonicus-koreicus → albopictus (3 of its 8 top-1 errors). The embedding separates those two
at 94%. So that confusion is a **readout** failure: the text prompts for the two species sit
too close together in text space for cosine to resolve them. **A trained head fixes it, on
CPU, for free.**

aegypti is categorically different. Probe recall 0.167, and it separates from albopictus at
only 0.882. **The embedding does not contain reliable aegypti-vs-albopictus information.**
A linear probe cannot manufacture signal that isn't there. No ensemble over this embedding
will help either. Only a different or fine-tuned tower will (Part 4.4).

This also explains the handoff's warning that adding labels may *lower* accuracy across the
board: for Stegomyia, it would.

### 2.3 "Can we just add more labels?" — measured: no

I encoded 17 candidate species with the same frozen text tower and same three templates,
spliced each into the 16-label softmax, and re-scored the 112 (`03-ladder/label_addition.py`).
No new image inference was needed.

| added label | top-1 | top-3 | correct preds flipped | new label ever top-1 |
|---|---|---|---|---|
| *Anopheles gambiae* | 0.848 (+0.000) | 0.929 (−0.009) | **0** | 0 / 112 |
| *Anopheles sinensis* | 0.848 (+0.000) | 0.938 (0.000) | **0** | 0 / 112 |
| *Culex tritaeniorhynchus* | 0.848 (+0.000) | 0.938 (0.000) | **0** | 0 / 112 |
| *Aedes dorsalis* | 0.848 (+0.000) | 0.938 (0.000) | **0** | 0 / 112 |
| *Aedes stephensi* / *caspius* / *detritus* / *rusticus* / *triseriatus*, *Culex maculatus* / *modestus*, *Culiseta silvatica*, *Ochlerotatus triseriatus* | 0.848 (+0.000) | 0.929–0.938 | **0** | 0–1 / 112 |
| tier: +6 European-absent | 0.848 (+0.000) | 0.938 (0.000) | **0** | 0 / 112 |
| tier: +17 everything | 0.848 (+0.000) | 0.920 (−0.018) | **0** | 4 / 112 |

**Adding a label is safe but inert.** Nothing that was right gets flipped, so it is not
dangerous — but it also does not help. Top-3 *degrades* as labels accumulate, because every
extra class dilutes the softmax denominator.

The reason is structural: a text embedding for a species the frozen tower was never grounded
on carries no discriminative information about that species' *appearance*. The one label that
does move is *Aedes koreicus* — which the model already has, and which takes argmax 3× when
added as a duplicate, consistent with 07's finding that Stegomyia confusions are group-level.

**Which labels are safe to add, and how to test rather than assume.** The rule that follows
from this: **a label may be added if and only if it wins argmax on photos of that species.**
Not "seems visually distinct" — measured. The test is cheap and I have not been able to run
it, because it needs tropical positives that don't exist in the benchmark:

> For each candidate species, gather ≥30 photos of *that species* from a source with
> species-level labels (GBIF has 162 *Anopheles* and 21 *Culiseta* species under CC0/CC-BY;
> iNaturalist has 24 and 11 respectively under CC-BY/CC0 — Part 3.4). Add the label, then
> measure: what fraction of true positives does it win argmax, and what fraction of *existing*
> European predictions does it steal? Ship the label if it wins often and steals rarely.

Safe to add now, without testing, on structural grounds: **genus-level labels that are already
visually supported** (the app's `COMPLEX_OF` grouping already collapses pipiens/torrentium and
japonicus/koreicus — that grouping is the honest granularity and should stay). Guesswork that
the model cannot support: species-level splits within Stegomyia, and any tropical species
with no training signal. **Do not add ~20 tropical species to make the app look
comprehensive** — measured to be inert at best and top-3-negative at worst.

### 2.4 Multi-view: the largest single win available

07-benchmark embedded each image under four crop renderings (asis / det / segm / gt). Those
are four views of the *same specimen* with posteriors already computed, so view correlation
is measurable at zero cost (`01-analysis/multiview.py`):

| view pair | correlation of correctness | argmax agreement |
|---|---|---|
| det vs segm | 0.763 | 0.902 |
| det vs gt | 0.658 | 0.893 |
| segm vs gt | 0.634 | 0.884 |
| asis vs det | 0.498 | 0.821 |

Equal-weight log-linear pooling over views:

| combination | pooled top-1 |
|---|---|
| det only | 0.848 |
| det + gt | 0.884 |
| **det + gt + asis** | **0.893** |
| det + segm | 0.839 |
| all four | 0.893 |

**+4.5 points from fusing views of the same animal** — larger than any head I measured.

And a free confidence signal: when the det, gt and asis views **agree** (78.6% of specimens),
accuracy is **0.943**. When they **disagree**, accuracy is **0.500**. That is a sharply
separated, honest signal — far more informative than a softmax that reports 94% either way.

**I agree with the handoff that priors and evidence must enter once per specimen, and the
correlation numbers are the reason.** ρ = 0.5–0.76 is not independence. Spearman–Brown: three
views at ρ = 0.66 give reliability 0.852, i.e. **roughly 2 effective independent views out of
3, not 3**. Multiplying three posteriors from one animal treats it as three animals.

**The concrete combiner rule** (implementable as-is):

1. Compute each view's log-posterior over the scored classes. Do **not** multiply raw
   posteriors — that assumes independence and is the overconfidence the handoff warns about.
2. Sum the log-posteriors, then divide by `1 + (n−1)·ρ` where ρ = 0.66 (the measured
   det-vs-gt value). For 3 views of one animal that divides by 2.32, not 3.
3. Apply temperature (T = 2.5) **after** pooling, once, to the pooled log-scores.
4. Apply any geographic prior **once per specimen**, to the pooled vector, not per view.
5. Report the **view agreement fraction** alongside the score, as a confidence signal in its
   own right (§4.2).

This is a Spearman–Brown style discount. It is a defensible heuristic on measured
correlations, not a fitted Bayesian model — and I would rather ship that, clearly labelled,
than a product of posteriors presented as a posterior.

**What this needs, and what it doesn't.** These four renderings are *crop* variants of one
image, which is a weaker perturbation than genuinely different angles (dorsal vs lateral) of
one animal. The measured ρ is therefore a **lower bound on true cross-angle correlation**, and
the discount may be too aggressive when users submit genuinely diverse views. Calibrating it
properly needs paired photos of one specimen — which Mosquito Alert and iNaturalist both
carry and which this benchmark does not. **That is the honest limitation, and it is the one
measurement I could not make.**

### 2.5 Is a probe learning context instead of morphology?

The risk: a probe trained on staged or publication-quality images learns "on a leaf", "on
skin", "blood-engorged or not" rather than anything about the insect. I tested it by training
on one crop pipeline and testing on another — a morphology feature transfers, a context
feature collapses.

| train → test | in-domain | cross-crop | drop |
|---|---|---|---|
| gt crop → det crop | 0.920 | 0.857 | −0.063 |
| det crop → gt crop | 0.946 | 0.884 | −0.062 |
| det crop → asis (whole photo) | 0.848 | 0.812 | −0.036 |
| asis → det crop | 0.893 | 0.848 | −0.045 |

A 3.6–6.3 point drop across a large change in background fraction is modest. Supporting
evidence: same-class det-crop embeddings have mean cosine 0.728 to each other, different-class
0.519 — real class structure, not a shared-context blob.

**What this does and does not establish.** It shows the feature is robust to *crop change*. It
does **not** rule out background *substitution* — a probe could use background cues that
survive re-cropping. The clean test needs the same insect photographed on two backgrounds,
which this benchmark does not contain. So: **the concern is not disproven, only shown not to
be catastrophic.**

The related point in your favour: citizen-science photos are ugly, and their degradation is
the deployment distribution. The gt-crop → det-crop transfer above already shows a probe
trained on tight crops generalises to loose, real ones. Train on the ugly data.

### 2.6 What zero-shot inherits from pretraining

"Leaving it zero-shot" is a choice with known failure modes, not a neutral default. BioCLIP
2.5's pretraining is iNaturalist-scale life-science imagery, which biases towards canonical
poses, staged backgrounds, and a taxonomic long tail. Which of those plausibly hurt here:

- **Taxonomic long tail** — European common species dominate pretraining; this is the most
  likely single cause of *aegypti* failing (an under-represented species in a corpus where
  the abundant Aedes is *albopictus*). Consistent with §2.2.
- **Canonical poses** — citizen photos are dorsal-ventral, oblique, blurred, blood-fed, on
  skin. Pretraining favours the museum shot. The asis-vs-det correlation drop (0.498) is
  consistent with pose sensitivity.
- **Staged backgrounds** — leaves, white sheets, laboratory backdrop. This is the shortcut
  risk in §2.5, and the crop-transfer test says it is not dominant.

A head trained on citizen-science data corrects the taxonomic and pose biases but cannot
correct a missing visual signal (aegypti).

---

## Part 3 — The ladder, ranked

### 3.1 Calibration — do this first, today. Cost: minutes, CPU, no data.

**What it costs.** One constant. **What it needs.** Nothing.
**What it buys.** NLL 0.966 → 0.595, ECE 0.118 → 0.067, mean confidence 0.940 → ~0.85
against 0.848 true accuracy. **Zero accuracy change** — it buys honesty, not accuracy.
**How you'd know it worked.** Reliability diagram flattens; mean reported confidence lands on
mean accuracy. **Ranked first because it is free and it makes every other number in the app
trustworthy** — including the ones a user acts on.

### 3.2 Multinomial logistic regression on frozen embeddings — the big one, and it is cheap.

**How it works.** Keep BioCLIP frozen. Extract its 1024-d image embedding for each training
photo (a single forward pass, ~0.44 s/image CPU). Fit a softmax classifier
`W·z + b → 6 classes` on those vectors with L2 regularisation. At inference the text tower is
no longer needed at all — the head replaces the cosine entirely. Serving cost is *unchanged*;
a 1024×6 weight matrix is 24 KB.

**What the training data must look like.** Many clean labels. The probe learning curve
measured at n=112 (`01-analysis/temp_study.py`): 0.768 at n≈11 → 0.844 at n≈56 → 0.851 at
n≈78, i.e. **it saturates almost immediately and never meaningfully exceeds zero-shot at this
n**. The gain will come from the *full* MA train split, not from the 112.

**The specimen-level split requirement — this is where it goes wrong.** The 112 benchmark
images **are drawn from the MA train split**: all 112 filenames match `annotations.csv`
(verified). Training a probe on that split without excluding them inflates every number.
The rule, stated once and applying to every experiment in this report:

> **Split by report/specimen, never by image.** Several photos of one mosquito, and several
> crops derived from one photo, must all land on the same side of the split. Group key = the
> source observation/report id. Assert that zero groups span train and test, and report group
> count next to image count.

**What it plausibly buys.** §2.2 says the albopictus/japonicus confusion is a readout failure,
so a trained head should fix the single largest error class. Measured LOO at n=112: **86.6%
vs 84.8%** — small at that n, but the learning curve is data-limited, not method-limited.
**Measured, do not expect a large accuracy jump from this alone.** The realistic gain is
japonicus-koreicus/albopictus separation and better *ranking* (top-3 0.938 → 0.950 at C=10).

**Licence flag.** Any head trained on Mosquito Alert carries CC-BY-NC-SA-4.0 obligations
(attribution, non-commercial, share-alike). Per your note, non-commercial is fine — but the
SA obligation and the attribution must be recorded. **Provenance, not a blocker.**

**How you'd know it worked.** Top-1 and top-3 on the held-out 112, with the MA train images
excluded by name, and per-class recall for *japonicus-koreicus* specifically.

### 3.3 kNN / reference gallery — the cheap fallback, and it is not worth it over the head.

Measured on the 112 (`01-analysis/probe.py`): k=1 85.4% / k=3 85.7% / k=5 84.5% / k=15 81.4%
top-1, against 84.8% zero-shot. **No better than the head, and it needs a stored gallery
that grows with the data** — every reference embedding ships to the browser. Superseded by
3.2. Worth keeping only as an explanation tool ("what does the model think this is *near*?").

### 3.4 Swap the image tower for an insect specialist — the licence is fine, the architecture is not.

I had expected the blocker here to be licensing. **It isn't.** Verified by fetching:
`birder-project/vit_b16_ls_franca-bioscan5m` is **Apache-2.0** (weights and code), its training
data BIOSCAN-5M is **CC-BY-3.0**, and the whole org is 89 Apache-2.0 + 9 MIT with zero
non-commercial tags. Full detail in `03-ladder/web-findings.md`.

**The real blocker is architectural.** The model has **no text tower**. Its config is
`task: image_classification` with no text encoder, tokenizer or `encode_text` anywhere in the
641-path repo tree. BIOSCAN's "text" modality is DNA barcodes, not natural language.
**Zero-shot prompting is impossible with it** — it cannot replace the current image tower
without also building a head and a labelled gallery, which is 3.2 on a different backbone.

And its label set, extracted from the species-head pickle: **45 Culicidae species with zero
*Anopheles* and zero *Culiseta*** — two of the six classes uncovered. It is not the route to
many more species.

**Where the species actually are.** GBIF is the better licensing position: taxon 3346
(Culicidae), 114,082 image records, of which **CC0 (47,523) + CC-BY (21,587) = 69,110 are
commercially clean, spanning ≥813 distinct species** across 35 genera — 162 *Anopheles*, 241
*Aedes*, 21 *Culiseta*. iNaturalist has more breadth (2,096 species) but only ~9,000
commercially-clean research-grade photo observations (248 species) because the default photo
licence is CC-BY-NC; the `photo_license` filter is the rescue. **Both are CC0/CC-BY-compatible
and both de-fuse japonicus/koreicus** — GBIF's Mosquito Alert dataset is CC0 and carries
*A. koreicus* as a separate species.

### 3.5 LoRA fine-tune the image tower — the only GPU-requiring step, and probably last.

112 images is nowhere near enough, and the 10k MA train split has only 6 classes with severe
imbalance (albopictus 4612, culex 4563, culiseta 622, japonicus-koreicus 429, anopheles 84,
aegypti 47). Fine-tuning on that teaches the model the six European classes harder — it does
**not** add species, and it will not fix aegypti, because the training data has 47 aegypti
images and they are out-of-region. **Do not do this until 3.2 and 3.6 have been measured.**
See §5.1 for what would actually settle it.

### 3.6 Geographic priors — post-hoc reweighting, once per specimen.

Priors are a real lever and cost nothing at inference: multiply the pooled log-posterior by
a per-species log-prior derived from observer location, **once per specimen** (§2.4 rule 4).
The Basel prior already exists at `03-geographic-prior.md` — *albopictus* and *japonicus*
established, *aegypti* absent within 100 km, *koreicus* introduced and uncertain.

**What it is worth is bounded by §2.2.** For *japonicus vs albopictus* — where the embedding
separates them at 94% and only the readout fails — a prior genuinely helps, because the two
species have very different local abundance. For *aegypti vs albopictus* — where the
embedding has no signal — **a prior is the only thing that can produce the right answer, which
is precisely why a prior must never be allowed to masquerade as a measurement.** Show priors
as a separate, labelled channel in the UI, never folded into the model score.

---

## Part 4 — Two changes to ship now (exact values for the web agent)

I have not edited `main.js` — per instruction these are hand-off values, not a patch.

### 4.1 Temperature

In `softmaxJoint(emb)` the code computes `const sims = spCos.concat(nuCos).map((c) => scale * c);`
with `scale = EMB.logit_scale` = **98.8644790649414**.

**Change: divide by temperature instead of multiplying by the raw scale.** The shipped
quantity is `scale·cos`; with T = 2.5 the effective scale is `98.8644790649414 / 2.5 = 39.5458`.

```
const TEMPERATURE = 2.5;                       // hardcoded, never fitted at runtime
const scale = EMB.logit_scale / TEMPERATURE;   // = 39.5458
```

Rationale, so this is not "corrected" later: T = 2.5 is the in-sample NLL optimum on 112
held-out images (NLL 0.966 → 0.595), and 5-fold CV fitting at that sample size picked
T ≈ 8.7 and made held-out NLL *worse* (2.172). The temperature is not identifiable from 112
images, so it is a chosen constant with stated provenance, not a fitted parameter.

**Effect: no prediction changes at all** (temperature is monotone). Mean displayed confidence
drops from ~0.94 to ~0.85, which is where it should be. Apply it after multi-view pooling if
pooling is implemented, not before.

### 4.2 View-agreement confidence signal

Measured: when three renderings of one specimen agree → **accuracy 0.943**; when they
disagree → **0.500**. Disagreement occurs on 21.4% of specimens.

In the browser this is computable today, because the app already runs multiple passes per
photo (detector crop, full-photo fallback, and the retry path). Compute the argmax species of
each view, and report the fraction that agrees.

**What to show the user — and this matters.** If the app says "these photos disagree" it has
to say something *useful*, not add jargon. Concretely: when views disagree, the honest output
is a **shortlist with the disagreement named**, not a confident single answer. Say "the two
photos point to different species — likely a second mosquito in the frame, or a crop that cut
off the legs" and let the user pick, rather than picking for them. When views agree, say so
plainly: "all 3 photos agree". That is a real signal backed by a 0.943-vs-0.500 split, and it
is more trustworthy than any number the softmax produces.

**Caveats that would make either change wrong in the live app.**
- The measured ρ and agreement figures come from **crop variants of one image**, not
  genuinely different angles. Real multi-angle photos of one animal are probably *more*
  correlated than 0.5–0.76, so the pooling discount may be too weak in the live app. Treat
  ρ = 0.66 as a starting value to be re-measured on real paired photos, not a settled constant.
- The app's crop policy (larger-containing-box preference) is **not** the policy the 84.8%
  and the +4.5-point fusion numbers were measured with (highest-confidence box). Either
  re-measure under the app's policy or align them; don't assume the numbers transfer.
- 0.943/0.500 are measured on n=112 with a ±7-point standard error. The *direction* is solid;
  the exact values are not precise.

---

## Part 5 — Open questions, stated as open

### 5.1 aegypti is the representation ceiling — the one place a GPU earns its keep

**The finding.** Probe recall 0.167 (n=6); separates from albopictus at 0.882, from
japonicus-koreicus at 0.786. A linear probe cannot separate what the embedding does not
encode. **No ensemble, no head, no calibration and no prior changes this** — a prior changes
the *answer*, not the *evidence*.

**The experiment that would settle it.** Train a classifier head on the same frozen embedding
but with **aegypti-enriched training data** (GBIF has 828 CC0/CC-BY *a. aegypti* records;
MA has 47). If a head trained on 200+ real aegypti images still cannot separate aegypti from
albopictus on held-out data, the representation is confirmed as the ceiling and the only
remaining lever is a different or fine-tuned tower. **That head fits on CPU in minutes** — so
this experiment is *not* the GPU question, and it should be run first.

**Only if that fails**, the GPU question is: LoRA on BioCLIP 2.5's vision tower, trained on
aegypti-vs-albopictus pairs specifically, on the several hundred images GBIF/iNat can supply.
**Success criterion:** probe recall for aegypti rises above 0.6 on held-out data *while*
albopictus recall stays above 0.95. **Honest possibility: this needs a GPU we do not have.**
If the CPU head experiment fails, the realistic options are a rented GPU hour (a few dollars)
or accepting that the app reports Stegomyia at *group* level — which, given 03's Basel finding
that *aegypti* has no occurrence records within 100 km, may be the correct product decision
anyway.

### 5.2 Does cropping early help? **Attempted, not measured.**

The crops were built — 1,008 derived images across nine conditions in 20 s, 896 files on disk
in `04-crop-ablation/crops/` — but the scoring step failed and the run was stopped to protect
the report. The failure is a **pre-existing latent bug**, not one introduced by the ablation:
`NU` was defined at line 32 as the list of nuisance *prompt names* and then silently rebound at
line 39 to the nuisance *embedding matrix*, so `SP16 + NU` attempted list-plus-ndarray and
raised `UFuncNoLoopError`. My edit resolved the class indices up front and exposed the bug
earlier; it did not cause it. **Diagnosed by introspection** — `SCORED.index()` was verified
working at the failure point, which located the real cause. The artefacts are intact and
re-runnable; the bug and this note are the record.

**What is already known without it** (from 07, measured): detector crop quality is the
bottleneck below IoU ≈ 0.5, GT crops beat detector crops by 4.5 points, and SAM2 segmentation
buys nothing (+0.80 s/img, accuracy flat) because it inherits the detector's mistakes. So
cropping *to the detector's box* is already known to help relative to no crop, and the open
part is the **margin** — specifically whether cropping tighter than the detector's box hurts
by cutting off the leg banding and thoracic markings. **That is a real open question with a
user-visible consequence** (how loosely the browser pipeline should crop) and it is cheap to
settle: rerun `04-crop-ablation/ablate.py` with the `NU`/`NU_EMB` fix applied — 1,008
embeddings, roughly 8 minutes on this box.

### 5.3 Not measured: the full-scale probe

2,726 labelled MA-train images were downloaded (2.9 GB, 266 s at 10.5 img/s with 8 parallel
range readers) with the 112 held-out images excluded by filename, and embedding was running at
0.70–0.81 s/img. **It was stopped before completion** so it would not delay the report. The
LOO result in §2.2 is the weaker but complete version of the same question. This remains the
highest-value cheap measurement outstanding.

---

## Part 6 — Data specification (for the data agent — sources only, I built no scraper)

**For a linear probe** (wants volume, clean species labels, whole images + boxes):
GBIF taxon 3346, `media_type=StillImage`, licence CC0 + CC-BY → 69,110 records / ≥813 species.
Per-species depth is thin for rare species; the common European ones are deep.

**For calibration and held-out evaluation** (wants a *trustworthy* set, not a big one):
Mosquito Alert 2023 — expert-moderated labels, and the source of the existing 112. Keep it as
the evaluation set and never train on it. **Exclude the 112 by filename** — they are train-split
images (verified).

**For the aegypti question** (wants depth on one species): GBIF CC0/CC-BY *A. aegypti* (828
records) plus iNaturalist research-grade with `photo_license` ∈ {cc0, cc-by, cc-by-sa}.

**Trust signals worth capturing per record**, since label noise caps everything above:
Mosquito Alert expert-validation codes (from `2026-10-02-mosquito-alert-data/01-data-access.md`:
`tiger_certainty_category` 2 = confirmed, 0 = unusable photo, −1 = traits unclear, −2 =
rejected); iNaturalist research-grade status and community/count identifications.

**Two provenance requirements**, independent of licensing: record licence **per image**
(CC-BY-NC-SA-4.0 on Mosquito Alert 2023, per your note acceptable but the attribution and
share-alike still bind), and keep every derived crop linked to its source observation id so
the specimen-level split rule in §3.2 can be enforced. **Avoid ND-licensed material** — it
would block cropping and augmentation.

**Data reality check.** The MA train split has **only 6 classes**, three of them genus-only
(`culex`, `culiseta`, `anopheles`) and one a species complex (`japonicus-koreicus`). A probe
trained on it learns six classes and cannot add species. Label *coverage* has to come from
GBIF/iNaturalist, not from more Mosquito Alert data.

---

## Part 7 — Findings worth keeping (process, and things that contradict the reports)

1. **The 112 benchmark images are MA *train*-split images** — 112/112 filenames match
   `annotations.csv`. Any probe trained on that split must exclude them. This is not stated in
   `07-benchmark.md` and is the easiest way to produce a meaningless number.
2. **Rank alignment across 07's crop pipelines is sorted-by-basename over the manifest rows,
   not manifest row order.** Verified against `det_path` (180/180). Any analysis mixing
   pipelines must re-derive this *and assert it* — I got it wrong twice before asserting it.
3. **Four concurrent BioCLIP-2.5 H/14 embeddings do not fit in 27 GB.** Four shards at ~5 GB
   each exhausted the box (24.7 GB used, swap full) and thrashed for 30 minutes without
   completing a shard, while still showing live CPU counters. Three fit; streaming batches
   instead of accumulating preprocessed tensors dropped per-shard RSS to ~4.5 GB at
   0.70–0.81 s/img. **A live process is not a live job** — check for a completed milestone.
4. **The MA train split has 6 classes only** (albopictus 4612, culex 4563, culiseta 622,
   japonicus-koreicus 429, anopheles 84, aegypti 47).
5. **CV-fitted temperature is worse than useless at n=112** — see §2.1.
6. **`NU`/`NU_EMB` shadowing in `04-crop-ablation/ablate.py`** — pre-existing latent bug, §5.2.
7. **The app's crop policy differs from the benchmarked one.** `main.js` prefers a larger
   box containing ≥90% of the best box; 07 measured the highest-confidence box. The 84.8% was
   measured under the latter.
8. HF download for this dataset: 10.5 img/s / 1.4 MB/s per stream with 8 parallel range
   readers; serial would have been ~40 min for 2,726 images.

---

## Reproducing

```sh
V=../2026-10-02-mosquito-id/04-local-models/.venv/bin/python
$V 01-analysis/probe.py            # calibration + head/kNN CV          (~2 s, no inference)
$V 01-analysis/temp_study.py       # T generalisation + learning curve  (~3 s)
$V 01-analysis/transfer_test.py    # representation-vs-readout + shortcut (~11 s)
$V 01-analysis/multiview.py        # view correlation + pooling          (~2 s)
$V 03-ladder/label_addition.py     # does adding a label help?          (~30 s, text tower only)
```

Everything except `label_addition.py` runs on embeddings already on disk. All numbers in this
report are in `01-analysis/*.json` and `03-ladder/label_addition.csv`.
