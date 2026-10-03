/**
 * Canvas encode memo, and the two DOM helpers that go with it.
 *
 * Nothing here reads app state: the cache is keyed on the canvas object itself,
 * so a re-render that hands back the same canvas gets the same URL for free and
 * a replaced canvas cannot serve a stale one.
 */

/** JPEG quality to encode a full photo's <img> at. Cheap to view, not archival. */
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
