/**
 * Which views of a photo are classified and pooled.
 *
 * Two views of a cropped photo - the detector's crop and the whole frame - are
 * the app's largest measured accuracy win (+4.5 points of top-1). Which views a
 * given photo offers is therefore a decision with three outcomes rather than
 * two, and it was inlined at each of the three places a photo gets classified,
 * where only the two-view case was written down.
 *
 * Pure and in one module so the decision is checkable without the 1.26 GB
 * classifier and without a browser, for the same reason `thumbnailStrip.ts` is:
 * every consumer of a decision is not a consumer of its branches.
 */

/** What one classified view is a picture of. */
export type ViewKind = "crop" | "whole";

/**
 * The views of one photo, in the order they are classified.
 *
 * A photo with a crop offers the crop first, because the nuisance gate is a
 * statement about the crop: if the best species on it loses to the best nuisance
 * class, the crop is not worth a second opinion. The whole frame is the second
 * opinion, and it is optional - `includeWholeFrame` off means a cropped photo is
 * judged on the crop alone.
 *
 * A photo with no crop has exactly one view whatever the preference says. The
 * whole frame there is not an addition to a crop, it is what there is, so
 * dropping it would leave a photo with nothing to judge and no posterior at all.
 * The returned list is never empty for that reason, and a caller cannot turn it
 * into an empty one.
 */
export function viewKinds(hasCrop: boolean, includeWholeFrame: boolean): ViewKind[] {
  if (!hasCrop) return ["whole"];
  return includeWholeFrame ? ["crop", "whole"] : ["crop"];
}

/** localStorage key. Namespaced with the app's other preference, as that one is. */
export const WHOLE_FRAME_KEY = "mosquito_include_whole_frame";

/**
 * Off, because measured crop-only fusion is at least as accurate as crop+whole
 * on every fixture tried, so the whole frame is a view that costs work without
 * buying accuracy. It stays in the UI as a toggle for the photos where the
 * detector found nothing to crop - that is what the "no crop" branch of
 * `viewKinds` is for, and a user who turns it on gets it back for every photo.
 */
export const DEFAULT_INCLUDE_WHOLE_FRAME = false;

/** The narrow slice of `Storage` this reads, so a test can pass a plain object. */
export interface PreferenceStore {
  getItem(key: string): string | null;
}

/**
 * The stored preference, or the default.
 *
 * A stored value is compared, not parsed, so a key left behind by an older or
 * newer build - or by a hand edit - cannot produce a third state: only the exact
 * string `"true"` turns the whole frame on, and everything else is off. Reading
 * storage can throw (a browser with storage disabled, a `localStorage` access
 * denied in a private context), and a preference that cannot be read is the
 * default, not a blank page.
 *
 * Note what that means for the *legacy* key. The default was once on and this
 * key has never been written by a build that stored `true` for it, so every
 * existing user's stored value is `"false"` (crop-only, asked for explicitly) or
 * absent. Absent now reads as off, which is the new default; `"false"` still
 * reads as off. Nobody who never touched the toggle loses the whole frame
 * silently - they simply land on the measured-better default.
 */
export function readIncludeWholeFrame(store: PreferenceStore | null): boolean {
  if (!store) return DEFAULT_INCLUDE_WHOLE_FRAME;
  let raw: string | null;
  try {
    raw = store.getItem(WHOLE_FRAME_KEY);
  } catch {
    return DEFAULT_INCLUDE_WHOLE_FRAME;
  }
  if (raw === null || raw === undefined) return DEFAULT_INCLUDE_WHOLE_FRAME;
  return raw === "true";
}