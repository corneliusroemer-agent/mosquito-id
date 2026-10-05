# 00 — `canon_group` missed two namespaces, and the leak it missed has no label contradiction

**Scope of this report.** One function, `canon_group` in `common2.py`, had a regex naming two
namespaces. It now strips any namespace prefix. The reusable content is not the regex: it is
*what the leak was*, *why the obvious explanation was wrong*, and *which denominators the
contamination figures carry* — this project currently has three contamination numbers in
circulation and they disagree only because each describes a different split.

## 1. The three contamination numbers, with their denominators

State them together or they read as contradictory:

| figure | denominator | what it measures | where |
|---|---:|---|---|
| **4.70%** | **1,257** test rows of the 6,264-row BioCLIP H/14 cache | 59 test rows that are pixel-for-pixel a train/val row | report 11 |
| **~3%** | all 6,264 cache rows | 356 rows (5.68%) sitting in a duplicated-specimen group | report 11, §1 |
| **23%** | `clean`-tier rows, main 14,072-row pool, genus4 | report 31 | report 31 |
| **10.94%** | the *validation* split of the main pool | another agent, in flight 2026-10-05 | — |

Two of these are **test-set** fractions, one is a **whole-cache** fraction, one is a
**clean-tier** fraction and one is a **val** fraction. None of them is "the" contamination rate.
The disagreement between them is a denominator disagreement, not a measurement disagreement.

## 2. The leak: Mosquito-Alert republishing itself

`split_group` names a specimen by the *feed it arrived on*, not by the specimen. Mosquito-Alert
publishes the same specimen through two feeds, so the same specimen UUID appears under both
`maapi:<uuid>` (the API) and `madump:<uuid>` (the bulk dump):

```
Aedes aegypti  madump:a0427357-be66-4ff0-b018-06db66fdc55d  mosquito_alert_dump
        <->   Aedes aegypti  maapi:a0427357-be66-4ff0-b018-06db66fdc55d  mosquito_alert_api   hpc = 0.9998
```

Same photograph, same specimen, two `split_group` values, opposite sides of a 60/20/20 split.

Group structure in the cache, counted directly from
`40-precision/50-h14-scale/cache/rows.tsv` (6,264 rows):

| namespace | rows | suffix shape |
|---|---:|---|
| `gbif` | 3,172 | numeric |
| `maapi` | 2,866 | uuid |
| `madump` | 187 | uuid |
| `commons_file` | 39 | filename |

**178 specimen groups are duplicated** across two namespaces, covering **356 rows**. Every one
of the 178 is exactly the pair `maapi:X` + `madump:X` — no other namespace pairing exists in
this cache. After the fix the cache has 6,086 groups instead of 6,264.

**All 59 leaked train/test pairs carry 100% label agreement.** That is the property that makes
this leak dangerous rather than merely untidy: a label-contradiction check — the cheap detector
everybody reaches for first — returns zero here by construction. Both rows of the pair are the
same species because they are the same specimen. Detection had to be pixel-level (hpc against
every train/val row), and the naive pixel-level detector fails too, because its
same-species/different-specimen control is itself contaminated by this same mechanism and
reports max hpc 1.0000.

**Concentration.** The leak sits entirely in `mosquito_alert_dump`, which holds 187 rows and
**35 test rows** of 6,264. So the 4.70% is a denominator artefact of a small collection, not a
pool-wide failure; the practical consequence for `DEFAULT_FLOORS`, the H/14 path and issue #38
is close to nil. `gbif` — 3,172 rows, 635 test rows — has **zero** M1-leaked test rows.

## 3. Ruled out: it is not GBIF republishing iNaturalist

The expected mechanism was that GBIF republishes iNaturalist, so an iNat observation appears
both as `inat:<id>` and as `gbif:<key>`. **This cache contains zero `inat:` rows.** Verified by
counting the namespace prefix of every one of the 6,264 `group_key` values: the four namespaces
above are the complete list. There is no iNaturalist feed in this cache to republish.

So the search is closed: do not re-run it. The same expectation is *also* wrong for the main
14,072-row pool, where the cross-namespace numeric collision set is exactly **148 groups, every
one of them a `gbif:<key>` / `uuid:<key>` pair** — the case the original regex already handled.
There is no `inat`↔`gbif` pair anywhere in either dataset.

## 4. Why strip the prefix instead of enumerating namespaces

The original regex was `^(uuid|gbif):(\d+)$` — a whitelist of namespaces *and* of suffix shape.
Both halves are whitelists, and both were wrong in the same way: a whitelist silently misses the
next feed. The failure mode being fixed here is precisely "the list was not updated", so
extending the list would reproduce the bug in a form that looks fixed.

`canon_group` now strips any `<namespace>:<suffix>` prefix. The suffix is the specimen identity;
the namespace is the transport.

**What was checked to make sure this is safe for `uuid:` and `gbif:`** — the requirement that the
broad version must not change existing behaviour:

- `gbif:<digits>` and `uuid:<digits>` still canonicalise to the byte-identical string
  `gbif:<digits>`, so every group key computed before the fix is reproduced exactly.
- Over the **14,072-row pool** the partition is *identical* before and after: 8,927 groups both
  ways, and the two groupings partition the rows into the same sets. Asserted directly, not
  inferred.
- The 148 groups the fix merges in the pool are exactly the 148 gbif↔uuid groups that were
  already merged before it. The fix adds **zero** new merges to the pool.
- The 178 groups it merges in the cache are exactly the 178 maapi↔madump pairs. No `inat`,
  `commons_file`, or filename-suffix group is touched: **no suffix space overlaps another
  namespace's** on either real dataset.
- Group count on the pool stays 8,927 and the cache goes 6,264 → 6,086, so nothing collapses
  beyond the intended pairs.

One behaviour genuinely does change and is worth stating plainly rather than burying:
**3,320 `uuid:` rows in the pool have a non-numeric (UUID) suffix and were never canonicalised
at all** by the old regex, because it demanded `\d+`. They now get their prefix stripped. Their
group *count* does not change (each was already its own group, and none shares a suffix with a
row in another namespace), but the group *key string* changes, so any artefact keyed on the old
string would need regenerating. No artefact in the repo is.

**The invariant a prefix-strip relies on** is that the suffix alone identifies the specimen —
i.e. no two namespaces mint the same suffix string for different specimens. That is verified on
both real datasets (above) and is the thing to re-check if a new feed appears, since it is the
assumption that would break rather than the regex.

## 5. What changed in code

Only `common2.canon_group` and its two module-level regexes in `common2.py`. **Nothing else** —
no loader, no split function, no fixture, no threshold. `split_groups`, `leak_check`, `tasks`,
`macro_f1`, `group_boot`, `DEFAULT_FLOORS`, the culico/B/16 floors and every head are
untouched. Nothing was refit, rescored, retrained or re-extracted; no model ran.

The split *assignment* will differ on future runs of any harness that calls `canon_group` over a
dataset containing duplicated groups, because those groups are now whole. That is the point, but
it means a cached split from a pre-fix run is not comparable to a post-fix one on the same seed
— worth knowing before someone reads a metric change as a modelling result.

Test: `investigations/2026-10-03-rewrite/test_common2_canon_group.py`, next to `common2.py`.
