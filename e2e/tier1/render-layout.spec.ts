import type { Page } from "@playwright/test";
import { boot, expect, populate, settle, test } from "../helpers/app";

/**
 * What a render reads from the page, and what order it leaves the strip in.
 *
 * Reading a rect is a synchronous layout of the whole document. `renderThumbnails`
 * runs once per photo as a batch lands, so anything it reads on every render is
 * paid n times per batch - over a strip and a results table the render before it
 * has just rebuilt. The strip is also re-ordered by every render, and the order
 * it must end up in is the one thing a silent failure here would break: a strip
 * whose tiles are in the wrong order still looks like a strip.
 *
 * So this counts real `getBoundingClientRect` calls against the real page rather
 * than reading a flag the app sets about itself.
 */

const THREE = [
  { name: "photo_A.jpg", state: "species" as const },
  { name: "photo_B.jpg", state: "species" as const },
  { name: "photo_C.jpg", state: "genus" as const },
];

/**
 * Count layout reads from here on, run `body`, and report how many it made.
 *
 * The patch is on `Element.prototype`, so every element in the page is counted -
 * not just the strip's - which is what makes a non-zero number mean the render
 * read something rather than that the app left a counter on.
 */
async function countRectsWhile(page: Page, body: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
    if (!window.__rectPatched) {
      const original = proto.getBoundingClientRect;
      window.__rectPatched = true;
      proto.getBoundingClientRect = function (this: Element) {
        window.__rectReads = (window.__rectReads ?? 0) + 1;
        return original.call(this);
      };
      window.__resizes = 0;
      window.addEventListener("resize", () => { window.__resizes = (window.__resizes ?? 0) + 1; });
      // `offsetWidth`/`clientWidth` force a layout just as `getBoundingClientRect`
      // does, and a regression that swapped one for the other would be invisible
      // to a rect-only counter. Instrument the whole family, so "stop forcing a
      // full-document layout" is tested as that and not as "stop calling one
      // particular method". These are counted, not asserted individually - the
      // app legitimately reads them outside the render path.
      for (const [obj, prop] of [
        [Element.prototype, "clientWidth"],
        [Element.prototype, "clientHeight"],
        [Element.prototype, "scrollWidth"],
        [Element.prototype, "scrollHeight"],
        [Element.prototype, "offsetWidth"],
        [Element.prototype, "offsetHeight"],
        [window, "innerWidth"],
        [window, "innerHeight"],
      ] as const) {
        const d = Object.getOwnPropertyDescriptor(
          obj === window ? Window.prototype : obj,
          prop,
        );
        if (!d?.get || (d.get as { __patched?: boolean }).__patched) continue;
        const original = d.get;
        Object.defineProperty(d.get, "__patched", { value: true });
        Object.defineProperty(obj, prop, {
          configurable: true,
          get(this: unknown) {
            window.__rectReads = (window.__rectReads ?? 0) + 1;
            return original.call(this);
          },
        });
      }
    }
    window.__rectReads = 0;
  });
  await body();
  return page.evaluate(() => window.__rectReads ?? 0);
}

/**
 * Resize, and wait for the page to have been told.
 *
 * `setViewportSize` returns before the resize event is delivered, so a render
 * issued straight after it races the listener that invalidates the scroll guard
 * - and would read no layout for the right reason at the wrong moment.
 */
async function resizeAndSettle(page: Page, width: number): Promise<void> {
  const before = await page.evaluate(() => window.__resizes ?? 0);
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction((n) => (window.__resizes ?? 0) > n, before);
}

test.describe("a render that changes nothing reads nothing", () => {
  test("a re-render with the same selection forces no layout", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);

    // The first render after a batch selects photo 1 and scrolls to it; every
    // render after that is a photo landing and nothing else moving.
    const reads = await countRectsWhile(page, () =>
      page.evaluate(() => window.__mosqAsync!.renderThumbnails()),
    );
    expect(reads, "a render that does not change the selection must not read layout").toBe(0);
  });

  test("repeated renders during a batch read no layout after the first", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);

    const reads = await countRectsWhile(page, () =>
      page.evaluate(() => {
        const A = window.__mosqAsync!;
        // What a batch does per photo: the tile's own state changes, the
        // selection does not.
        for (let i = 0; i < 20; i++) {
          A.previews[1].status = `step ${i}`;
          A.renderThumbnails();
        }
      }),
    );
    expect(reads).toBe(0);
  });
});

