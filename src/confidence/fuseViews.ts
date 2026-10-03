import type { Agreement, Floors, Head, Verdict, ViewResult } from "./types";
import { DEFAULT_FLOORS } from "./types";
import { adjacentNames } from "./softmax";
import { genusScores } from "./genusScores";
import { verdictFrom } from "./verdict";
import { viewAgreement } from "./viewAgreement";

export interface FusedResult {
  /** Genus -> summed posterior, possibly with a "- low confidence" demotion. */
  labels: Record<string, number>;
  /** Species -> fused posterior. */
  detail: Record<string, number>;
  /** Species -> logit on the single-view scale, so a fused photo is comparable. */
  logits: Record<string, number>;
  demoted: boolean;
  spP: number[];
  /** Pooled nuisance posteriors, as a one-element array (mass only). */
  nuP: number[];
  adP: number[];
  /** Fused cosines, recovered from the posterior and shifted so the best is 0. */
  spCos: number[];
  nViews: number;
  /** Plain-language adjacent name -> posterior. */
  adjacentDetail: Record<string, number>;
  agreement: Agreement | null;
  verdict: Verdict;
}

/**
 * Pool two or more views of one photo.
 *
 * One crop is one opinion about what is in the frame, and it is a fallible one:
 * a slightly-off box puts background in the picture, or clips the wing pattern
 * the classifier reads. Classifying the same photo twice - once on the
 * detector's crop, once on the whole frame - and combining the two is worth
 * +4.5 points of top-1 on the 112-image Mosquito Alert benchmark (84.8% ->
 * 89.3%), the largest single win measured in that investigation.
 *
 * The pooling rule is equal-weight log-linear: log p ∝ Σ_v log p_v. A view that
 * is undecided contributes a flat distribution and moves the sum a little; a
 * view that is sure moves it a lot. Both views count the same however sure
 * either is, which is what "equal weight" means here and is the rule the +4.5
 * was measured with. Averaging the probabilities instead would let one
 * confident view swamp the other rather than being outvoted by it.
 *
 * Species posteriors and the nuisance mass are pooled separately, then
 * normalised once over the two together. The nuisance classes only ever enter as
 * their combined mass, never individually: softmaxJoint's nuisance gate has
 * already used them per view to decide whether a crop is worth classifying, and
 * letting eight nuisance classes vote on which species this is would mix that
 * decision into the species verdict. Pooling the mass separately keeps the fused
 * species posteriors on the same scale as a single view's - they sum to less
 * than 1, by however much the nuisance took - which is what lets one photo's
 * fused score be read next to another's un-fused one, and next to the
 * pooled-across-photos score.
 *
 * The adjacent classes are pooled the same log-linear way but keep their
 * individual identities: the whole point of having them is being able to say
 * WHICH non-mosquito it was. A view that carries no adjacent posteriors
 * contributes NO mass rather than a flat share - a flat share would invent an
 * even split of evidence nobody supplied and could carry the gate on its own.
 *
 * Every view must carry the same `scale`. The pool itself does not need it - it
 * works on probabilities, which are already on whatever scale produced them -
 * but it is needed to recover cosines and logits from the fused posterior.
 *
 * With one view this is algebraically identical to that view's own softmax, so
 * there is no separate single-view path to keep in step.
 */
