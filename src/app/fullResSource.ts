/**
 * A photo's pixels at two sizes: the display copy the record keeps, and the
 * full-resolution frame it hands back on demand.
 *
 * The record used to keep the full-resolution canvas of every photo it held,
 * which is linear in the gallery with no plateau: on a 12-megapixel photograph
 * that is 45.8 MiB for the frame, and with a detection's crop and context
 * region on top of it, 108.6 MiB per photo. A hundred photographs is nearly
 * eleven gigabytes, and none of it is needed to look at them.
 *
 * What the app actually needs per photo is a canvas the panels can paint - and
 * the panels are CSS boxes a few hundred pixels across, so 2048 px on the long
 * edge is more than any display shows - plus the `File`, which the browser
 * already holds and can decode again for nothing. So the frame goes and the two
 * paths that genuinely read full-resolution pixels - cutting a crop, and
 * re-running the classifier - get it back from here.
 *
 * Two things have to be true of that, and both are about time rather than
 * memory. A decode is not free - a 12 MP frame is hundreds of milliseconds - so
 * callers that arrive together share one decode instead of queueing one each,
 * and callers that arrive one after another get the frame that is already
 * decoded. And the retention bound is one frame, not one per photo: a hundred
 * crop draws still hold one, because the point was never to make the second
 * decode cheap, it was to stop the hundredth frame being resident forever.
 */

/** The two numbers a size check needs; a canvas satisfies it structurally. */
export interface Sized {
  width: number;
  height: number;
}

/**
 * Longest edge of a retained display canvas.
 *
 * Well past the densest thing that paints one - the panels are CSS boxes and
 * `object-fit` scales them - and past the 3x device-pixel density of a phone, so
 * no display shows a missing pixel. Chosen as a round number rather than
 * derived: the saving is in the ratio, and 2048 px of a 12 MP frame is already
 * a thirty-fold cut.
 */
export const DISPLAY_MAX_EDGE = 2048;

/** Anything that can be drawn into a canvas and knows its own size. */
type Drawable = Sized & (HTMLCanvasElement | ImageBitmap);

/**
 * A copy of `src` with its longest edge at most `maxEdge`, or `src` itself when
 * it is already that small and is a canvas.
 *
 * Returning the source rather than a copy for a small image is not a
 * micro-optimisation: it means a photo whose frame is under the cap has exactly
 * one canvas, so there is nothing to keep in step and nothing to free. A bitmap
 * has no canvas to return, so that case always gets a copy.
 */
export function displayCanvasFrom(
  src: Drawable,
  maxEdge: number = DISPLAY_MAX_EDGE,
): HTMLCanvasElement {
  const long = Math.max(src.width, src.height);
  if (long > 0 && long <= maxEdge && "getContext" in src) return src;
  const scale = long > 0 ? maxEdge / long : 1;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  out.getContext("2d")?.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/**
 * The part of a photo record this module reads: the bytes to re-decode from,
 * the photograph's own dimensions, and the pixels retained for a photo whose
 * bytes are gone.
 */
export interface FullResRecord {
  file?: File | null;
  /**
   * The photograph's own pixel dimensions, measured once at decode and in the
   * same orientation the frame is drawn in.
   *
   * Every crop box and context box on the record is in these pixels, and the
   * geometry divides by them to place a box on a panel. They cannot be read off
   * the display canvas: that has different dimensions from the photograph, the
   * fractions come out different, and nothing reports an error - the outline
   * simply lands in the wrong place and a drag drawn there cuts the wrong
   * pixels.
   */
  fullW?: number | null;
  fullH?: number | null;
  /**
   * Full-resolution pixels held for a photo that cannot be re-decoded.
   *
   * Set only where `file` is null, which in this app means never: every intake
   * mints a File, including the zip entries, the clipboard paste and the sample
   * fetch. It exists for a photo installed from outside the intake - and then
   * holding the frame is the right answer rather than a fallback, because there
   * is nothing else to decode it from.
   */
  sourceCanvas?: HTMLCanvasElement | null;
}

/**
 * The one retained frame, and the decodes in flight.
 *
 * A single slot rather than a per-photo map: the bound that matters is bytes
 * resident, and one frame is one frame however many photographs ask for it. A
 * photo that asks while another is held still gets its own frame, it simply is
 * not the one left over afterwards.
 */
let retained: { photo: object; canvas: HTMLCanvasElement } | null = null;
const inflight = new Map<object, Promise<HTMLCanvasElement | null>>();

/** How many frames are being held. One, or none - the point of the bound. */
export function retainedFullCanvasCount(): number {
  return retained ? 1 : 0;
}

/** The frame currently held, if any. For tests and for leak assertions. */
export function retainedFullCanvasFor(p: object): HTMLCanvasElement | null {
  return retained?.photo === p ? retained.canvas : null;
}

/**
 * Forget every held frame and every decode in flight.
 *
 * For tests, and for the between-galleries case: a gallery that has been
 * emptied should not leave the last photo's frame behind.
 */
export function resetFullCanvasCache(): void {
  retained = null;
  inflight.clear();
}

async function decodeFullFrame(file: File): Promise<HTMLCanvasElement | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    // The same orientation the intake decoded with, so the frame's dimensions
    // are the `fullW`/`fullH` on the record and every box cut from it agrees
    // with the geometry that will place it.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const cv = document.createElement("canvas");
    cv.width = bitmap.width;
    cv.height = bitmap.height;
    cv.getContext("2d")?.drawImage(bitmap, 0, 0);
    return cv;
  } catch {
    // A File that will not decode is a real outcome - a truncated upload, a
    // format the browser cannot read - and the caller needs to hear about it as
    // a crop it cannot draw, not as an exception out of a render path.
    return null;
  } finally {
    // The decoded copy goes either way: the canvas holds the same pixels and a
    // 12 MP bitmap is the largest single thing this touches.
    bitmap?.close();
  }
}

/**
 * A photo's full-resolution pixels, decoded from its File if they are not
 * already to hand.
 *
 * Null means this photo has no full-resolution pixels and none can be got: no
 * File, and none retained. A caller that needs them has to say so on screen
 * rather than quietly working from the display canvas, because a crop cut from
 * a 2048 px copy of a 12 MP photograph is a different crop.
 *
 * The returned canvas belongs to the cache, not the caller. Draw from it; do
 * not keep it, because the next photo asked for will take the slot.
 */
export async function fullCanvasFor(p: FullResRecord & object): Promise<HTMLCanvasElement | null> {
  // A photo with no bytes keeps its pixels, so there is nothing to decode and
  // nothing to evict: what it holds is the whole of what it has.
  if (!p.file) return p.sourceCanvas ?? null;
  if (retained?.photo === p) return retained.canvas;
  const pending = inflight.get(p);
  if (pending) return pending;

  const promise = decodeFullFrame(p.file).then((canvas) => {
    inflight.delete(p);
    if (!canvas) return null;
    // Install only if nothing else claimed the slot while this was in flight.
    // Two photos decoded at once and the later one wins; the earlier caller
    // still gets its own frame, it is just not the one left resident.
    if (!retained || retained.photo === p) retained = { photo: p, canvas };
    return canvas;
  });
  inflight.set(p, promise);
  return promise;
}

/**
 * Drop a photo's frame, so a deleted photo's pixels go with it.
 *
 * Safe to call for a photo with nothing held, which is every photo until
 * something asks for its frame.
 */
export function releaseFullCanvas(p: object): void {
  if (retained?.photo === p) retained = null;
}