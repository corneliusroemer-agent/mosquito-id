import type { Floors, Head, Verdict } from "./types";
import { DEFAULT_FLOORS } from "./types";
import { genusOf } from "./genus";
import { adjacentNames } from "./softmax";
import { verdictFrom } from "./verdict";

/** The minimum of what updatePooling() needs from a photo, so a test can pass a literal. */
export interface PoolablePhoto {
  name?: string;
  fingerprint?: string;
  pending?: boolean;
  error?: unknown;
  /** Species -> posterior, as rendered in the results table. Drives the lead. */
  scores?: Record<string, number>;
  /** Species -> logit on the single-view scale. */
  logits?: Record<string, number>;
  /**
   * Per-class adjacent posteriors, index-aligned with `adjacentNames(head)` -
   * the non-mosquito evidence this photo carried. Absent where the head has no
   * adjacent classes or the path that scored the photo does not report them,
   * and a photo without them contributes no non-mosquito mass to the pool.
   */
  adP?: number[];
  verdict?: Verdict | null;
}

/**
 * The species posterior a set of aggregated logits describes, or null if the
 * aggregate carries no usable signal.
 *
 * The aggregated logits ARE log-probabilities up to a per-photo constant (a
 * photo's logits are scale*cos, and log p = scale*cos - logZ), so a softmax over
 * their weighted sum is the pooled posterior. Max-subtracted for overflow: raw
 * logits run to hundreds and exp() of that is Infinity on every species, which
 * would silently turn the whole pool into NaN.
 */
export function pooledPosterior(head: Head, aggLogits: Record<string, number>): number[] | null {
  const vals = head.species.map((sp) => aggLogits[sp] ?? NaN);
  if (!vals.length || vals.some((v) => !Number.isFinite(v))) return null;
  const max = Math.max(...vals);
  const exps = vals.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return exps.map((e) => e / total);
}

export interface PoolSplit {
  /** Photos whose evidence enters the aggregate. */
  included: PoolablePhoto[];
  /** Photos left out because the gate would not name a genus on them. */
  abstained: PoolablePhoto[];
  /**
   * Checked photos that are neither: still classifying, or failed. They
   * contribute nothing and are listed as neither included nor abstained, so a
   * row in the contribution table always means something.
   */
  pending: PoolablePhoto[];
}

/**
 * Which photos may enter the pooled aggregate.
 *
 * Only a species or genus verdict contributes. Three reasons, each a different
 * kind of wrong:
 *
 *  - `unsure`: the photo's logits are a real posterior, and summing them in is
 *    what made an earlier parked abstention work a regression - the pooled card
 *    would fold in a species the app had just declined to name, which is worse
 *    than not gating at all.
 *  - `non-mosquito`: its evidence is about a different subject, so pooling it
 *    would fold a midge's logits into a mosquito's posterior.
 *  - pending or failed: it has no verdict that matches its pixels, so the
 *    aggregate would be folding in the previous crop's evidence.
 *
 * This is the whole predicate. updatePooling() must not grow a second one: the
 * gate's job is to decide what may be pooled, and a rendering function is not
 * where that belongs. `tests/pooling.test.ts` holds the corpus-level check -
 * three photos of nothing in particular must not pool into a named species.
 */
export function splitPoolable(checked: PoolablePhoto[]): PoolSplit {
  const settled = checked.filter((p) => !p.pending && !p.error);
  return {
    included: settled.filter(
      (p) => p.verdict?.state === "species" || p.verdict?.state === "genus",
    ),
    abstained: settled.filter((p) => p.verdict?.state === "unsure"),
    pending: checked.filter((p) => p.pending || p.error),
  };
}

/** How the pooled card's per-species weights are computed. */
export type PoolingMethod =
  | "Equal weight"
  | "Weight by lead"
  | "Accumulate evidence"
  | "Dependent evidence";

/**
 * The per-photo weights for one pooling method.
 *
 * "Dependent evidence" de-duplicates identical crops by fingerprint and then
 * discounts the survivors by a correlation factor `r`: photos that are the same
 * picture carry near the same evidence, so counting them at full weight is
 * counting one observation several times. A duplicate still gets weight 0, so
 * the discount is on the distinct photos, not on all of them.
 */
export function poolingWeights(
  included: PoolablePhoto[],
  method: PoolingMethod,
  r: number,
): number[] {
  const N = included.length;
  if (!N) return [];
  if (method === "Equal weight") return included.map(() => 1 / N);

  if (method === "Weight by lead") {
    // The lead is the gap between a photo's own top two posteriors: how far the
    // classifier separated its best guess from its runner-up.
    const leads = included.map((p) => {
      const sorted = Object.values(p.scores ?? {}).sort((a, b) => b - a);
      return (sorted[0] || 0) - (sorted[1] || 0);
    });
    const sumLead = leads.reduce((a, b) => a + b, 0) || 1e-6;
    return leads.map((l) => l / sumLead);
  }

  if (method === "Accumulate evidence") return included.map(() => 1);

  // Dependent evidence.
  const seen = new Set<string>();
  const effective = included.map((p) => {
    const fp = p.fingerprint;
    if (fp !== undefined && seen.has(fp)) return 0;
    if (fp !== undefined) seen.add(fp);
    return 1;
  });
  const denom = 1 + (seen.size - 1) * r;
  return effective.map((e) => e / denom);
}

