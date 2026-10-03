/**
 * The thumbnail strip's decisions, as pure functions of a photo record.
 *
 * Every enabled/disabled question the strip asks, every string it shows, and the
 * two index arithmetic a deletion performs, live here rather than in the render
 * path. They are pure — a photo in, a decision out — which is what makes the
 * whole cross-product of states checkable without a browser and without the
 * 1.26 GB classifier.
 *
 * `docs/THUMBNAIL-STRIP-SPEC.md` is the specification these implement, and its
 * section numbers are cited below.
 */

import type { ClassifiedPhoto } from "./types";

/** The six states a photo can be in. Spec §1. */
export type PhotoState =
  | "queued"
  | "cropped"
  | "uncropped"
  | "error"
  | "non-mosquito"
  | "unsure";

/**
 * Which state a photo is in, by the precedence in spec §1: the first matching
 * line wins. Derived, never stored — a photo that lands, is re-cropped and fails
 * is one record in three states over its life, and a stored state would be a
 * stale one.
 *
 * The precedence is not cosmetic. `error` and `pending` come first because they
 * describe the photo's pixels being unusable, which outranks anything the
 * classifier said about them; the two declining verdicts come next because a
 * photo that was analysed and refused a name is not "cropped" whatever the crop
 * says.
 */
export function photoState(p: ClassifiedPhoto): PhotoState {
  if (p.error) return "error";
  if (p.pending) return "queued";
  if (p.verdict?.state === "non-mosquito") return "non-mosquito";
  if (p.verdict?.state === "unsure") return "unsure";
  return p.is_cropped ? "cropped" : "uncropped";
}

/**
 * May the user LOOK at this photo? Spec §1.1.
 *
 * This was `isSelectable` doing this job and the pooling job at once, and the
 * conflation shipped as two bugs from one cause: a photo the classifier had
 * something to say nothing about had its checkbox disabled - and a disabled
 * checkbox silently ignores clicks, indistinguishable from a broken one - while
 * nothing on the tile said why. A photo whose classifier failed is still worth
 * looking at; the photo is fine and the classifier is what failed.
 *
 * "Cannot contribute to a pooled mosquito result" and "cannot be viewed" are
 * different decisions, and only this one is about the photo's pixels.
 */
export function canView(p: ClassifiedPhoto): boolean {
  return !!p;
}

/**
 * May this photo be checked into the pooled result? Spec §1.1.
 *
 * Three things close the checkbox, and each is a statement about the photo's
 * pixels: nothing is readable yet (`pending`), nothing was readable (`error`), or
 * the classifier looked at this photo and it is not a mosquito.
 *
 * A crop the nuisance gate rejected is deliberately not one of them. The gate
 * judges the crop; the whole frame was classified anyway and the verdict was
 * read off that frame, so the photo carries exactly the evidence a pool wants.
 * Striking it off here is what made feeding images to the classifier whole
 * achieve nothing.
 *
 * It is a permission, not a promise - `unsure` may be checked and IS pooled, at
 * a weight below a named photo's.
 */
export function contributesToPool(p: ClassifiedPhoto): boolean {
  if (!p || p.pending || p.error) return false;
  return p.verdict?.state !== "non-mosquito";
}

/**
 * If this photo were checked, would it enter the pooled SUM? Spec §1.1.
 *
 * Distinct from `contributesToPool`, which is the strip's permission. A photo
 * allowed to be checked is not always one that pooling will sum: `non-mosquito`
 * is allowed to be visible but is not pooled, because "this is not a mosquito"
 * is evidence against every species rather than weak evidence for one.
 *
 * `unsure` IS pooled, down-weighted by its own top posterior - a checked photo
 * is never silently dropped. What the down-weight bounds is the photo's
 * influence on the claim: the pool will not name a species while it holds a
 * photo that named none, which is `pooledVerdict`'s rule, not this one's.
 *
 * Restates `splitPoolable`'s rule rather than calling it, because this module is
 * imported by the strip and `splitPoolable` belongs to the confidence layer; the
 * two are checked against each other in `tests/thumbnail-strip.test.ts`, so a
 * change to one that is not made to the other fails a test rather than quietly
 * changing what a user sees.
 */
export function entersPooledSum(p: ClassifiedPhoto): boolean {
  if (p.pending || p.error) return false;
  const state = p.verdict?.state;
  return state === "species" || state === "genus" || state === "unsure";
}

const name = (p: ClassifiedPhoto): string => p.name ?? "(unnamed)";

/**
 * The checkbox's accessible name and tooltip, in one string, so the two can
 * never disagree. Spec §3.3.
 *
 * `idx` is the photo's current 1-based position; it is a parameter rather than
 * something read from the tile, because the name is regenerated on every render
 * and a stale position in an accessible name is the §4 invariant broken in the
 * one place a screen reader is listening.
 */
export function checkLabel(p: ClassifiedPhoto, idx: number): string {
  const base = `Include photo ${idx} (${name(p)}) in the pooled result`;
  if (p.pending) return "Still classifying - waiting for this photo to be analysed";
  if (p.error) return `This photo failed: ${p.error}`;
  // Plain language, not the mechanism's name. "Nuisance gate" is what the crop
  // engine calls it; what the user needs to know is that no mosquito was found.
  if (p.verdict?.state === "non-mosquito") return "The classifier found no mosquito in this photo";
  if (p.verdict?.state === "unsure") return `${base} — it will be listed as not confident enough to name a genus`;
  return base;
}

