/**
 * Where the crop outline goes, and how a context region is cut.
 *
 * Every function here is a mapping between a photo's pixels and the panel it is
 * painted in, or the box that describes a region of it. They read the DOM by id
 * and a photo object, and nothing else - no session, no classifier state - so
 * the geometry of both crop panels can be read in one place.
 *
 * The two panels deliberately disagree: the full panel fits with contain (the
 * whole photo, letterboxed) and the zoom panel with cover, so each needs its own
 * map and neither can be reused for the other.
 */

import type { Box, BoxPercent, CanvasLike, ContextCrop, Mapping, Preview } from "./types";

// Whether there is a crop to draw, and where it sits in each panel, answered in
// one place. Both panels used to gate the outline on their own independent
// conditions, so a state could satisfy one and not the other and show the crop
// on only one panel - the reported "zoom has a crop, the full photo does not".
// Two guards that must agree is the defect; a third caller would reintroduce it.
//
// A crop is real when the photo was classified on a sub-region of itself. A
// photo the user reverted to whole was classified on the whole frame, so
// drawing an outline over it would claim a crop that was never made - and a
// rejected crop carries no box either, which is why this needs no gate of its
// own for that case.
// `pending` is deliberately not a gate: a recompute in flight still has the
// previous crop on screen, and both panels should keep showing it, dimmed on
// the scores, rather than one panel blanking while the other holds.
export function hasCropBox(p?: Preview): boolean {
  return Boolean(p && p.cropBox && !p.manual_full_photo);
}

// The same p.cropBox expressed as fractions of each panel's surface. Both take
// p.cropBox in full-image pixels; each panel shows a different image through a
// different object-fit, so each needs its own map. The full panel fits with
// contain (the whole photo, letterboxed) and the zoom panel with cover (a
// deliberate crop), so the two panels disagree by construction and each has to
// ask for its own. Returns null when the panel cannot place the box (no image,
// or no context region).
export function cropBoxInFullSurface(p: Preview): BoxPercent | null {
  if (!hasCropBox(p) || !p.fullCanvas) return null;
  const surfaceFull = document.getElementById("crop-surface-full");
  const { kx, ox, ky, oy } = fitMapping(surfaceFull, p.fullCanvas, "contain");
  const [bx1, by1, bx2, by2] = p.cropBox!;
  const l = (bx1 / p.fullCanvas.width - ox) / kx;
  const t = (by1 / p.fullCanvas.height - oy) / ky;
  return {
    left: l * 100,
    top: t * 100,
    width: ((bx2 / p.fullCanvas.width - ox) / kx - l) * 100,
    height: ((by2 / p.fullCanvas.height - oy) / ky - t) * 100,
  };
}

// The zoom panel shows the context region, not the whole photo, so the box has
// to be expressed relative to that region before it goes through the cover map.
// With no context region the panel shows the whole photo instead (zoomSource
// falls back the same way), so the whole photo is the coordinate frame here too
// - which keeps a real crop drawable on both panels in every state.
export function cropBoxInZoomSurface(p: Preview): BoxPercent | null {
  if (!hasCropBox(p)) return null;
  const surfaceZoomed = document.getElementById("crop-surface-zoomed");
  const [cx1, cy1, cx2, cy2] = p.cropBox!;
  const ctx_x1 = p.contextBox ? p.contextBox[0] : 0;
  const ctx_y1 = p.contextBox ? p.contextBox[1] : 0;
  const ctx_x2 = p.contextBox ? p.contextBox[2] : p.fullCanvas!.width;
  const ctx_y2 = p.contextBox ? p.contextBox[3] : p.fullCanvas!.height;
  const ctx_w = ctx_x2 - ctx_x1;
  const ctx_h = ctx_y2 - ctx_y1;
  if (!(ctx_w > 0) || !(ctx_h > 0)) return null;
  const { kx, ox, ky, oy } = fitMapping(surfaceZoomed, p.contextCanvas || p.fullCanvas, "cover");
  const l = ((cx1 - ctx_x1) / ctx_w - ox) / kx;
  const t = ((cy1 - ctx_y1) / ctx_h - oy) / ky;
  return {
    left: l * 100,
    top: t * 100,
    width: (((cx2 - ctx_x1) / ctx_w - ox) / kx - l) * 100,
    height: (((cy2 - ctx_y1) / ctx_h - oy) / ky - t) * 100,
  };
}

