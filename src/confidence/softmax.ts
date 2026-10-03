import type { Floors, Head } from "./types";
import { localViewScale } from "./types";

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
  /** Species cosines, before scaling. Used for GENUS_MARGIN and the score panel. */
  spCos: number[];
  /** Species name -> its scaled logit. */
  logits: Record<string, number>;
}

export interface JointOptions {
  /** Nuisance class count. Defaults to the head's; 0 for a head without them. */
  nuisanceCount?: number;
  floors?: Floors;
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

  const dotAt = (base: Float32Array | number[] | undefined, i: number): number => {
    if (!base) return 0;
    const off = i * D;
    let d = 0;
    for (let k = 0; k < D; k++) d += base[off + k]! * emb[k]!;
    return d;
  };

  const spCos: number[] = [];
  for (let i = 0; i < S; i++) spCos.push(dotAt(head.species_emb, i));
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
    spCos,
    logits,
  };
}
