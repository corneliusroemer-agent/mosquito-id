import type { Floors, Head } from "./types";
import { localViewScale } from "./types";
import { PER_GENUS_COSINE_OFFSET } from "./calibration";
import { genusOf } from "./genus";

// The adjacent classes - Diptera that a non-expert reads as a mosquito - share
// the one softmax with the species and the nuisance classes, so "this is a
// biting midge" competes with "this is a mosquito" on the same numbers rather
// than through a second, separately-scaled score. A head from before the
// classes existed carries none, and then there is no non-mosquito evidence to
// read at all.
export function adjacentNames(head: Head): string[] {
  return head.adjacent && head.adjacent.length ? head.adjacent : [];
}

export interface JointResult {
  /** Species posteriors, summing with nuP and adP to 1. */
  spP: number[];
  /** Nuisance posteriors, index-aligned with `head.nuisance`. */
  nuP: number[];
  /** Adjacent posteriors, index-aligned with `adjacentNames(head)`. */
  adP: number[];
  /** Species name -> its scaled logit. */
  logits: Record<string, number>;
}

export interface JointOptions {
  /** Nuisance class count. Defaults to the head's; 0 for a head without them. */
  nuisanceCount?: number;
  floors?: Floors;
  /**
   * Per-genus cosine offsets. Defaults to the fitted `./calibration` map.
   * Present so a test can exercise the calibration with values of its own rather
   * than inferring its effect from a real head's 660 KB of embeddings.
   */
  offsets?: Readonly<Record<string, number>>;
}

/**
 * One softmax over every class the head knows: species, nuisance, adjacent.
 *
 * Pure in `head` and `emb`, which is the seam - the caller supplies the image
 * embedding, never a session, so this is testable against a synthetic head.
 */
export function softmaxJoint(
  head: Head,
  emb: ArrayLike<number>,
  opts: JointOptions = {},
): JointResult {
  const S = head.species.length;
  const N = opts.nuisanceCount ?? head.nuisance?.length ?? 0;
  const adj = adjacentNames(head);
  const AD = adj.length;
  const D = head.dim;
  const scale = localViewScale(head, opts.floors);
  const offsets = opts.offsets ?? PER_GENUS_COSINE_OFFSET;
  const offsetFor = (genus: string): number => offsets[genus] ?? 0;

  const dotAt = (base: Float32Array | number[] | undefined, i: number): number => {
    if (!base) return 0;
    const off = i * D;
    let d = 0;
    for (let k = 0; k < D; k++) d += base[off + k]! * emb[k]!;
    return d;
  };

  // Internal only: the species cosines build the joint softmax below and the
  // per-species logits. Nothing outside this function reads them.
  //
  // The species cosines carry the fitted per-genus calibration (see
  // ./calibration), added HERE - to the raw cosine, before the scaling multiply
  // below - so it reaches both the softmax and the reported logits through this
  // one array. Moving the offset to the scaled side is not equivalent and not a
  // tidy-up: it multiplies it by logit_scale, which is 100.0 for the B/16 head.
  // Read ./calibration before changing the line below.
  const spCos: number[] = [];
  for (let i = 0; i < S; i++) {
    spCos.push(dotAt(head.species_emb, i) + offsetFor(genusOf(head.species[i]!)));
  }
  const nuCos: number[] = [];
  for (let i = 0; i < N; i++) nuCos.push(dotAt(head.nuisance_emb, i));
  const adCos: number[] = [];
  for (let i = 0; i < AD; i++) adCos.push(dotAt(head.adjacent_emb, i));

  const sims = spCos.concat(nuCos, adCos).map((c) => scale * c);
  const mx = Math.max(...sims);
  const ex = sims.map((v) => Math.exp(v - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  const p = ex.map((v) => v / sum);

  const logits: Record<string, number> = {};
  head.species.forEach((name, i) => {
    logits[name] = scale * spCos[i]!;
  });
  return {
    spP: p.slice(0, S),
    nuP: p.slice(S, S + N),
    adP: p.slice(S + N),
    logits,
  };
}