// Place a box returned by one of the helpers above, or hide it.
export function applyBox(el: HTMLElement | null, box: BoxPercent | null): void {
  if (!el) return;
  if (!box) {
    el.style.display = "none";
    return;
  }
  el.style.left = `${box.left}%`;
  el.style.top = `${box.top}%`;
  el.style.width = `${box.width}%`;
  el.style.height = `${box.height}%`;
  el.style.display = "block";
}

// The affine map between a surface and the photo painted in it, as
// imageFraction = k * surfaceFraction + o, per axis. The crop-box overlay
// (image -> surface) and the drag handlers (surface -> image) both run through
// this, so the two directions cannot drift apart.
//
// `fit` is the CSS object-fit in force on that panel and decides which side of
// 1 k falls on. Both fits scale the photo by the same factor; they differ in
// what happens to the leftover room:
//
//   cover   - the photo always fills the surface, so k < 1 on one axis is the
//             part of the image that survives the window, centred.
//   contain - the whole photo is shown, so k < 1 on the other axis is the
//             margin the surface adds around it, also centred.
//
// k is per-axis because each fit pads or crops on exactly one axis and leaves
// the other at 1. A single scalar for both axes stretched whichever axis was
// not cropped, so a crop outline drawn on the photo came out a different shape
// from the same crop drawn in the other panel - the reported "one panel's shape
// is more square, the other's more rectangular".
//
// For any image and any surface this is the identity when the two aspects
// match, which is the normal case the two panels agree in.
export function fitMapping(surface: HTMLElement | null, img: CanvasLike | null | undefined, fit: "cover" | "contain"): Mapping {
  const identity: Mapping = { kx: 1, ox: 0, ky: 1, oy: 0 };
  if (!surface || !img) return identity;
  const b = surface.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return identity;
  const boxAspect = b.width / b.height;
  const imgAspect = img.width / img.height;
  if (!imgAspect) return identity;
  // cover keeps the axis where the image overflows; contain keeps the axis
  // where the surface overflows. Same k, opposite choice of axis.
  const pick = fit === "contain" ? Math.max : Math.min;
  const kx = pick(1, boxAspect / imgAspect);
  const ky = pick(1, imgAspect / boxAspect);
  return { kx, ox: (1 - kx) / 2, ky, oy: (1 - ky) / 2 };
}

/**
 * The affine map for the zoom panel, given the photo being shown.
 *
 * The photo is a parameter rather than read from app state so that this module
 * depends on nothing: the caller already has the photo, and passing it makes the
 * panel's subject explicit at the call site instead of implied.
 */
export function zoomedSurfaceMapping(p?: Preview): Mapping {
  return fitMapping(document.getElementById("crop-surface-zoomed"), p?.contextCanvas, "cover");
}

export function fullSurfaceMapping(p?: Preview): Mapping {
  return fitMapping(document.getElementById("crop-surface-full"), p?.fullCanvas, "contain");
}

// Aspect ratio (w/h) of the zoomed panel's container, i.e. the box the context
// canvas is displayed in. The container lives inside #gallery-section, which is
// display:none until the first photo has been classified, so on the very first
// photo its clientWidth/clientHeight both read 0 and any aspect measured from it
// is the 1/0 fallback. Measure against real layout instead: give the gallery
// layout for one synchronous read, then restore it. Both style writes land in
// the same frame, so the hidden gallery is never painted.
let cachedViewerAspect: number | null = null;

// The cache is only read while #gallery-section is display:none, i.e. before the
// first photo is classified. A rotate or a window resize changes the panel's
// shape, and a context region cut for the old shape is wider or taller than the
// panel it is shown in, so drop it and let the next photo measure afresh.
/**
 * Drop the cached viewer aspect.
 *
 * Called from the resize and orientationchange listeners the entry point wires,
 * rather than registering them here: a module that attaches window listeners at
 * import time makes importing it an act with a side effect, and these belong to
 * the page's lifetime, not to this module's.
 *
 * The cache is only read while #gallery-section is display:none, i.e. before the
 * first photo is classified. A rotate or a window resize changes the panel's
 * shape, and a context region cut for the old shape is wider or taller than the
 * panel it is shown in, so drop it and let the next photo measure afresh.
 */