test.describe("a render that changes the selection still scrolls", () => {
  test("selecting another photo reads layout, and the tile ends up in view", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);

    const reads = await countRectsWhile(page, () =>
      page.evaluate(() => window.__mosqAsync!.selectPhoto(2)),
    );
    expect(reads, "moving the selection is the case the guard must not skip").toBeGreaterThan(0);
    await expect(page.locator("#thumbnail-strip .tile").nth(2)).toHaveClass(/active/);
  });

  test("a prepend that replaces the selected tile still scrolls", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    const before = await page.locator("#thumbnail-strip .tile .tile-btn").first()
      .getAttribute("aria-label");

    // What `processFiles` does: the new batch goes in front and the selection
    // resets to index 0. Same index, different photo, and the strip's contents
    // just changed - so a guard keyed on the index would skip this scroll.
    const reads = await countRectsWhile(page, () =>
      page.evaluate(() => {
        const A = window.__mosqAsync!;
        const fresh = { ...A.previews[0], name: "prepended.jpg" };
        A.previews.unshift(fresh);
        A.selectedIndex = 0;
        A.renderThumbnails();
      }),
    );
    expect(reads, "a different photo in the selected slot must be scrolled to").toBeGreaterThan(0);
    const after = await page.locator("#thumbnail-strip .tile .tile-btn").first()
      .getAttribute("aria-label");
    expect(after).toContain("prepended.jpg");
    expect(after).not.toBe(before);
  });

  test("a resize revives the scroll for an unchanged selection", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    // Nothing about the selection moved, so the render before the resize reads
    // nothing; the strip's box moved, so the next one has to look again.
    await countRectsWhile(page, () => page.evaluate(() => window.__mosqAsync!.renderThumbnails()));

    await resizeAndSettle(page, 700);
    const reads = await countRectsWhile(page, () =>
      page.evaluate(() => window.__mosqAsync!.renderThumbnails()),
    );
    expect(reads, "the strip's box changed under a still selection").toBeGreaterThan(0);
  });
});

test.describe("the strip ends up in index order", () => {
  /** Each tile's own number, in DOM order. */
  const numbersInDomOrder = (page: Page) =>
    page.locator("#thumbnail-strip .tile").evaluateAll((els) =>
      els.map((e) => (e.querySelector(".number") as HTMLElement).textContent),
    );

  test("after a deletion the tiles are renumbered in place", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);

    // The middle tile goes. The tiles after it shift down one index, so they are
    // the ones that have to move in the DOM - and the ones that must not be
    // re-appended if their index did not change.
    await page.evaluate(() => window.__mosqAsync!.deletePhoto(1));
    await settle(page);
    expect(await numbersInDomOrder(page)).toEqual(["1", "2"]);

    const labels = await page.locator("#thumbnail-strip .tile-btn").evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label")),
    );
    expect(labels).toEqual(["View photo 1: photo_A.jpg", "View photo 2: photo_C.jpg"]);
  });

  test("after deleting the first tile the rest keep their order", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    await page.evaluate(() => window.__mosqAsync!.deletePhoto(0));
    await settle(page);
    expect(await numbersInDomOrder(page)).toEqual(["1", "2"]);
    const labels = await page.locator("#thumbnail-strip .tile-btn").evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label")),
    );
    expect(labels).toEqual(["View photo 1: photo_B.jpg", "View photo 2: photo_C.jpg"]);
  });

  test("a render with nothing added or removed leaves the order alone", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      for (let i = 0; i < 5; i++) A.renderThumbnails();
    });
    await settle(page);
    expect(await numbersInDomOrder(page)).toEqual(["1", "2", "3"]);
  });
});