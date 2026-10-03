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
 * Why a checked photo contributes nothing to the pooled sum.
 *
 * Only a photo that was pooled and then dropped lands here. A photo still
 * classifying or failed is in `pending` instead, and a photo with no verdict at
 * all - nothing has classified it, or the verdict is missing - is
 * `no-verdict`, which is a different failure from a photo the gate actively
 * answered.
 */
export type PoolExclusion = "non-mosquito" | "no-verdict";

/**
 * A photo together with the weight the pooling rule gave it.
 *
 * The rule that decides *whether* a photo enters the sum and the weight it
 * carries are one decision, so they are one object: `splitPoolable` attaches
 * `poolWeight` here and `poolingWeights` reads it, and no photo can be in the
 * sum at the wrong weight because nothing sets the two in different places.
 *
 * Structurally a `PoolablePhoto`, so the aggregating functions take it
 * unchanged.
 */
export type PoolMember = PoolablePhoto & {
  /**
   * This photo's share of a fully-trusted photo. 1 for a photo the gate could
   * name, `unsurePoolWeight` for one it could not, 0 for anything excluded.
   */
  poolWeight: number;
  /** Why this photo contributes nothing, or null when it contributes. */
  excludedBecause: PoolExclusion | null;
};

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
  /** Photos whose evidence enters the aggregate, each with the weight it carries. */
  included: PoolMember[];
  /** Checked photos that contribute nothing, each with the reason. */
  excluded: PoolMember[];
  /**
   * Checked photos with no verdict yet: still classifying, or failed. Separate
   * from `excluded` because their verdict is not a decision about the photo -
   * there is simply nothing to pool - and the contribution table says which of
   * the two happened.
   */
  pending: PoolMember[];
}

/**
 * The ceiling on an `unsure` photo's share of a fully-trusted photo, and the
 * species floor it is bound to rather than fitted as a number of its own.
 *
 * An unsure photo is one the gate declined to name a species on. The most
 * weight such a photo can be worth is the weight of the photo that would
 * just barely have been named, so the floor that decides naming is also the cap
 * on its influence. That is what makes the cap checkable against evidence
 * rather than a constant chosen to look reasonable: this codebase has already
 * been bitten by a pooled constant fitted where it could not be validated
 * (`floors.nonMosquito`), and reusing the species floor adds no new number that
 * can be wrong in a new way.
 */
export const UNSURE_POOL_WEIGHT_CAP = DEFAULT_FLOORS.species;

/**
 * What one `unsure` photo's evidence is worth in the pooled sum: its own top
 * species posterior, capped at `UNSURE_POOL_WEIGHT_CAP`.
 *
 * Self-scaling, so there is no tuned constant. A photo that peaked at 0.12 -
 * the app has no idea what this is - counts for an eighth of a named photo and
 * cannot move a result that three named photos agree on. A photo that peaked at
 * 0.36, one step below naming, counts for almost as much as a named photo,
 * because it is nearly as good evidence: dropping it wholesale discarded a
 * useful corroboration, which is the bug this replaces.
 *
 * `1 - maxPosterior` is the other flatness measure available and is the wrong
 * way round: it gives a nearly-flat posterior a weight near 1 and a peaked one a
 * weight near 0, so the least informative photo would count most.
 */
export function unsurePoolWeight(
  p: PoolablePhoto,
  floors: Floors = DEFAULT_FLOORS,
): number {
  const cap = floors.species;
  const top =
    p.verdict?.topSpeciesP ??
    Math.max(...Object.values(p.scores ?? { })) ??
    0;
  if (!Number.isFinite(top) || top <= 0) return 0;
  return Math.min(top, cap);
}

const asMember = (p: PoolablePhoto, poolWeight: number, excludedBecause: PoolExclusion | null): PoolMember =>
  ({ ...p, poolWeight, excludedBecause });

/**
 * Which photos enter the pooled aggregate, and at what weight.
 *
 * This is the whole inclusion rule, and the weight is part of it rather than a
 * second pass over the same list, so the two cannot disagree about a photo.
 *
 *  - `species` / `genus`: in at full weight. The gate named something on it and
 *    its evidence is sound, whether the resolution was species or coarser.
 *  - `unsure`: in, down-weighted by `unsurePoolWeight`. Its logits are a real
 *    posterior and a user who ticked the box asked for it to be counted, so it
 *    corroborates a pool that agrees without being able to overrule one. What it
 *    cannot do is name a species: `pooledVerdict` still requires every photo in
 *    the pool to have claimed one, so checking an unsure photo caps the pooled
 *    claim at a genus. That is the honest reading - the pool now contains a
 *    photo that cannot name a species, so the pool does not either.
 *  - `non-mosquito`: out. "This is not a mosquito" is not weak evidence for any
 *    species, it is evidence against all of them, so there is no smaller weight
 *    that carries the same meaning - a photograph of a wall folded in at 0.1
 *    would dilute a real identification with evidence about a different subject,
 *    which is the one thing the pool exists to avoid. Its evidence belongs in
 *    the non-mosquito comparison (`aggregateAdjacent`), which is where the app
 *    reads it, not in the species sum.
 *  - pending, failed, or no verdict at all: out, because the aggregate would be
 *    folding in evidence that does not match the pixels on screen.
 *
 * updatePooling() must not grow a second copy of this predicate: the gate's job
 * is to decide what may be pooled, and a rendering function is not where that
 * belongs.
 */
