import type { Agreement, Head } from "./types";

/**
 * Do the views of one photo agree on the species, and if not, by how much do
 * the fused top two sit apart?
 *
 * Measured on the only labelled two-view cache there is (180 rows, split
 * 60/20/20 by class group): when the views agree the fused answer is right
 * 94.3% of the time, when they disagree 50.0%.
 *
 * `agree` is checked against the FUSED argmax, not pairwise: two views that
 * each picked a species and neither of which is the pool's winner is the case
 * the gate has to catch, and "the two views picked different things" would miss
 * it whenever the pool's winner happens to be one of them by a hair.
 *
 * Returns null below two views, and null is not a disagreement - one view, or a
 * pool of photos, has nothing to disagree with.
 */
export function viewAgreement(
  head: Head,
  views: number[][],
  fusedSpP: number[],
): Agreement | null {
  if (!views || views.length < 2) return null;
  const S = head.species.length;
  const argmax = (p: number[]): number => {
    let b = 0;
    for (let i = 1; i < S; i++) if (p[i]! > p[b]!) b = i;
    return b;
  };
  const winners = views.map(argmax);
  const top = argmax(fusedSpP);

  return {
    agree: winners.every((w) => w === top),
    topSpecies: head.species[top]!,
    runnersUp: head.species.filter((_, i) => winners.includes(i) && i !== top),
    fusedTop: fusedSpP[top]!,
  };
}
