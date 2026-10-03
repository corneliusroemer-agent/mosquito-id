# How much an `unsure` photo is worth in the pooled sum

Branch `feat/pool-always`. Files: `src/confidence/pooling.ts`,
`src/app/poolingPanel.ts`, `tests/pooling.test.ts` (new) and the pooling tests
in `gate.test.ts`, `regressions.test.ts`, `pooling-equivalence.test.ts`,
`e2e/tier1/`.

## The rule

`splitPoolable` is the single inclusion rule and returns
`{included, excluded, pending}`. Every entry carries the weight the rule gave
it, so who is in the pool and how much they count cannot drift apart.

| verdict | in the species sum | weight |
| --- | --- | --- |
| `species` / `genus` | yes | 1 |
| `unsure` | yes | its own top species posterior, capped at the species floor |
| `non-mosquito` | no | - |
| pending / failed / no verdict | no | - |

`non-mosquito` stays out because "this is not a mosquito" is not weak evidence
for any species, it is evidence against all of them. There is no weight small
enough that carries the same meaning: a photograph of a wall folded in at 0.1
dilutes a real identification with evidence about a different subject. Its
evidence belongs in `aggregateAdjacent`, where the app reads it.

## Why the weight is self-scaling, and what it is

**`unsurePoolWeight(p) = min(p.verdict.topSpeciesP, floors.species)`**

Two candidates were on the table. A fixed constant (0.25) introduces a number
nobody can validate, and this codebase has already paid for one: `floors.nonMosquito`
was fitted on an all-mosquito cache and so has never been measured against a true
negative. A constant chosen the same way is the same failure in new clothing.

Deriving it from the photo's own uncertainty needs no new number, and the cap
is not a new number either: it is `floors.species`, the constant that decides
when a photo may be named. The rule becomes "an unsure photo is worth at most
what the photo that would just barely have been named is worth", which is a
statement about the existing fitted value rather than a second one. It is also
self-limiting in the right direction - a photo that peaked at 0.12 counts for an
eighth of a named photo, one that peaked at 0.36 counts for almost as much,
because it is nearly as good evidence.

`1 - maxPosterior` is the other flatness measure available and it is the wrong
way round: it gives a nearly-flat posterior a weight near 1 and a peaked one a
weight near 0, so the least informative photo would count most.

### Worked example

Three named photos at 0.72 saying *Aedes aegypti*, one unsure photo at 0.12
saying *Aedes albopictus*, method "Dependent evidence" at r=0.5:

```
method weights     [0.5, 0.5, 0.5, 0.5]              total 1.5   (1/(1+3r) each)
pool weights       [1,   1,   1,   0.12]
after scaling      [0.5, 0.5, 0.5, 0.06]             total 1.06
rescale by 1.5/1.06
final              [0.708, 0.708, 0.708, 0.085]       total 1.5
shares             47.2%  47.2%  47.2%   5.7%
```

The blurry photo carries 5.7% of the pooled evidence against a species the other
three outvote 8:1. It moves the pool's margin by about a twentieth; it cannot
move the answer.

### The rescale is load-bearing

The last line of `poolingWeights` rescales the weighted sum back to the total
the method asked for, and it is doing real work. Remove it and adding an unsure
photo shrinks every logit in the pool, because the pool now sums to 1.06 rather
than 1.5. Softmax is sensitive to the scale of its input, so the whole pooled
posterior flattens - and it flattens for a reason that has nothing to do with
the evidence: the pool would be less certain because a photo was *checked*, not
because anything was learned. That is the exact class of surprise the existing
`pooledVerdict` doc warns about, where pooling raises the winner with depth
alone.

The rescale makes the down-weight a statement about the balance between photos
and nothing else. Weight moves *between* them: the three named photos rise from
0.5 to 0.708 to make up what the unsure one gave up, and the pool is exactly as
sharp as those three photos alone would have been. Someone reading
`return base.map((b, i) => b * pool[i]! * keepTotal)` later will be tempted to
delete the last factor as a no-op - it is not, and the test that pins the total
(`expect(total).toBeCloseTo(1.6, 12)`) is what catches the deletion.

