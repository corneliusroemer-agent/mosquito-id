import type { Head } from "./types";
import { informativeRows } from "./softmax";

/**
 * Should this crop be kept as a view of its photo?
 *
 * The gate is a statement about the CROP: when a nuisance class beats every
 * species class on it, the crop is not a mosquito worth a second opinion and the
 * photo falls back to the whole frame. Only a crop that passes is pooled.
 *
 * It reads the same rows `nonMosquitoGate` reads, and for the same reason. A
 * nuisance row whose only non-zero weight is the head's bias coordinate is a
 * constant vector: it scores every photograph alike, so its posterior rises
 * exactly when the classifier is unsure. Read as evidence it is the classifier's
 * own hesitation coming back as a finding, and a gate that acts on it throws away
 * the crops it would learn most from - on an undecided crop the placeholders win
 * by default, because no species row has anything to say. culico's eight
 * nuisance rows are all of that shape.
 *
 * A head with no bias coordinate has no such rows and loses nothing here: the
 * two shipped text heads are read in full, as they were.
 */
export function cropPassesGate(head: Head, spP: number[], nuP: number[]): boolean {
  const keep = informativeRows(head, head.nuisance_emb, Math.max(head.nuisance?.length ?? 0, nuP.length));
  let top = -Infinity;
  for (let k = 0; k < nuP.length; k++) {
    // A non-finite posterior is skipped, as `nonMosquitoGate` skips it: the two
    // gates must not disagree about which rows are evidence, and that includes
    // which of them are readable.
    if (keep[k] && Number.isFinite(nuP[k])) top = Math.max(top, nuP[k]!);
  }
  return Math.max(...spP) >= top;
}
