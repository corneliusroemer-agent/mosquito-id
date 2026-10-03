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
  const ranked = [...fusedSpP].sort((a, b) => b - a);
  const marginPts = (ranked[0]! - ranked[1]!) * 100;

  return {
    agree: winners.every((w) => w === top),
    topSpecies: head.species[top]!,
    runnersUp: head.species.filter((_, i) => winners.includes(i) && i !== top),
    marginPts,
    fusedTop: fusedSpP[top]!,
  };
}

/**
 * One-line plain-English rendering of the agreement signal. Not rendered: the
 * two-view agreement was shown as a sentence in the score panel, and the panel
 * shows species scores only. Kept for the data path and for anyone who wants
 * the signal in a tooltip or a log. It is a statement about the photograph, not
 * about the model: it says what the two views of this picture disagree about and
 * how close the call is.
 */
export function agreementSentence(a: Agreement | null): string {
  if (!a) return "";
  if (a.agree) {
    return `Both views of this photo pick ${a.topSpecies} — the close-up and the whole picture agree.`;
  }
  const other = a.runnersUp.length ? a.runnersUp[0]! : null;
  const gap = other ? `, with ${other} close behind` : "";
  return `The close-up and the whole picture disagree${gap}. The two leading species are within ${a.marginPts.toFixed(1)} points, so treat this one as undecided.`;
}