/**
 * Why a photo is kept out of the pooled sum, in a sentence about the photo.
 *
 * Returned rather than written at each of the several places that need it -
 * because a reason that exists in three places is a reason that will eventually
 * differ in two of them.
 */
export function poolExclusionReason(p: ClassifiedPhoto): string {
  if (!p) return "";
  if (p.error) return "Excluded from the combined result - analysis failed for this photo.";
  if (p.pending) return "Excluded from the combined result - still classifying.";
  if (p.verdict?.state === "non-mosquito") return "Excluded from the combined result - this does not look like a mosquito.";
  if (p.verdict?.state === "unsure") return "Not confident enough to name a genus - excluded from the pooled result";
  return "";
}

/** The select button's accessible name. Spec §3.1. */
export function viewLabel(p: ClassifiedPhoto, idx: number): string {
  return `View photo ${idx}: ${name(p)}`;
}

/** The delete button's accessible name. Spec §3.4. */
export function removeLabel(p: ClassifiedPhoto, idx: number): string {
  return `Remove photo ${idx}: ${name(p)}`;
}

/** The badge's glyph and tooltip. Spec §3.5 — never an empty title. */
export function badge(p: ClassifiedPhoto): { glyph: string; className: string; title: string } {
  switch (photoState(p)) {
    case "error":
      return { glyph: "!", className: "crop-badge error", title: p.error as string };
    case "queued":
      return {
        glyph: "…",
        className: "crop-badge pending",
        title: "Still classifying - not yet part of the combined result",
      };
    case "non-mosquito":
      // Its own badge, not the cropped one: the photo was analysed and it is not
      // a mosquito, which is the opposite of what a green tick says.
      return { glyph: "✕", className: "crop-badge non-mosquito", title: "No mosquito detected in this photo" };
    case "unsure":
      return { glyph: "?", className: "crop-badge unsure", title: "Detected, but not confidently enough to name a genus" };
    case "cropped":
      return { glyph: "✓", className: "crop-badge cropped", title: "Mosquito detected and cropped" };
    case "uncropped":
      // Neither the cross nor a sentence about a missing mosquito: failure to
      // crop can mean no mosquito, or a photo that was already cropped to one,
      // and the app cannot tell those apart. What it knows is that the whole
      // frame was the view it classified.
      return { glyph: "–", className: "crop-badge uncropped", title: "Whole photo analysed - no crop was used" };
  }
}

/**
 * The pooled card's summary line: how many photos are checked and how many of
 * those actually enter the sum. Spec §3.3, §8 row 5.
 *
 * A checked-but-not-contributing photo is a legitimate thing to be (spec §9), so
 * the card has to say which it is rather than leaving the user to compare three
 * tick marks against a table that quietly lists two of them.
 */
export function inclusionSummary(checked: number, contributing: number): string {
  if (checked === 0) return "No photos checked";
  if (contributing === checked) return `${checked} photo${checked === 1 ? "" : "s"} in the pooled result`;
  return `${checked} checked, ${contributing} in the pooled result`;
}

/**
 * `includedIndices` after the photo at `deleted` is removed. Spec §3.4.
 *
 * The deleted photo's own index goes; everything after it moves down one. An
 * index that was already out of range stays where it is and is dropped by
 * `validateIncluded`, which is the belt to this braces.
 */
export function shiftIncluded(indices: Iterable<number>, deleted: number): Set<number> {
  const out = new Set<number>();
  for (const i of indices) {
    if (i < deleted) out.add(i);
    else if (i > deleted) out.add(i - 1);
  }
  return out;
}

/**
 * `selectedIndex` after the photo at `deleted` is removed. Spec §3.4.
 *
 * The selection follows the photo, not the slot: deleting anything before the
 * selected photo moves the selection down with it, and deleting the selected
 * photo leaves the selection where it is so the photo that slid into that
 * position becomes the one on screen.
 */
export function shiftSelected(selected: number, deleted: number, newLength: number): number {
  if (newLength === 0) return 0;
  let next = selected;
  if (deleted < selected) next = selected - 1;
  else if (selected >= newLength) next = newLength - 1;
  return Math.max(0, Math.min(next, newLength - 1));
}

/**
 * The indices in `indices` that are in range for a strip of `length` photos.
 * Spec §3.4, §4.
 *
 * The strip is the only writer of `includedIndices`, so this is where an index
 * is made valid. `updatePooling` drops what it cannot resolve, and dropping it
 * silently is what let three ticked boxes reach a card that counted one of them.
 */
export function validateIncluded(indices: Iterable<number>, length: number): Set<number> {
  const out = new Set<number>();
  for (const i of indices) {
    if (Number.isInteger(i) && i >= 0 && i < length) out.add(i);
  }
  return out;
}

/**
 * `includedIndices` after a batch of `count` photos is prepended. Spec §4.
 *
 * A new batch goes in front, so every existing photo's index grows by `count`.
 */
export function shiftIncludedForPrepend(indices: Iterable<number>, count: number): Set<number> {
  return new Set(Array.from(indices, (i) => i + count));
}
