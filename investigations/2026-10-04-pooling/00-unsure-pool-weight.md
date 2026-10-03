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

The rescale is what makes this a weighting rather than a discount on the whole
sum. Without it, adding an unsure photo would shrink every logit in the pool and
flatten the posterior for reasons that have nothing to do with the evidence. With
it, weight moves *between* photos: the three named ones rise from 0.5 to 0.708 to
make up what the unsure one gave up, and the pool is exactly as sharp as the
three photos alone. `poolingWeights` returns the method's own numbers bit for
bit when every photo is at full weight, so no existing behaviour moves.

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

## Handed back: two functions in `src/app/thumbnailStrip.ts` are now wrong

`entersPooledSum` restates `splitPoolable`'s rule by hand and says an `unsure`
photo does not enter the sum. It does now. `tests/thumbnail-strip.test.ts`
cross-checks the two, and `PoolSplit.abstained` no longer exists, so that file
does not typecheck - which is why `npm run test:all` is red on this branch.

I did not touch either file. The change is:

- `src/app/thumbnailStrip.ts`, `entersPooledSum`: add `state === "unsure"` to the
  returned condition, and update the doc comment above it, which says `unsure`
  "need not be one that pooling will sum".
- `tests/thumbnail-strip.test.ts` line ~129: expect `true` for an unsure photo.
- `tests/thumbnail-strip.test.ts` lines ~154-155: `abstained` → `excluded`.
- `tests/thumbnail-strip.test.ts` line ~142: the cross-check then agrees, since
  `splitPoolable` now returns the unsure photo in `included`.
- The comment at line ~146 says `splitPoolable` "deliberately does not classify"
  a photo with no verdict; it does now, as `no-verdict`.

I verified the whole suite is green with those five edits applied, then reverted
them.