/** Sum the included photos' per-species logits under `weights`, zeroing absent ones. */
export function aggregateLogits(
  head: Head,
  included: PoolablePhoto[],
  weights: number[],
): Record<string, number> {
  const agg: Record<string, number> = {};
  head.species.forEach((sp) => {
    agg[sp] = 0;
  });
  included.forEach((p, i) => {
    const w = weights[i]!;
    if (!(w > 0) || !p.logits) return;
    head.species.forEach((sp) => {
      agg[sp]! += (p.logits?.[sp] || 0) * w;
    });
  });
  return agg;
}

/**
 * The adjacent (non-mosquito) evidence the pool's photos carry, summed under
 * `weights` and expressed on the SAME axis as `aggregateLogits`.
 *
 * The axis matters and is easy to get wrong. `aggregateLogits` sums the
 * photos' species logits, which are `scale * cos`, not log-probabilities. A
 * photo's log-probabilities are `scale * cos - logZ` for one per-photo constant
 * `logZ` shared by every class it scored. Summing `log adP` directly would put
 * the adjacent evidence one `logZ` below where the species evidence sits, and
 * because `logZ` runs to hundreds on a real head that is not a rounding
 * difference - the species would win every comparison and the pooled card could
 * still never say "not a mosquito".
 *
 * So each photo's `logZ` is recovered from the same photo's species evidence,
 * where both sides of `logit = log p + logZ` are known:
 *
 * ```
 * logZ_i = logits_i[best] - log(scores_i[best])
 * ```
 *
 * and added back to that photo's summed `log adP`. The result is exactly
 * `sum_i scale * cos_adjacent_i`, the quantity that belongs beside the species
 * logits, with no approximation.
 *
 * Returns an empty array when no contributing photo carries both the adjacent
 * posteriors and the species evidence needed to place them - a head with no
 * adjacent classes, a server-path photo that reports none, or a caller that
 * passes only scores. There is nothing to pool, and the non-mosquito branch
 * must not fire on evidence that does not exist.
 */
export function aggregateAdjacent(
  head: Head,
  included: PoolablePhoto[],
  weights: number[],
): number[] {
  const names = adjacentNames(head);
  if (!names.length) return [];
  const agg = new Array<number>(names.length).fill(0);
  let any = false;
  included.forEach((p, i) => {
    const w = weights[i]!;
    if (!(w > 0) || !p.adP || p.adP.length !== names.length || !p.logits || !p.scores) return;
    // The per-photo constant shared by every class, read off the species side.
    let bestLogit = -Infinity;
    let bestP = 0;
    for (const sp of head.species) {
      const l = p.logits[sp];
      const q = p.scores[sp];
      if (typeof l !== "number" || typeof q !== "number") continue;
      if (l > bestLogit) {
        bestLogit = l;
        bestP = q;
      }
    }
    if (!Number.isFinite(bestLogit) || !(bestP > 0) || bestP > 1) return;
    const logZ = bestLogit - Math.log(bestP);
    names.forEach((_, j) => {
      const v = p.adP![j]!;
      if (!Number.isFinite(v) || v <= 0) return;
      agg[j]! += (Math.log(v) + logZ) * w;
      any = true;
    });
  });
  return any ? agg : [];
}

/**
 * The pooled card's non-mosquito posteriors, or an empty array when the pool has
 * no adjacent evidence to speak of.
 *
 * The species and adjacent evidence are normalised against EACH OTHER, so the
 * result sums with `pooledPosterior` to 1 rather than being inflated to 1 on its
 * own. That is the whole reason this function exists: `pooledPosterior`
 * softmaxes over the species alone, so a pool of photos that each read 97%
 * biting midge reported species posteriors summing to exactly 1 and no adjacent
 * mass anywhere, and the pooled card could not say "not a mosquito" at all. Here
 * the pool's adjacent mass competes with its species mass on the same
 * denominator, and `verdictFrom` reads it with the same NON_MOSQUITO_FLOOR the
 * per-photo gate uses.
 */
export function pooledAdjacentPosterior(
  head: Head,
  aggLogits: Record<string, number>,
  aggAdjLogits: number[],
): number[] {
  if (!aggAdjLogits.length) return [];
  const sp = head.species.map((s) => aggLogits[s] ?? NaN);
  if (sp.some((v) => !Number.isFinite(v))) return [];
  const all = sp.concat(aggAdjLogits);
  const mx = Math.max(...all);
  const ex = all.map((l) => Math.exp(l - mx));
  const total = ex.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total)) return [];
  const adj = ex.slice(sp.length).map((e) => e / total);
  return adj.some((p) => p > 0) ? adj : [];
}

export interface PooledCandidate {
  name: string;
  genus: string;
  /** Logit relative to the pool's best, on the plotted -20..0 axis. */
  relScore: number;
}

