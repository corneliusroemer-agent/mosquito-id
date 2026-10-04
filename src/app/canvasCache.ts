/**
 * Canvas encode memo, and the two DOM helpers that go with it.
 *
 * Nothing here reads app state: the cache is keyed on the canvas object itself,
 * so a re-render that hands back the same canvas gets the same URL for free and
 * a replaced canvas cannot serve a stale one.
 */

// A canvas -> data: URL memo, keyed on the canvas object.
//
// Every render re-encodes the same canvases: `renderThumbnails` runs after each
// photo lands and encodes every tile's crop, and `renderActivePhoto` encodes the
// selected photo's full and context canvases. `toDataURL` is a synchronous
// JPEG encode of a full-resolution frame - tens of milliseconds each - on the
// thread that also has to paint. With ten photos that is over a second of
// blocking work per render, spread across the batch, which is what a frozen UI
// during classification actually is.
//
// The cache is keyed on the canvas identity rather than the photo, because a
// photo's canvas is *replaced* whenever its pixels change (a new decode, a crop
// release, a manual re-crop). A fresh canvas is a fresh cache entry, so a stale
// encode cannot outlive the pixels it was made from - the invalidation is
// structural rather than something a call site has to remember to do. Entries
// die with their canvas.
const canvasUrlCache = new WeakMap();
export function canvasUrl(cv: HTMLCanvasElement | null, quality: number): string | null {
  if (!cv) return null;
  const key = quality;
  let byQuality = canvasUrlCache.get(cv);
  if (!byQuality) {
    byQuality = new Map();
    canvasUrlCache.set(cv, byQuality);
  }
  let url = byQuality.get(key);
  if (url === undefined) {
    url = cv.toDataURL("image/jpeg", quality);
    byQuality.set(key, url);
  }
  return url;
}

/**
 * The width of a tile's image box, in CSS px, at the widest breakpoint the
 * stylesheet sets (`index.html`: 84px under the phone breakpoint, 64px above).
 */
const TILE_CSS_PX = 84;

/**
 * Device pixels to encode a thumbnail at: `TILE_CSS_PX` at 3x, the densest
 * display the strip is used on. Anything above this is pixels no display shows.
 */
const THUMB_PX = TILE_CSS_PX * 3;

/**
 * Long edge of the intermediate a large source is shrunk through before it
 * reaches thumbnail size. A single 12 MP -> 252 px `drawImage` is a ~50x
 * reduction, and a one-step box filter that wide aliases on fine detail; two
 * steps of at most this much each are what the browser's own downscale does
 * internally. Costs one extra ~1 MP resample, which is invisible next to the
 * 12-50 MP read it replaces.
 */
const INTERMEDIATE_PX = 1024;

/**
 * The size to shrink a `w` x `h` source to for a thumbnail, at its own aspect
 * ratio.
 *
 * Sizing on the *short* edge is what makes the tile's `object-fit: cover` crop
 * identical to the un-downscaled one: cover scales by `max(boxW/w, boxH/h)`, so
 * for the square tile the short edge is the one that always fills it, and a
 * thumbnail is large enough to render exactly when its short edge is.
 *
 * A source already at or below `THUMB_PX` on its short edge is returned
 * unchanged, so a small canvas is never enlarged (and never loses sharpness to a
 * resample it did not need).
 */
export function thumbnailSize(w: number, h: number, shortEdge = THUMB_PX): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w, h };
  const short = Math.min(w, h);
  if (short <= shortEdge) return { w, h };
  const scale = shortEdge / short;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** The two resample steps a full-resolution source takes to reach thumbnail size. */
