/**
 * Whether a downscaled copy of a photo can stand in for the photo itself.
 *
 * `classifyImage` reads the decoded photo twice at full resolution: once for
 * the detector's letterboxed input and once for the classifier's whole-frame
 * view. On a phone's 12-50 MP photograph that is two resamples of the whole
 * frame where one would do, so the detector's own intermediate is offered to
 * the classifier instead. That is only sound if the intermediate really is the
 * same picture, and this is the check that makes it so rather than an
 * assumption at the call site.
 *
 * Pure geometry over sizes: nothing here knows about canvases, sessions or the
 * DOM, so the rule can be tested directly and both views can be checked
 * against it.
 */

/** The two numbers a size check needs; a canvas satisfies it structurally. */
export interface Sized {
  width: number;
  height: number;
}

/**
 * How far two aspect ratios may differ and still be called the same picture.
 *
 * The intermediate and the photo are rounded to whole pixels independently, so
 * they are never bit-equal in ratio; 2% is far more than the rounding of any
 * plausible pair of dimensions costs, and far less than a wrong source - a
 * portrait handed in for a landscape photo differs by tens of percent.
 */
const ASPECT_TOLERANCE = 0.02;

/**
 * Whether `mid` may replace `full` as the source for a resize to `targetShort`.
 *
 * Two things have to hold, and the second is the one that bites:
 *
 * 1. **Same aspect ratio.** A resize scales both axes by one factor, so a
 *    different shape would stretch the result.
 * 2. **`targetShort` fits inside `mid`'s short edge.** The classifier scales
 *    the short edge up to `targetShort`, and a step that *enlarges* is a blur
 *    the direct-from-the-photo path would never have taken. The detector's
 *    intermediate is as small as it is on a panorama - an 8:1 frame lands with
 *    a 78 px short edge at 640 - so this rejects exactly the photographs the
 *    intermediate is too coarse for, and those fall back to reading the photo.
 */
export function isUsableIntermediate(
  mid: Sized | null | undefined,
  full: Sized,
  targetShort: number
): boolean {
  if (!mid || !(mid.width > 0) || !(mid.height > 0)) return false;
  if (!(full.width > 0) || !(full.height > 0)) return false;
  if (!(targetShort > 0)) return false;
  // Cross-multiplied rather than divided, so a zero above is not a division.
  const left = mid.width * full.height;
  const right = mid.height * full.width;
  if (Math.abs(left - right) > ASPECT_TOLERANCE * Math.max(left, right)) return false;
  return Math.min(mid.width, mid.height) >= targetShort;
}
