import type { Floors, Head, Verdict } from "./types";
import { DEFAULT_FLOORS } from "./types";
import { genusOf } from "./genus";
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
 * The pooled card's headline, from the POOLED posterior and not from a mean of
 * per-photo verdicts: the logits are the per-photo log-probabilities up to a
 * constant, so softmax(aggLogits) is the pooled posterior exactly, and one gate
 * on it is the pooled claim. Averaging per-photo verdicts instead would let two
 * confident photos outvote a third that pooled with them says nobody knows.
 *
 * `agreement` is null by construction: the pool is a claim about several photos,
 * not about the two views of one, so the view-disagreement veto has nothing to
 * read here and the per-photo gate has already done that work.
 */
export function pooledVerdict(
  head: Head,
  aggLogits: Record<string, number>,
  floors: Floors = DEFAULT_FLOORS,
): Verdict | null {
  const spP = pooledPosterior(head, aggLogits);
  // The `[]` here is the pooled card's structural gap, stated in full rather
  // than left as an omitted argument: pooledPosterior softmaxes over the 16
  // species alone, so no adjacent mass exists to pass and the non-mosquito
  // branch cannot run. Three photos each reading 97% biting midge are announced
  // as a species here. Carrying the adjacent classes through the pool is
  // prerequisite to this card ever being able to say "not a mosquito", and is
  // separate from - and not fixed by - gating the species floor.
  //
  // `[]` is deliberate and greppable. That is the point of making `adP` a
  // required parameter of verdictFrom: this omission can no longer happen by
  // forgetting an argument, only by writing this line.
  return spP ? verdictFrom(head, spP, null, [], floors) : null;
}