All four methods compose the same way: the down-weight is multiplicative on the
method's own weight, then the total is restored. "Weight by lead" already
discounts a flat posterior; the two compose rather than fight, and the invariant
across all four is that an unsure photo takes exactly `poolWeight` of the share
its method would have given it.

## The gate had to be generalised, and this is the part to review

`pooledVerdict` already refused a species claim unless every photo in the pool
claimed one. Pooling three blank background photographs (the shipped regression,
`tmp/mosquito-id/bogusresults.png`) now clears **both** floors:

```
top species posterior 0.397   (species floor 0.373)
top genus  posterior 0.832   (genus  floor 0.80)
```

The species-only gate demoted that to "Aedes" - three photographs of a wall
announced as a genus, which is the original defect one resolution down. So the
gate is now the pool's resolution is the coarsest any of its photos reached: a
species claim needs every photo species, a genus claim needs every photo genus
or better.

**The consequence worth your judgement:** three confident photos plus one unsure
photo now yield "Not confident enough to name a genus" rather than the species.
Checking a blurry photo costs the pool its headline. I took that trade because
the alternative reintroduces a false identification of a non-mosquito as a
mosquito, which is the worse error, and because the contribution table shows the
blurry photo's row with its weight, so nothing is hidden. If you would rather
the unsure photo only ever *cap* the pool at a genus, that is a two-line change
to the same gate - but three blank walls then come back as a genus.

## The consolidation

`splitPoolable` was the predicate and `poolingWeights` a separate pass over the
same list. It is now one function returning members that carry their own weight,
and `PoolSplit.abstained` is gone: there is no longer a bucket a checked photo
can vanish into. A settled photo with no verdict at all was previously in
*neither* `included` nor `abstained` and was never listed anywhere; it is now
`excluded` with the reason `no-verdict`. A `non-mosquito` photo is likewise
listed with its reason instead of being in neither list, which is why three
e2e row-count assertions moved from 2 to 3 and 3 to 4.

## Verification

`tests/pooling.test.ts` is new and 13 cases. Nine of them fail on `origin/main`,
including the headline one - an `unsure` photo is in the pool, where before it
was dropped. The formula is pinned against hand-computed numbers (0.12 → 0.12,
0.95 → 0.373), and the invariant across all four methods is asserted rather than
asserted-about.

The e2e tier1 suite passes against this build except
`reactivity.spec.ts:81`, which fails identically on an `origin/main` build served
from the same box (145-166 ms against a 110 ms budget on both) - it is the load
from three agents sharing the machine, not this change.

## `thumbnailStrip.ts` restates the rule by hand, and now says so correctly

`entersPooledSum` answers "would this photo enter the SUM" and is a hand-written
restatement of `splitPoolable`'s rule, cross-checked against it in
`tests/thumbnail-strip.test.ts` so the two cannot drift. It returned `false` for
an `unsure` photo, which is exactly the bug being fixed, so it now returns
`true` alongside species and genus.

The distinction that function draws is worth keeping sharp, because it is easy to
collapse the two functions into one and lose it:

- `contributesToPool` - the strip's **permission**. May this photo be checked?
  A non-mosquito photo fails here: there is nothing a user could usefully pool.
- `entersPooledSum` - the **arithmetic**. Of the photos that may be checked,
  which contribute? An `unsure` photo may be checked and does contribute,
  down-weighted. A non-mosquito photo is visible and checkable in principle but
  contributes nothing, because "this is not a mosquito" is evidence against
  every species rather than weak evidence for one.

The cross-check test is what enforces both halves: it walks every verdict state
and asserts `entersPooledSum(p)` equals "`splitPoolable` put this photo in
`included`", so a future change to either side fails a test rather than changing
what a user sees.

## What to reverse, if you disagree

The trade in this change is one decision, and it is worth being able to undo it
without archaeology.

**What I did.** The pooled card's claim is gated on the *coarsest resolution any
photo in the pool reached*: a species claim needs every photo species, a genus
claim needs every photo genus-or-better. So three confident photos plus one
unsure photo return **"Not confident enough to name a genus"**, where before
this change they returned the species.