/**
 * The species the pool ranks, on the -20..0 relative-logit axis the card is
 * drawn on.
 *
 * relScore is a LOGIT difference, not a probability: it is already relative to
 * the pool's best, so the top row is always 0.0 and the axis is fixed. A
 * non-finite relScore is carried through as-is rather than clamped, because the
 * renderer's guard for it is the thing under test elsewhere and hiding it here
 * would only move the bug.
 */
export function pooledCandidates(
  head: Head,
  aggLogits: Record<string, number>,
): PooledCandidate[] {
  const values = head.species.map((sp) => aggLogits[sp]!);
  const maxLogit = values.length ? Math.max(...values) : 0;
  return head.species
    .map((sp) => ({
      name: sp,
      genus: genusOf(sp),
      relScore: aggLogits[sp]! - maxLogit,
    }))
    .sort((a, b) => b.relScore - a.relScore);
}

/**
 * The pooled species posterior, on the same denominator as `adjP` when the pool
 * carries adjacent evidence.
 *
 * `pooledPosterior` alone is the species-only softmax, whose posteriors sum to 1
 * as if no other class existed - the inflation that let a pool of biting midges
 * be announced as a species. With adjacent mass present, the species share of
 * the joint is what the gate should read, and it sums with `adjP` to 1. With no
 * adjacent mass there is nothing to share the denominator with, so the
 * species-only softmax is the correct answer and is returned unchanged.
 */
function renormalizedPooledPosterior(
  head: Head,
  aggLogits: Record<string, number>,
  adjP: number[],
): number[] | null {
  const spP = pooledPosterior(head, aggLogits);
  if (!spP) return null;
  if (!adjP.length) return spP;
  const spMass = 1 - adjP.reduce((a, b) => a + b, 0);
  // Adjacent mass above 1 is not reachable from a softmax, but a caller that
  // passes one anyway gets the species-only posterior rather than negatives.
  if (!(spMass > 0) || !Number.isFinite(spMass)) return spP;
  return spP.map((p) => p * spMass);
}

/**
 * The pooled card's headline, from the POOLED posterior and not from a mean of
 * per-photo verdicts: the logits are the per-photo log-probabilities up to a
 * constant, so softmax(aggLogits) is the pooled posterior exactly, and one gate
 * on it is the pooled claim. Averaging per-photo verdicts instead would let two
 * confident photos outvote a third that pooled with them says nobody knows.
 *
 * The pool also carries its non-mosquito evidence, so this card can answer "this
 * is not a mosquito" on the pooled evidence rather than being structurally
 * unable to ask. See aggregateAdjacent and pooledAdjacentPosterior.
 *
 * `agreement` is null by construction: the pool is a claim about several photos,
 * not about the two views of one, so the view-disagreement veto has nothing to
 * read here and the per-photo gate has already done that work.
 *
 * The pooled posterior is SHARPER than its parts, and the species floor is not
 * valid on it. Every floor was fitted on single- or two-view posteriors, where
 * SPECIES_CONFIDENCE_FLOOR = 0.373 is the 90%-coverage point on individual
 * classifications; pooling sums the per-photo log-probabilities, which for
 * near-identical posteriors is a power mean and raises the winner with depth
 * alone. Three photos at 0.355 / 0.350 / 0.360 - none of which would have named
 * a species - pool to 0.4625 and did.
 *
 * So the pool is gated on the PHOTOS, not on its own posterior: it may reach a
 * species claim only when every photo contributing to it reached one. Pooling
 * exists to gather more evidence for a claim, never to manufacture resolution
 * the individual classifications did not have. The pooled posterior still
 * decides the genus, and a pool of genus-only photos reports a genus.
 */
export function pooledVerdict(
  head: Head,
  aggLogits: Record<string, number>,
  included: PoolablePhoto[] = [],
  aggAdjLogits: number[] = [],
  floors: Floors = DEFAULT_FLOORS,
): Verdict | null {
  const adjP = pooledAdjacentPosterior(head, aggLogits, aggAdjLogits);
  const spP = renormalizedPooledPosterior(head, aggLogits, adjP);
  if (!spP) return null;
  // The adjacent mass the pool carries, on the same denominator as the species
  // mass, so the non-mosquito branch reads the pool the way the per-photo gate
  // reads a photo. An empty array here means the pool genuinely has no adjacent
  // evidence to pass - the head has no adjacent classes, or no contributing photo
  // reports any - and is the deliberate value that verdictFrom's required `adP`
  // is there to make visible: the branch cannot fire, rather than firing on a
  // default.
  const v = verdictFrom(head, spP, null, adjP, floors);
  if (v.state !== "species") return v;
  // A photo with no verdict at all is not evidence that the pool may sharpen
  // past the species floor, so it blocks the claim rather than being ignored.
  const everyPhotoClaimed = included.length > 0 && included.every((p) => p.verdict?.state === "species");
  if (everyPhotoClaimed) return v;
  // Demote into the genus branch rather than past it: the pooled posterior
  // genuinely does carry genus-level mass, so the genus floor is still the
  // thing that decides whether the pool names one at all.
  return { ...v, state: "genus", species: null };
}
