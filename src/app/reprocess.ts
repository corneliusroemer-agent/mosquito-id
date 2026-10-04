/**
 * Whether the photos on screen need re-running against the engine now selected,
 * and what the button that offers it says.
 *
 * Switching the engine changes what the NEXT photo will be scored by and nothing
 * about the photos already loaded, so their scores stay the ones the previous
 * engine gave them while the footer names the new one. Re-running them is not
 * free - inference over every loaded photo, which is minutes and a lot of
 * battery on the phone this is mostly used on - so it is an explicit action
 * rather than a consequence of the switch, and the button being there is what
 * says the scores are stale.
 *
 * Staleness is read per photo rather than held as one flag, because whether a
 * photo is stale is a fact about that photo: one dropped after the switch was
 * scored by the new engine and is not stale, and switching back to the engine
 * that scored the others makes them current again. A single boolean can say
 * neither, and would keep offering to re-run work that is already done.
 *
 * A photo with no `scoredBy` is not stale. It has no scores yet - queued, still
 * decoding, or its classification failed - so nothing on screen is claiming to be
 * an answer from another engine.
 */

/** What staleness reads off one photo. Everything else about a photo is ignored. */
export interface ScoredPhoto {
  /**
   * The engine whose scores this photo is currently showing.
   *
   * Written where scores are committed, not where the engine is chosen, so it
   * records what produced the numbers rather than what was selected at the time.
   */
  scoredBy?: string | null;
  /** Set once the photo has left the gallery; such a photo is not on screen. */
  removed?: boolean;
}

/**
 * The photos whose scores came from an engine other than the selected one, in
 * gallery order.
 *
 * Takes the array rather than reaching for app state, so the whole rule is
 * checkable without a browser, a model, or the rest of the app.
 */
export function stalePhotos<T extends ScoredPhoto>(photos: readonly T[], engine: string): T[] {
  return photos.filter((p) => p && !p.removed && !!p.scoredBy && p.scoredBy !== engine);
}

/** What a photo has to offer a re-run: the box it was cropped to, if it has one. */
export interface CroppedPhoto {
  /** The box the crop was cut from, in full-frame pixels. Null when there is none. */
  cropBox?: number[] | null;
  /** The pixels that box was cut to. Null before the crop is cut, or for a whole photo. */
  cropCanvas?: unknown | null;
  /**
   * Set when the USER gave this photo up on its crop and asked for the whole
   * frame - `revertToFullPhoto`, not the detector finding nothing.
   *
   * Distinct from `manual_full_photo`, which the batch also sets on a photo the
   * detector found no box in: both display the whole frame, but one is the
   * user's decision about a photo that HAD a crop, and re-detecting over it
   * silently takes that decision back. Without this field a re-run cannot tell
   * the two apart, and a deliberate revert is destroyed with no undo.
   */
  revertedToFull?: boolean;
}

/**
 * Split the photos a re-run has to cover by the work each one needs.
 *
 * The button exists to recompute SCORES against the engine now selected, and
 * scores come from classification. A photo that already carries a crop box -
 * whether the detector's or one the user drew - has everything classification
 * needs, so the detector is pure waste on it: minutes of inference on a phone, and
 * a manual crop destroyed by its own re-run. A photo the user reverted to the
 * whole frame has a decision to preserve rather than a box, and classifying the
 * whole frame is both cheaper and what the user asked for.
 *
 * A photo with neither has nothing to classify but the whole frame, and getting
 * a crop is what makes a second view possible at all, so those still go through
 * detection.
 */
export function splitForRerun<T extends CroppedPhoto>(
  photos: readonly T[],
): { classify: T[]; detect: T[] } {
  const classify: T[] = [];
  const detect: T[] = [];
  for (const p of photos) {
    // A four-number box and the pixels it produced. A half-set pair - a box with
    // no canvas because the crop was never cut - cannot be classified from, so it
    // takes the detection path rather than failing.
    if (!p) continue;
    const cropped = Array.isArray(p.cropBox) && p.cropBox.length === 4 && p.cropCanvas;
    if (cropped || p.revertedToFull === true) classify.push(p);
    else detect.push(p);
  }
  return { classify, detect };
}

