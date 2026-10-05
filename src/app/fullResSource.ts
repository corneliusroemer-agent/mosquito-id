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
 * decoded. And the retention bound is a fixed number of frames, not one per
 * photo: a hundred crop draws across a hundred photographs still hold
 * `FULL_RES_CACHE_FRAMES`, because the point was never to make the second
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
 * How many full-resolution frames are retained at once.
 *
 * The bound that matters is bytes resident, so this is a count of frames and
 * nothing else - the photographs behind them do not matter. One was enough to
 * stop the linear-in-gallery growth it replaced, but a single slot is only ever
 * installed for the photo already in it, so the first photo to ask owned the
 * cache for the rest of the session and every other photograph re-decoded on
 * every call. Two is what makes alternating between two photographs free, which
 * is what comparing two crops looks like.
 */
export const FULL_RES_CACHE_FRAMES = 2;

/**
 * The retained frames, least recently used first, and the decodes in flight.
 *
 * A `Map`, because insertion order is the recency order and a hit re-inserts:
 * `Map.delete` then `Map.set` moves a key to the end, so the first key is always
 * the least recently used. That matters because the alternatives do not hold the
 * bound. A `WeakMap` has no bound at all - a frame lives as long as its photo,
 * which is the whole gallery, and is the original eleven-gigabyte problem. A
 * `WeakRef` bounds only whatever the collector happens to reclaim, so the bound
 * is never guaranteed. Last-writer-wins with one slot is what this replaced.
 */
const retained = new Map<object, HTMLCanvasElement>();
const inflight = new Map<object, Promise<HTMLCanvasElement | null>>();

/** How many frames are being held. Never more than `FULL_RES_CACHE_FRAMES`. */
export function retainedFullCanvasCount(): number {
  return retained.size;
}

/** The frame held for this photo, if any. For tests and for leak assertions. */
export function retainedFullCanvasFor(p: object): HTMLCanvasElement | null {
  return retained.get(p) ?? null;
}

/**
 * Mark `p` as the most recently used frame and evict past the bound.
 *
 * Every insertion and every eviction goes through here, so releasing one photo
 * and emptying the cache cannot disagree about what the bound is.
 */
function admit(p: object, canvas: HTMLCanvasElement): void {
  retained.delete(p);
  retained.set(p, canvas);
  while (retained.size > FULL_RES_CACHE_FRAMES) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) break;
    retained.delete(oldest);
  }
}

/**
 * Forget every held frame and every decode in flight.
 *
 * For tests, and for the between-galleries case: a gallery that has been
 * emptied should not leave the last photographs' frames behind.
 */
export function resetFullCanvasCache(): void {
  retained.clear();
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
 * not keep it, because the next photographs asked for will take the slots.
 */
export async function fullCanvasFor(p: FullResRecord & object): Promise<HTMLCanvasElement | null> {
  // A photo with no bytes keeps its pixels, so there is nothing to decode and
  // nothing to evict: what it holds is the whole of what it has.
  if (!p.file) return p.sourceCanvas ?? null;
  const held = retained.get(p);
  if (held) {
    // Re-insert, so a hit counts as the use it is and the eviction below drops
    // a photograph that has not been asked for rather than this one.
    admit(p, held);
    return held;
  }
  const pending = inflight.get(p);
  if (pending) return pending;

  const promise = decodeFullFrame(p.file).then((canvas) => {
    inflight.delete(p);
    if (!canvas) return null;
    // Whoever lands last is the most recently used, which is the whole
    // admission rule: two photos decoded at once both stay resident if there is
    // room, and the earlier caller still gets its own frame either way.
    admit(p, canvas);
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
  retained.delete(p);
}