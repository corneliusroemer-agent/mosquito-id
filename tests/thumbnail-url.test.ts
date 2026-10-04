import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { thumbnailUrl } from "../src/app/canvasCache";

/**
 * `thumbnailUrl` itself, over a fake canvas that reproduces the one behaviour of
 * a real one that the geometry tests cannot see: **assigning `width`/`height`
 * clears it.**
 *
 * The first version of this downscale reused a single scratch canvas across both
 * resample steps. Step two's `width =` assignment erased step one's output, and
 * then drew that empty canvas onto itself. Every two-step thumbnail came out a
 * correctly sized, entirely black tile - 20x faster, no console error, and all
 * fourteen geometry tests passing. The bug was found by decoding the tiles the
 * app produced and looking at them.
 *
 * So these tests assert on the *pixels out*, not on the sizes asked for.
 */

const ALPHA = 255;

interface Fake {
  width: number;
  height: number;
  /** Non-zero when this canvas holds a drawn image; 0 when blank. */
  ink: number;
  getContext(t: string): FakeCtx | null;
  toDataURL(type?: string, quality?: number): string;
}

interface FakeCtx {
  drawImage(src: Fake, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * A canvas whose contents survive a draw and are destroyed by a resize, as a
 * real one is.
 *
 * The clear is the whole point, and it has to hang off the `width`/`height`
 * *setters* rather than be simulated in the draw: `stepCanvas` resizes the
 * scratch and only then draws, so a fake that does not clear on assignment
 * cannot see the bug it is written to catch. Assigning the same value still
 * clears, exactly as it does in a browser.
 */
function makeCanvas(w = 0, h = 0): Fake {
  let width = w;
  let height = h;
  let ink = 0;
  const c = {
    get width() { return width; },
    set width(v: number) { width = v; ink = 0; },
    get height() { return height; },
    set height(v: number) { height = v; ink = 0; },
    get ink() { return ink; },
    set ink(v: number) { ink = v; },
    getContext(): FakeCtx | null {
      return {
        drawImage(src: Fake) { c.ink = src.ink; },
      };
    },
    toDataURL(_type?: string, quality?: number) {
      // The decoded value of the URL is the ink, so a black tile is ink === 0;
      // quality is folded in so two encodes of one canvas are distinguishable.
      return `data:image/jpeg;base64,${c.ink}@${quality}`;
    },
  } as unknown as Fake;
  return c;
}

/** A source canvas holding `ink` - any non-zero number stands in for "a photo". */
function source(w: number, h: number, ink = 1): Fake {
  const c = makeCanvas(w, h);
  c.ink = ink;
  return c;
}

/**
 * What `document.createElement("canvas")` hands back inside `canvasCache`.
 *
 * Only the canvases this file allocates are recorded, so an assertion on how
 * many were made is a statement about this test alone and not about how many
 * scratches the module had already allocated in an earlier one.
 */
const made: Fake[] = [];
const realDocument = globalThis.document;

function inkOf(url: string | null): number {
  if (url === null) return -1;
  const payload = url.split(",")[1] ?? "";
  return Number(payload.split("@")[0]);
}

beforeEach(() => {
  globalThis.document = {
    createElement() {
      const c = makeCanvas();
      made.push(c);
      return c;
    },
  } as unknown as Document;
});

afterEach(() => {
  globalThis.document = realDocument;
});

describe("thumbnailUrl", () => {
  it("is null for a null canvas, before touching any DOM", () => {
    expect(thumbnailUrl(null, 0.8)).toBeNull();
    expect(made).toHaveLength(0);
  });

  it("carries the pixels through for a two-step source, rather than encoding a blank canvas", () => {
    // 6144x8160 is a 50 MP photo: two resample steps, which is the case that
    // regressed to black.
    expect(inkOf(thumbnailUrl(source(6144, 8160, 7) as never, 0.8))).toBe(7);
  });

  it("carries the pixels through for a one-step source", () => {
    // 1000x800 is over the thumbnail's short edge but under the intermediate, so
    // it is a single step and exercises no scratch reuse at all.
    expect(inkOf(thumbnailUrl(source(1000, 800, 3) as never, 0.8))).toBe(3);
  });

  it("encodes the source directly when it is already at or under thumbnail size", () => {
    const cv = source(200, 150, 9);
    expect(inkOf(thumbnailUrl(cv as never, 0.8))).toBe(9);
  });

  it("encodes the source directly for a degenerate canvas it cannot draw", () => {
    expect(inkOf(thumbnailUrl(source(0, 0, 4) as never, 0.8))).toBe(4);
  });

  it("returns a cached URL for the same canvas and quality, without resampling again", () => {
    const cv = source(6144, 8160, 6);
    const first = thumbnailUrl(cv as never, 0.8);
    const second = thumbnailUrl(cv as never, 0.8);
    expect(second).toBe(first);
  });

  it("keeps a thumbnail encode and a viewer encode of one canvas apart", () => {
    // Same canvas, two qualities: if these shared a key the viewer would be
    // served a 252 px thumbnail.
    const cv = source(6144, 8160, 2);
    expect(thumbnailUrl(cv as never, 0.9)).not.toBe(thumbnailUrl(cv as never, 0.8));
  });

  it("serves a fresh canvas its own encode, so a replaced canvas cannot serve a stale one", () => {
    const before = thumbnailUrl(source(6144, 8160, 1) as never, 0.8);
    const after = thumbnailUrl(source(6144, 8160, 2) as never, 0.8);
    expect(inkOf(before)).toBe(1);
    expect(inkOf(after)).toBe(2);
  });
});