/** The button's box, as far as drawing it is concerned. */
export interface ReprocessButtonView {
  style: { visibility: string };
  disabled: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface ReprocessButtonState {
  /** How many photos would be re-run. Zero means the button is not offered. */
  stale: number;
  /** The selected engine, named the way the dropdown names it. */
  engineLabel: string;
  /**
   * Why the button cannot be pressed right now, or null when it can.
   *
   * A reason rather than a boolean, because there are two distinct ones and the
   * reader has to be able to tell which: a batch is writing into the gallery a
   * re-run would empty, or the selected engine's weights are still downloading
   * and a click would run the PREVIOUS engine's classifier over the photos and
   * then label the result with the new engine's name - the exact confusion this
   * button exists to end.
   */
  blockedBy: string | null;
}

/**
 * Draw the reprocess button.
 *
 * Shown exactly when something is stale, and disabled while it is blocked: the
 * scores stay stale while either is true, and a disabled control that says why
 * is a different thing from one that does not.
 *
 * `visibility` rather than removal or `display: none`, so the button's space is
 * reserved from first paint and its arrival moves nothing - the same trade
 * `.progress-slot` and `#score-uncertain` make. Its text never changes either, so
 * the reserved box is the same width in both states; the photo count goes in the
 * accessible name, where a second line of width would cost the page a shift.
 */
export function renderReprocessButton(el: ReprocessButtonView, state: ReprocessButtonState): void {
  const shown = state.stale > 0;
  el.style.visibility = shown ? "visible" : "hidden";
  el.disabled = state.blockedBy !== null;
  if (!shown) {
    // A hidden button keeping its count would announce a number the page has no
    // reason to state, and a control left focusable while invisible is a tab
    // stop that goes nowhere.
    el.removeAttribute("aria-label");
    el.removeAttribute("title");
    return;
  }
  const photos = `${state.stale} photo${state.stale === 1 ? "" : "s"}`;
  // Says the work, not the mechanism. "From the crops already on screen" would
  // be false for a gallery holding a photo with no crop - that one is detected
  // again, because a second view needs a crop and there is none - and a label
  // that is wrong about half the gallery is worse than one that is vaguer.
  const why = state.blockedBy ?? `Re-score ${photos} with ${state.engineLabel}, the engine now selected`;
  el.setAttribute("aria-label", why);
  el.setAttribute("title", why);
}

/** A photo's own bytes, or the decoded pixels they decode to. */
export interface PhotoSource {
  /** The photo as it arrived. Kept for a re-run; absent for a photo built another way. */
  file?: File | null;
  fullCanvas?: { toBlob: (cb: (b: Blob | null) => void, type?: string, q?: number) => void } | null;
  name?: string;
}

/**
 * The File this photo can be re-dropped as, or null when it has neither one.
 *
 * Normally this is the photo's own File, which the batch keeps for exactly this.
 * The canvas is the fallback for a photo that has none: one built from a zip
 * entry or a clipboard paste under a name the batch did not mint, or one a test
 * installed directly. Encoding that back gives the batch the same photograph
 * rather than a second approximation of one.
 *
 * JPEG at 0.95 rather than PNG: the re-encoded photo is decoded straight back
 * into a canvas and then downsampled to 224px for the classifier and 640px for
 * the detector, well below the quality a second JPEG generation can lose, and a
 * PNG of a phone photo is an order of magnitude more bytes to encode.
 */
export async function sourceFileFor(p: PhotoSource): Promise<File | null> {
  if (p.file) return p.file;
  const cv = p.fullCanvas;
  if (!cv) return null;
  const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return null;
  // The name has to carry an extension the batch accepts: `processFiles` filters
  // on it and drops a file without one in silence. Every intake that mints a name
  // already ends it with one, so this guards the photo whose name came from
  // somewhere else rather than naming that case here.
  const name = p.name || "photo.jpg";
  return new File([blob], /\.(jpe?g|png|webp|bmp)$/i.test(name) ? name : `${name}.jpg`, {
    type: blob.type || "image/jpeg",
  });
}