**Why.** With unsure photos pooled at full-ish weight, three photographs of a
blank wall pool to a species posterior of 0.397 and a genus posterior of 0.832 -
clearing both floors (0.373 and 0.80). The species-only gate that was there
before demoted that to "Aedes": three photographs of a wall announced as a
genus, which is the shipped `bogusresults.png` regression one resolution down.
Generalising the gate is what keeps the original fix fixed.

**How to reverse it**, if you would rather an unsure photo cap the pool at a
genus than silence it. In `pooledVerdict`, drop the second gate - the one that
requires every photo to have reached a genus - and let the existing species-only
gate demote into the genus branch:

```ts
// src/confidence/pooling.ts, pooledVerdict
const everyPhotoClaimed = claimed.length > 0 && claimed.every((s) => s === "species");
if (everyPhotoClaimed) return v;
// DELETE everyPhotoResolvedToGenus and its branch here.
return { ...v, state: "genus", species: null };
```

That is a strict weakening: three blank walls then come back as a genus, and
`tests/regressions.test.ts` ("three blank-wall photos still name nothing, now that
they are in the sum") is the test that fails, which is the point - it is there to
be the thing that stops you.

**What I would not reverse.** Pooling the unsure photo at all. Dropping it is the
defect this branch exists to fix, and it is independent of which way the gate
goes.

## Verification

`tests/pooling.test.ts` is new: 13 cases. Nine fail on `origin/main`, including
the headline one - an `unsure` photo is in the pool, where before it was dropped.
The formula is pinned against hand-computed numbers (0.12 -> 0.12, 0.95 -> 0.373),
and the invariant across all four pooling methods is asserted rather than
asserted-about.

`tests/regressions.test.ts` keeps the original defect as a live test rather than
as a comment: the blank-wall photos are now pooled, and the assertion is that
they still name nothing.

The e2e tier1 suite passes against this build. `reactivity.spec.ts:81` is the one
exception and is not this change: it fails identically on a pristine `origin/main`
build served from the same box (145-166 ms on both against a 110 ms budget), so it
is the load from several agents sharing one machine.

## The pooled card never saw the nuisance block

Found by the scoring agent while this branch was up. `pooledVerdict` called
`verdictFrom` with `adP` only. `verdictFrom` reads **two** non-mosquito blocks
with separate floors: `adP` (a specific other insect — a biting midge) and
`nuP` (nothing mosquito-like is here; the nuisance rows are literally
photographs of walls, hands and empty background). The pooled card saw only the
first, so it could not answer "not a mosquito" from the evidence that most often
carries it.

The fix is the shape of every other block in this file: `PoolablePhoto` gains
`nuP`, `aggregateNuisance` sums it on the same logZ-recovered axis as
`aggregateAdjacent` (the two now share one helper rather than restating it), the
panel forwards it, and `renormalizedPooledPosterior` subtracts it from the
species mass alongside `adP`. Photos must actually carry `nuP`, so the three
`fuseViews`-to-photo sites in `main.js` pass it alongside `adP`.

### What it is worth, measured

`aggregateNuisance` and the forwarding work, and two tests pin them: the same
aggregate with and without the block decides `non-mosquito` against `species`.
But the block does not change any *realistic* pool's answer, and the reason is
worth writing down before someone assumes otherwise.

The per-photo gate already excludes any photo whose nuisance mass reaches
`floors.nuisance` (0.05), so every photo that **reaches the pool** carries less
than that. Measured on three photos at 0.03 each: the pooled nuisance mass is
**0.014** — *further* from the floor than any single photo was, not closer.
Pooling sums log-probabilities, and on a 0.72-peaked photo the species side is
two orders of magnitude larger, so three sub-threshold nuisance masses do not
accumulate into a claim.

So the forwarding makes the pooled claim *able* to read nuisance evidence and
correctly takes it off the species mass; it does not make pools of walls get
rejected. What would do that is raising `floors.nuisance` above the mass a pool
can actually reach — and that floor was fitted deliberately by the scoring agent
(0.05 catches nuisance mass peaked at 0.498 over 700 true negatives). Not this
branch's call, and the swept knee is in their report.

The measurement is pinned as a test so nobody re-derives it, and so the two
forwarding tests above it are read for what they are.
