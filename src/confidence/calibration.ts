// The fitted per-genus correction to the zero-shot head's species logits.
//
// These four numbers are MEASURED, not chosen. They were fitted on the 6,264-row
// BioCLIP H/14 embedding cache by minimising train NLL over a per-genus additive
// term on the species cosines, and validated on 1,252 uuid-grouped test rows
// (6,086 uuids) with a paired bootstrap. They correct a prompt artefact, not a
// property of the image representation: over train rows the head's per-genus
// logsumexp spread is 2.9 logits (Aedes 21.70 vs Anopheles 18.76) on fixed
// embeddings that were never fitted to anything, and this vector is close to the
// removal of that gap.
//
// Fitted by the precision investigation; raw outputs are
// `investigations/2026-10-03-precision/40-precision/99-calibration-ship/`,
// `final.json` -> `ship.constants.perGenusCosineOffset`.
// Measured effect: genus AURC +0.382 pp (CI [+0.185, +0.603]), genus argmax
// +2.88 pp (CI [+1.60, +4.23]), genus macro-F1 86.34 -> 90.59, species macro-F1
// 70.54 -> 71.16. It buys accuracy AND coverage at the shipped floors, so it is
// additive to them rather than a renegotiation of them - no floor and no
// temperature is refitted alongside it.
//
// COSINE units, not logit units, and added on the RAW COSINE side of
// softmaxJoint's scaling multiply:
//
//   logit_s = (cos_s + offset(genus_s)) * scale,   scale = logit_scale / temperature
//
// so the offset's contribution is offset * logit_scale / temperature = ~0.86
// logits at the shipped 98.86/2.5. This is NOT interchangeable with adding it to
// the scaled logit, and moving it across the multiply is not a tidy-up: it
// multiplies the offset by logit_scale (100.0 for the B/16 head), a silent 100x.
// It is on the cosine side so the calibration travels with a change of
// temperature or of model rather than being pinned to one logit_scale - at the
// cost of these values being calibrated at T = 2.5 and no other temperature.
//
// Nor is this a bias/intercept term. softmaxJoint is a bare `scale * dot`, with
// no bias anywhere, and a per-GENUS offset is a different object from the
// per-CLASS intercept sklearn's trained probe carries: a probe's intercept is a
// property of a fitted readout, whereas these four are a correction to a
// zero-shot head's prompts. (The culico rollout put a trained probe's intercept
// on the last column of a constant 1.0 coordinate appended to the model's output,
// which is the right shape for a scalar the model produces.) If a bias term is
// ever added to softmaxJoint, these stay where they are - folding them into it
// would change their size by logit_scale and invalidate the fit.
//
// DELIBERATELY CENTRED (mean 0). Softmax is shift-invariant, but the app's
// pipeline is not: the same vector carried through a per-genus *vector scaling*
// fit is not shift-invariant, and a common offset of ~15 logits moves that fit's
// answer by 5.4-7.4 logits. A centred vector is also identified - leaving the
// mean free just relabels what the model claims. Do not "fix" these into a shift;
// `tests/calibration.test.ts` asserts the mean.
//
// If the zero-shot head is ever replaced by a trained probe, delete this. The
// same offsets are worth -1.52 pp to a probe trained on these embeddings, because
// there a per-genus additive term is a pure class-prior correction and cannot
// move an argmax.
export const PER_GENUS_COSINE_OFFSET: Readonly<Record<string, number>> = Object.freeze({
  Aedes: -0.008713391998031056,
  Anopheles: 0.022077688488589337,
  Culex: -0.022324472825828463,
  Culiseta: 0.008960176335270137,
});

/**
 * The offset for one genus; 0 for a genus that has none.
 *
 * Returning 0 rather than throwing is deliberate: an uncalibrated genus must
 * still score, because a head carrying a genus this map has never seen is a
 * normal thing to construct in a test and a survivable thing to meet in the
 * wild. It is not, however, a case to ship silently - every genus in the shipped
 * head IS in the map, so a miss means the map has fallen behind the labels and
 * the calibration is quietly not applying to part of the head. `uncalibratedGenera`
 * reports those, and the coverage test asserts the set is empty for the real head.
 */
export function cosineOffsetFor(genus: string): number {
  return PER_GENUS_COSINE_OFFSET[genus] ?? 0;
}

/**
 * Every genus of a label set that this map does not calibrate. Empty for the
 * shipped head; non-empty means the offsets need refitting.
 */
export function uncalibratedGenera(species: readonly string[], genusOf: (name: string) => string): string[] {
  const missing = new Set<string>();
  for (const name of species) {
    const g = genusOf(name);
    if (!(g in PER_GENUS_COSINE_OFFSET)) missing.add(g);
  }
  return [...missing].sort();
}
