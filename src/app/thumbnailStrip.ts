/**
 * The thumbnail strip: one tile per photo, and the bulk actions over it.
 *
 * The tiles are cached by index and reused across renders. Tearing the strip
 * down and rebuilding it put ~118 ms of synchronous JPEG encoding on the thread
 * that also paints, once per photo - that was the frozen UI. Reuse has to be
 * invisible, so a tile keeps its DOM node, its <img> and its checkbox and only
 * the parts that changed are written.
 *
 * What this needs from the rest of the app - the photos, which are included, and
 * the four actions that reach outside the strip - arrives as one object, so the
 * dependency runs from the strip outwards and never back.
 */

import { canvasUrl, setImgSrc } from "./canvasCache";
import { updatePooling } from "./poolingPanel";
import { escapeHtml } from "./speciesLabels";
import type { LogFn } from "./telemetry";
import type { ClassifiedPhoto } from "./types";

/**
 * What the strip needs from the app around it.
 *
 * Supplied by the caller as an object of accessors rather than as values: the
 * app REPLACES `previews` and `includedIndices` rather than mutating them (a
 * new batch prepends, and "delete all" makes a fresh Set), so a snapshot taken
 * when this object was built would go stale after the first photo lands.
 */
export interface StripApi {
  readonly previews: ClassifiedPhoto[];
  includedIndices: Set<number>;
  selectedIndex: number;
  selectPhoto: (idx: number) => void;
  deletePhoto: (idx: number) => void;
  /** Re-pool the checked photos. The strip is one of several things that changes it. */
  updatePooling: () => void;
  sendLog: LogFn;
}

/**
 * The cached DOM for one tile, so a re-render updates it rather than rebuilding.
 *
 * Keyed by the PHOTO, not by its index: a tile's index stops being its index as
 * soon as a photo before it is deleted, and keying on the photo is what lets the
 * right tile survive a deletion. Every per-render value that depends on the index
 * is therefore written on each render rather than captured when the tile is built.
 */
interface TileNode {
  tile: HTMLElement;
  delBtn: HTMLButtonElement;
  btn: HTMLButtonElement;
  img: HTMLImageElement;
  num: HTMLElement;
  badge: HTMLElement;
  label: HTMLLabelElement;
  chk: HTMLInputElement;
}

// A photo can only be pooled if its checkbox is enabled, so the bulk actions use
// the same rule rather than a second one that could drift from it.
export function isSelectable(p?: ClassifiedPhoto): boolean {
  if (!p || p.fallback || p.pending || p.error) return false;
  // A photo the gate called not-a-mosquito is finished and valid, but it has
  // nothing to contribute to a pooled mosquito result, so it is not selectable.
  return p.verdict?.state !== "non-mosquito";
}

// Tiles are keyed by the photo slot they were built for, so a re-render updates
// them in place instead of rebuilding the strip.
//
// This used to be `strip.innerHTML = ""` followed by building every tile again,
// on every call - and `renderThumbnails` runs after every single photo lands,
// and again for a selection change and a checkbox toggle. Tearing the strip down
// discards every decoded thumbnail, so the browser re-decoded all of them, and
// because the strip sits above the results, every rebuild moved everything below
// it. That is the layout shift on row expansion and on deleting a photo, and it
// is most of the main-thread cost during a batch.
//
// Reusing the nodes removes both: an unchanged tile is not touched at all, so
// nothing about it decodes, resizes or moves.
/** Tile cache, keyed by the photo the tile shows. */
const tileNodes = new Map<ClassifiedPhoto, TileNode>();

function buildTile(idx: number, api: StripApi): TileNode {
  const tile = document.createElement("div");

  const delBtn = document.createElement("button");
  delBtn.className = "tile-delete-btn";
  delBtn.innerHTML = "&times;";
  // Set per-render, because the index a tile was built for stops being its
  // index as soon as a photo before it is deleted.
  tile.appendChild(delBtn);

  const btn = document.createElement("button");
  btn.className = "tile-btn";
  btn.onclick = () => api.selectPhoto(idx);
  tile.appendChild(btn);

  const img = document.createElement("img");
  btn.appendChild(img);

  const num = document.createElement("span");
  num.className = "number";
  btn.appendChild(num);

  const badge = document.createElement("span");
  btn.appendChild(badge);

  const label = document.createElement("label");
  label.className = "include";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.className = "thumb-optin";
  chk.onchange = (e) => {
    const box = e.target as HTMLInputElement;
    if (box.checked) api.includedIndices.add(idx);
    else api.includedIndices.delete(idx);
    renderThumbnails(api);
    api.updatePooling();
  };
  label.appendChild(chk);
  tile.appendChild(label);

  return { tile, delBtn, btn, img, num, badge, label, chk };
}