export function invalidateViewerAspectCache(): void {
  cachedViewerAspect = null;
}

export function measureViewerAspect(): number | null {
  const container = document.getElementById("crop-surface-zoomed")?.parentElement;
  if (container && container.clientWidth > 0 && container.clientHeight > 0) {
    return container.clientWidth / container.clientHeight;
  }
  if (cachedViewerAspect) return cachedViewerAspect;

  const gallery = document.getElementById("gallery-section");
  if (gallery && container) {
    const prevDisplay = gallery.style.display;
    const prevVisibility = gallery.style.visibility;
    gallery.style.display = "block";
    gallery.style.visibility = "hidden";
    const w = container.clientWidth;
    const h = container.clientHeight;
    gallery.style.display = prevDisplay;
    gallery.style.visibility = prevVisibility;
    if (w > 0 && h > 0) {
      cachedViewerAspect = w / h;
      return cachedViewerAspect;
    }
  }
  return null;
}

// Compute context crop matching viewer container aspect ratio with 75% border fit along narrower dimension
export function extractContextCrop(fullCv: HTMLCanvasElement, cropBox: Box | null, targetAspect: number | null = null): ContextCrop {
  if (!cropBox) {
    return { contextCanvas: fullCv, contextBox: [0, 0, fullCv.width, fullCv.height] };
  }
  const [bx1, by1, bx2, by2] = cropBox;
  const cw = Math.max(1, bx2 - bx1);
  const ch = Math.max(1, by2 - by1);
  const cx = (bx1 + bx2) / 2;
  const cy = (by1 + by2) / 2;

  // Determine viewer container aspect ratio (width / height)
  if (!targetAspect) {
    targetAspect = measureViewerAspect() ?? 400 / 320;
  }

  // 75% to border along narrower dimension relative to container
  let ctx_w, ctx_h;
  if ((cw / targetAspect) >= ch) {
    ctx_w = cw / 0.75;
    ctx_h = ctx_w / targetAspect;
  } else {
    ctx_h = ch / 0.75;
    ctx_w = ctx_h * targetAspect;
  }

  if (ctx_w > fullCv.width) {
    ctx_w = fullCv.width;
    ctx_h = ctx_w / targetAspect;
  }
  if (ctx_h > fullCv.height) {
    ctx_h = fullCv.height;
    ctx_w = ctx_h * targetAspect;
  }

  let x1 = cx - ctx_w / 2;
  let y1 = cy - ctx_h / 2;
  let x2 = cx + ctx_w / 2;
  let y2 = cy + ctx_h / 2;

  if (x1 < 0) {
    x2 -= x1;
    x1 = 0;
  }
  if (y1 < 0) {
    y2 -= y1;
    y1 = 0;
  }
  if (x2 > fullCv.width) {
    x1 -= (x2 - fullCv.width);
    x2 = fullCv.width;
  }
  if (y2 > fullCv.height) {
    y1 -= (y2 - fullCv.height);
    y2 = fullCv.height;
  }

  x1 = Math.max(0, Math.round(x1));
  y1 = Math.max(0, Math.round(y1));
  x2 = Math.min(fullCv.width, Math.round(x2));
  y2 = Math.min(fullCv.height, Math.round(y2));

  const finalW = Math.max(1, x2 - x1);
  const finalH = Math.max(1, y2 - y1);

  const ctxCv = document.createElement("canvas");
  ctxCv.width = finalW;
  ctxCv.height = finalH;
  const ctx2d = ctxCv.getContext("2d");
  if (!ctx2d) throw new Error("Could not get a 2d context for the context crop");
  ctx2d.drawImage(fullCv, x1, y1, finalW, finalH, 0, 0, finalW, finalH);

  return { contextCanvas: ctxCv, contextBox: [x1, y1, x2, y2] };
}