export function thumbnailSteps(w: number, h: number, shortEdge = THUMB_PX, intermediatePx = INTERMEDIATE_PX): { w: number; h: number }[] {
  const steps: { w: number; h: number }[] = [];
  let cur = { w, h };
  const long = Math.max(w, h);
  if (long > intermediatePx) {
    const scale = intermediatePx / long;
    const next = { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
    // An intermediate that leaves less than `shortEdge` on the short side is not
    // an intermediate, it is the whole downscale done badly: the second step
    // would have nothing left to work from and the tile would be encoded at
    // whatever width the panorama happened to leave. Skip it and resample once.
    if (Math.min(next.w, next.h) >= shortEdge) {
      cur = next;
      steps.push(next);
    }
  }
  const fin = thumbnailSize(cur.w, cur.h, shortEdge);
  if (fin.w !== cur.w || fin.h !== cur.h) steps.push(fin);
  return steps;
}

/**
 * Scratch canvases, one per resample step, reused across every thumbnail.
 *
 * These have to be *one canvas per step*, not one canvas reused for the whole
 * chain: assigning `width`/`height` clears the canvas, so a single canvas would
 * erase step n's output at the start of step n+1 and then draw that empty
 * canvas onto itself. The result is a correctly sized, entirely black tile.
 *
 * Allocated on first use and then grown, never reallocated, because the callers
 * run on the main thread inside a render.
 */
const scratches: HTMLCanvasElement[] = [];
function stepCanvas(i: number, w: number, h: number): CanvasRenderingContext2D | null {
  let cv = scratches[i];
  if (!cv) { cv = document.createElement("canvas"); scratches[i] = cv; }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv.getContext("2d");
}

// Thumbnails get their own memo, in their own key space, so an encode made for
// the 64 px strip can never be served to the full-size viewer - which is the
// failure the shared cache would otherwise make possible now that two sizes of
// encode exist for the same canvas.
const thumbUrlCache = new WeakMap<HTMLCanvasElement, Map<number, string>>();

/**
 * A JPEG data: URL of `cv` at thumbnail size, for a tile.
 *
 * `canvasUrl` encodes at whatever size the canvas happens to be, which for a
 * photo is 12-50 megapixels, and the tile then displays it at 84 CSS px. The
 * browser downsamples the decoded frame at composite time, so the full
 * resolution is only ever paying for the encode: on the 30-photo corpus that
 * was 16.8 s of synchronous JPEG encoding, twice per photo (once before its
 * crop exists, once after), of which the strip shows 84 pixels.
 *
 * Downscaling first makes the encode cost proportional to what is displayed.
 * The JPEG quality argument is the caller's and unchanged, so the only visible
 * difference is the source resolution of the tile's own downsample - measured
 * against the un-downscaled render in `docs/THUMBNAIL-ENCODE.md`.
 */
export function thumbnailUrl(cv: HTMLCanvasElement | null, quality: number): string | null {
  if (!cv) return null;
  let byQuality = thumbUrlCache.get(cv);
  if (!byQuality) { byQuality = new Map(); thumbUrlCache.set(cv, byQuality); }
  const hit = byQuality.get(quality);
  if (hit !== undefined) return hit;

  const steps = thumbnailSteps(cv.width, cv.height);
  if (steps.length === 0) {
    // Already thumbnail-sized (or smaller): encoding it directly is the same
    // pixels the downscale would produce, without the resample.
    const url = cv.toDataURL("image/jpeg", quality);
    byQuality.set(quality, url);
    return url;
  }
  let src: HTMLCanvasElement = cv;
  let out: HTMLCanvasElement | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s) break;
    const ctx = stepCanvas(i, s.w, s.h);
    const dest = scratches[i];
    // No 2d context means no downscale is available; leave `out` null so the
    // source is encoded as-is, which is what this did before.
    if (!ctx || !dest) break;
    ctx.drawImage(src, 0, 0, s.w, s.h);
    src = dest;
    out = dest;
  }
  if (!out) {
    const url = cv.toDataURL("image/jpeg", quality);
    byQuality.set(quality, url);
    return url;
  }
  const url = out.toDataURL("image/jpeg", quality);
  byQuality.set(quality, url);
  return url;
}

// Setting an <img>'s src to the value it already holds is cheap to write and
// not free to run: the element drops the decoded frame and re-decodes. The
// caches above make the encode free, but only skipping the assignment makes the
// *decode* free, so the same-string check is what actually keeps a re-render
// from costing anything.
export function setImgSrc(img: HTMLImageElement, url: string | null): void {
  if (url && img.getAttribute("src") === url) return;
  if (url) img.setAttribute("src", url);
  else img.removeAttribute("src");
}

export function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth || img.width;
      cv.height = img.naturalHeight || img.height;
      // A fresh canvas always has a 2d context; if it somehow does not, failing
      // here beats resolving a blank canvas that looks like a decoded photo.
      const ctx = cv.getContext("2d");
      if (!ctx) { reject(new Error("Could not get a 2d context for the decoded image")); return; }
      ctx.drawImage(img, 0, 0);
      resolve(cv);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