export function renderThumbnails(api: StripApi): void {
  const strip = document.getElementById("thumbnail-strip");
  if (!strip) throw new Error("#thumbnail-strip is missing from the page");
  updateStripActions(api);
  const counter = document.getElementById("gallery-counter");
  if (counter) counter.textContent = `${api.selectedIndex + 1} / ${api.previews.length}`;

  // Drop the entries for photos that are gone, so a tile whose photo was deleted
  // is not kept alive by the cache.
  const live = new Set(api.previews);
  for (const [key, node] of tileNodes) {
    if (!live.has(key)) {
      node.tile.remove();
      tileNodes.delete(key);
    }
  }

  api.previews.forEach((p, idx) => {
    let node = tileNodes.get(p);
    if (!node) {
      node = buildTile(idx, api);
      tileNodes.set(p, node);
    }

    // A photo still being analyzed is visibly unsettled: greyed tile, pending
    // badge, and it cannot be opted into the pooled result yet.
    node.tile.className = "tile" + (api.selectedIndex === idx ? " active" : "") +
      (!api.includedIndices.has(idx) ? " excluded" : "") + (p.pending ? " pending" : "");

    node.delBtn.title = `Remove ${p.name}`;
    node.delBtn.onclick = (e) => {
      e.stopPropagation();
      api.deletePhoto(idx);
    };

    node.btn.setAttribute("aria-label", `View photo ${idx + 1}: ${p.name}`);

    // A queued photo has no canvas yet: it gets a greyed placeholder tile that
    // resolves to the real image as soon as its own decode finishes. The alt is
    // empty in that state, so the filename does not render over the tile.
    const src = p.cropCanvas || p.fullCanvas;
    if (src) {
      setImgSrc(node.img, canvasUrl(src, 0.8));
      node.img.className = "";
      node.img.alt = p.name ?? "";
    } else {
      node.img.removeAttribute("src");
      node.img.className = "thumb-placeholder";
      node.img.alt = "";
    }

    node.num.textContent = `${idx + 1}`;

    const badgeState = p.error ? "error" : p.pending ? "pending" : p.is_cropped ? "cropped" : "uncropped";
    node.badge.className = `crop-badge ${badgeState}`;
    node.badge.textContent = p.error ? "!" : p.pending ? "…" : p.is_cropped ? "✓" : "✕";
    node.badge.title = p.error
      ? p.error
      : p.pending
        ? ""
        : p.is_cropped ? "Mosquito detected & cropped" : "Uncropped / no mosquito detected";

    // The one place a photo's own verdict is visible without selecting it, so an
    // excluded photo is never only knowable from the contribution table.
    const abstained = p.verdict?.state === "unsure";
    node.label.title = abstained
      ? "Not confident enough to name a genus - excluded from the pooled result"
      : !p.fallback ? "Include this photo in pooled result" : "No usable mosquito detection";

    node.chk.checked = api.includedIndices.has(idx);
    node.chk.disabled = !isSelectable(p);

    // One appendChild on an already-present child moves it to the end, which is
    // how the strip is put into index order after a deletion.
    strip.appendChild(node.tile);
  });
}

export function setAllSelected(on: boolean, api: StripApi): void {
  api.previews.forEach((p, i) => {
    if (isSelectable(p) && on) api.includedIndices.add(i);
    else api.includedIndices.delete(i);
  });
  renderThumbnails(api);
  api.updatePooling();
  updateStripActions(api);
}

export function deleteAllPhotos(api: StripApi): void {
  if (!api.previews.length) return;
  const n = api.previews.length;
  // No confirmation, matching deletePhoto: one press removes one photo without
  // asking, so asking only for the batch made the strip inconsistent rather than
  // cautious.
  // Mark first, exactly as deletePhoto does, so every in-flight inference for any
  // photo drops its result rather than writing into a slot that no longer exists.
  api.previews.forEach((p) => { p.removed = true; });
  api.previews.length = 0;
  api.includedIndices = new Set();
  api.selectedIndex = 0;
  api.sendLog("delete_all_photos", { count: n });
  renderThumbnails(api);
  const gallery = document.getElementById("gallery-section");
  if (gallery) gallery.style.display = "none";
  const table = document.getElementById("results-table-section");
  if (table) table.style.display = "none";
  // The combined card is not hidden: hiding it shifts the layout under the
  // strip. api.updatePooling() decides what it shows.
  api.updatePooling();
}

// Nothing to select, deselect or delete without photos, so the buttons say so
// rather than sitting there as no-ops.
export function updateStripActions(api: StripApi): void {
  const empty = api.previews.length === 0;
  for (const id of ["btn-select-all", "btn-select-none", "btn-delete-all"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = empty;
  }
}

export function wireStripActions(api: StripApi): void {
  const on = (id: string, fn: () => void): void => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  on("btn-select-all", () => setAllSelected(true));
  on("btn-select-none", () => setAllSelected(false));
  on("btn-delete-all", deleteAllPhotos);
  updateStripActions();
}