export function splitPoolable(
  checked: PoolablePhoto[],
  floors: Floors = DEFAULT_FLOORS,
): PoolSplit {
  const included: PoolMember[] = [];
  const excluded: PoolMember[] = [];
  const pending: PoolMember[] = [];
  for (const photo of checked) {
    if (photo.pending || photo.error) {
      pending.push(asMember(photo, 0, null));
      continue;
    }
    const state = photo.verdict?.state;
    if (state === "species" || state === "genus") {
      included.push(asMember(photo, 1, null));
    } else if (state === "unsure") {
      included.push(asMember(photo, unsurePoolWeight(photo, floors), null));
    } else {
      excluded.push(asMember(photo, 0, state === "non-mosquito" ? "non-mosquito" : "no-verdict"));
    }
  }
  return { included, excluded, pending };
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
 *
 * The method's weights are then scaled by the `poolWeight` `splitPoolable`
 * attached to each photo, and the result is rescaled to the same total, so the
 * down-weighting moves weight BETWEEN photos rather than shrinking the sum. A
 * pool of three named photos and one unsure one is as sharp as the three; it
 * simply carries the unsure one's share, which is what "weighted appropriately"
 * has to mean - rescaling by the method's own total is also what keeps a photo
 * added to the pool from sharpening or flattening the claim for reasons that
 * have nothing to do with the evidence.
 *
 * A photo with no `poolWeight` counts as full: `splitPoolable` is what assigns
 * them, and a caller passing a bare literal is pooling a photo the gate named.
 */
export function poolingWeights(
  included: PoolablePhoto[],
  method: PoolingMethod,
  r: number,
): number[] {
  const N = included.length;
  if (!N) return [];
  const base = methodWeights(included, method, r);
  const pool = included.map((p) => {
    const w = (p as PoolMember).poolWeight;
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
  });
  // Every photo fully trusted: the method's answer, bit for bit.
  if (pool.every((w) => w === 1)) return base;
  // Restoring the method's own total means dividing by what the weights now sum
  // to, not by the pool weights alone - the two differ wherever a method's
  // weights are not uniform, which is exactly what "Weight by lead" is for.
  const after = base.reduce((a, b, i) => a + b * pool[i]!, 0);
  if (!(after > 0)) return base;
  const keepTotal = base.reduce((a, b) => a + b, 0) / after;
  return base.map((b, i) => b * pool[i]! * keepTotal);
}

function methodWeights(included: PoolablePhoto[], method: PoolingMethod, r: number): number[] {
  const N = included.length;
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
 * So the pool is gated on the PHOTOS, not on its own posterior: its resolution is
 * the coarsest resolution any photo in it reached. A species claim needs every
 * photo to have claimed a species; a genus claim needs every photo to have
 * reached a genus. Pooling exists to gather more evidence for a claim, never to
 * manufacture resolution the individual classifications did not have. The
 * pooled posterior still decides the genus, and a pool of genus-only photos
 * reports a genus.
 *
 * This matters more since an `unsure` photo entered the pool rather than being
 * dropped. Three flat photos - three photographs of a blank wall - pool to a
 * genus posterior above the 0.80 genus floor, so with a species-only gate the
 * pooled card answered the original bug's question at one resolution down: the
 * blank walls are announced as a genus. An unsure photo therefore caps the pool
 * at nothing rather than at a genus. It still contributes its evidence to the
 * ranking and the contribution table; what it withholds is a claim, and the pool
 * cannot claim what one of the photos the user checked would not claim itself.
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
  // "Not a mosquito" is a claim about every photo in the pool at once, and it
  // outranks a species claim rather than competing with one, so the photo gate
  // below does not apply to it. Neither does `unsure`: there is nothing to
  // gate, the floors already said no.
  if (v.state !== "species" && v.state !== "genus") return v;
  const claimed = included.map((p) => p.verdict?.state);
  // A photo with no verdict at all is not evidence that the pool may sharpen
  // past what its photos reached, so it blocks the claim rather than being
  // ignored.
  const everyPhotoClaimed = claimed.length > 0 && claimed.every((s) => s === "species");
  if (everyPhotoClaimed) return v;
  // One level down: a genus claim needs every photo to have reached a genus.
  // An `unsure` photo is pooled now, so the pool routinely contains one, and
  // three flat photos pool to a genus posterior above the 0.80 floor - three
  // photographs of a blank wall would otherwise be announced as a genus, which
  // is the claim this gate exists to prevent, just one resolution down. A pool
  // the user checked against a photo the app cannot name says so.
  const everyPhotoResolvedToGenus = claimed.length > 0 && claimed.every((s) => s === "species" || s === "genus");
  if (everyPhotoResolvedToGenus) return v.state === "species" ? { ...v, state: "genus", species: null } : v;
  return { state: "unsure", genus: null, species: null, topGenusP: v.topGenusP, topSpeciesP: v.topSpeciesP, runnersUp: v.runnersUp };
}
