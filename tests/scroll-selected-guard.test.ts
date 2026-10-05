import { describe, expect, it } from "vitest";
import { SelectedScrollGuard } from "../src/app/thumbnailStrip";
import type { ClassifiedPhoto } from "../src/app/types";

/**
 * When the strip may skip its scroll.
 *
 * Reading the selected tile's rect is a synchronous layout of the whole
 * document, and `scrollSelectedIntoView` runs at the end of every
 * `renderThumbnails` - which is once per photo as a batch lands. So the rule
 * that decides whether to ask is the difference between one forced layout per
 * batch and one per photo, and it is the one place where being wrong is a
 * selection the user cannot see.
 *
 * Keyed on the photo record rather than on the index, which is the whole
 * subtlety: an index-keyed guard says "same slot" where a prepend means "a
 * different photo, in the same slot". Every case below is one where an
 * index-keyed guard would get it wrong, or one where it would have been right
 * for the wrong reason.
 */

function photo(name: string): ClassifiedPhoto {
  return {
    name,
    fullCanvas: null,
    cropCanvas: null,
    cropBox: null,
    contextBox: null,
    scores: {},
    detail: {},
    verdict: null,
    is_cropped: false,
    pending: false,
    error: null,
    crop_rejected: false,
  } as unknown as ClassifiedPhoto;
}

describe("SelectedScrollGuard", () => {
  it("needs a scroll for a photo it has never scrolled to", () => {
    const g = new SelectedScrollGuard();
    expect(g.needsScroll(photo("a.jpg"))).toBe(true);
  });

  it("does not need one twice for the same photo", () => {
    const g = new SelectedScrollGuard();
    const a = photo("a.jpg");
    g.record(a);
    expect(g.needsScroll(a)).toBe(false);
    // Twice more, which is what a batch's worth of renders with a still
    // selection amounts to.
    expect(g.needsScroll(a)).toBe(false);
    expect(g.needsScroll(a)).toBe(false);
  });

  it("needs one when the selection moves, even to an adjacent index", () => {
    const g = new SelectedScrollGuard();
    const a = photo("a.jpg");
    const b = photo("b.jpg");
    g.record(a);
    expect(g.needsScroll(b)).toBe(true);
    g.record(b);
    // And moving back is a move too.
    expect(g.needsScroll(a)).toBe(true);
  });

  it("needs one after a prepend, though the index has not moved", () => {
    const g = new SelectedScrollGuard();
    const old = photo("old.jpg");
    g.record(old);
    // Prepending a batch puts a new photo in slot 0 and leaves the selection at
    // 0. Same index, different tile, and the strip's content changed under it -
    // so an index-keyed guard would skip the scroll the new first tile needs.
    const fresh = photo("new.jpg");
    expect(g.needsScroll(fresh)).toBe(true);
  });

  it("needs one when the selection lands on a different photo, and not when it does not", () => {
    const g = new SelectedScrollGuard();
    const selected = photo("c.jpg");
    g.record(selected);
    // The same photo is still selected - a deletion ABOVE it moved it up one
    // index, so its position changed without the selection changing. The tile is
    // still the one the user was looking at, so this is correctly not a scroll.
    expect(g.needsScroll(selected)).toBe(false);
    // A different photo under the selection index means the selected tile really
    // did change, whatever happened to the list around it.
    expect(g.needsScroll(photo("d.jpg"))).toBe(true);
  });

  it("needs one again after the strip's box changed under a still selection", () => {
    const g = new SelectedScrollGuard();
    const a = photo("a.jpg");
    g.record(a);
    expect(g.needsScroll(a)).toBe(false);
    // What a window resize does: the selection did not move, but the tile that
    // was inside the strip need not be inside it now.
    g.invalidate();
    expect(g.needsScroll(a)).toBe(true);
  });

  it("never needs one when nothing is selected", () => {
    const g = new SelectedScrollGuard();
    expect(g.needsScroll(undefined)).toBe(false);
    expect(g.needsScroll(null)).toBe(false);
  });

  it("records nothing for a caller that could not scroll", () => {
    // The guard only learns about a scroll that happened. A render with no tile
    // for the photo yet - a queued batch, before its tile exists - has to be
    // still owed the scroll when the tile does appear, so the caller must not
    // record on the way out.
    const g = new SelectedScrollGuard();
    const queued = photo("queued.jpg");
    expect(g.needsScroll(queued)).toBe(true);
    // The caller returned before it could scroll, so it recorded nothing.
    expect(g.needsScroll(queued)).toBe(true);
    g.record(queued);
    expect(g.needsScroll(queued)).toBe(false);
  });
});