export function fuseViews(
  head: Head,
  viewResults: ViewResult[],
  floors: Floors = DEFAULT_FLOORS,
): FusedResult | null {
  const S = head.species.length;
  const names = head.species;
  const V = viewResults.length;
  if (!V) return null;

  const scale = viewResults[0]!.scale;
  if (viewResults.some((v) => v.scale !== scale)) {
    // Views on different scales cannot be pooled meaningfully, and rather than
    // produce a number that looks like a fused score but is not one, say so.
    console.warn(
      "fuseViews: views on different scales, not pooling",
      viewResults.map((v) => v.scale),
    );
    return fuseViews(head, [viewResults[0]!], floors);
  }

  const logSum = new Array<number>(S).fill(0);
  let logNu = 0;
  for (const v of viewResults) {
    for (let i = 0; i < S; i++) logSum[i]! += Math.log(Math.max(v.spP[i]!, 1e-12));
    logNu += Math.log(Math.max(v.nuTotal, 1e-12));
  }
  const mx = Math.max(logNu, ...logSum);
  const ex = logSum.map((l) => Math.exp(l - mx));
  const nu = Math.exp(logNu - mx);
  const sum = ex.reduce((a, b) => a + b, 0) + nu;
  const spP = ex.map((e) => e / sum);
  const nuP = [nu / sum];

  const adjNames = adjacentNames(head);
  const A = adjNames.length;
  let adP: number[] = [];
  // Only pool the adjacent classes if some view actually scored them. A caller
  // passing views without `adP` (a server path, or an embeds file from before
  // the classes existed) gets none, and the non-mosquito gate then cannot fire
  // at all - which is right: it has no evidence to fire on.
  if (A && viewResults.some((v) => v.adP)) {
    const logAd = new Array<number>(A).fill(-Infinity);
    for (const v of viewResults) {
      for (let i = 0; i < A; i++) {
        if (!v.adP || !Number.isFinite(v.adP[i]!)) continue;
        const l = Math.log(Math.max(v.adP[i]!, 1e-12));
        logAd[i] = Number.isFinite(logAd[i]!) ? logAd[i]! + l : l;
      }
    }
    const mxAd = Math.max(logNu, ...logSum, ...logAd.filter(Number.isFinite));
    const exAd = logAd.map((l) => (Number.isFinite(l) ? Math.exp(l - mxAd) : 0));
    const sumAd =
      logSum.reduce((a, l) => a + Math.exp(l - mxAd), 0) +
      Math.exp(logNu - mxAd) +
      exAd.reduce((a, b) => a + b, 0);
    adP = exAd.map((e) => e / sumAd);
  }

  // genusScores needs cosine similarities to apply GENUS_MARGIN, and the pooling
  // card needs logits. Recovering both from the fused posterior is not an
  // approximation: log p_i = scale * cos_i - logZ, so (log p_i - log p_best) /
  // scale is exactly cos_i - cos_best, and every consumer of these two
  // quantities takes differences. The recovered cosines are therefore shifted by
  // a constant - best species at 0 - which no consumer can see, and are otherwise
  // the fused view's real ones.
  //
  // The logits below are built from spCos, not from lp: lp is a log-probability
  // and multiplying one by the logit scale gives numbers ~100x the axis they are
  // plotted on.
  const lp = spP.map((p) => Math.log(Math.max(p, 1e-12)));
  const best = Math.max(...lp);
  const spCos = lp.map((l) => (l - best) / scale);

  const detail: Record<string, number> = {};
  const logits: Record<string, number> = {};
  names.forEach((n, i) => {
    detail[n] = spP[i]!;
    logits[n] = scale * spCos[i]!;
  });

  const c = genusScores(head, spP, spCos, floors);
  // The gate reads the FUSED posterior, which is the whole point of fusing
  // before deciding: one view alone is an opinion, the pool of the two is the
  // photo's score.
  //
  // ...and the agreement of the very views that were pooled, which the fused
  // posterior cannot express: an average of two contradictory opinions is still
  // an average. Computed once here and handed to both the verdict and the
  // caller - a second caller recomputing it would be a second disagreement
  // measure, free to drift from the one the gate read.
  const agreement = viewAgreement(
    head,
    viewResults.map((v) => v.spP),
    spP,
  );
  // The per-class non-mosquito posteriors keyed by the plain-language name, so
  // the score panel can say WHICH non-mosquito it is without re-deriving the
  // softmax. A class the head does not carry is simply absent here and the
  // non-mosquito state cannot fire, which is what makes the state safe on an
  // older embeds file.
  const adjacentDetail: Record<string, number> = {};
  adjacentNames(head).forEach((fam, i) => {
    adjacentDetail[(head.adjacent_common && head.adjacent_common[i]) || fam] = adP[i] || 0;
  });

  return {
    labels: c.labels,
    detail,
    logits,
    demoted: c.demoted,
    spP,
    nuP,
    adP,
    spCos,
    nViews: V,
    adjacentDetail,
    agreement,
    verdict: verdictFrom(head, spP, agreement, adP, floors),
  };
}
