/**
 * Object URLs for a photo's own bytes, one per photo record.
 *
 * The viewer used to show `canvas.toDataURL("image/jpeg", 0.9)` of the full-
 * resolution canvas: a synchronous 12-50 MP JPEG encode (~100 ms) on the click
 * that selects a photo. The original File is already in memory and the browser
 * decodes it itself, so an object URL costs nothing at selection time.
 *
 * Orientation: `createImageBitmap(file, { imageOrientation: "from-image" })`
 * produces the canvas, and `<img>` applies EXIF orientation by default
 * (`image-orientation: from-image`), so the two agree on pixels and dimensions.
 *
 * Keyed on the photo record, not the File: a re-run builds a new record from the
 * same File, and revoking the old record's URL must not break the new one.
 */
const urls = new WeakMap<object, { file: Blob; url: string }>();

/** Every URL currently live, so a leak is observable from a test. */
let live = 0;
export const liveObjectUrlCount = (): number => live;

export interface HasFile {
  file?: Blob | null;
}

/** The object URL for `p.file`, or null if the photo has no source file. */
export function photoObjectUrl(p: HasFile): string | null {
  const file = p.file;
  if (!file) return null;
  const hit = urls.get(p);
  if (hit && hit.file === file) return hit.url;
  if (hit) releasePhotoUrl(p);
  const url = URL.createObjectURL(file);
  urls.set(p, { file, url });
  live++;
  return url;
}

/** Revoke `p`'s URL, if it has one. Safe to call twice. */
export function releasePhotoUrl(p: object): void {
  const hit = urls.get(p);
  if (!hit) return;
  urls.delete(p);
  URL.revokeObjectURL(hit.url);
  live--;
}
