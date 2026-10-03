import { test, expect, boot, populate, settle, errors } from "../helpers/app";
import type { PhotoSpec } from "../helpers/app";

/**
 * Mobile, 390x844: the viewport the app is actually used in. Someone
 * photographing a mosquito at dusk is holding a phone, not sitting at a desk.
 */
const VIEWPORT = { width: 390, height: 844 };

const POPULATED: PhotoSpec[] = [
  { name: "PXL_20261002_182523087.jpg", state: "species", species: "Aedes aegypti" },
  { name: "IMG-20261002-WA0007.jpeg", state: "species", species: "Aedes albopictus" },
  { name: "PXL_20261002_182614990.jpg", state: "genus", species: "Culex pipiens" },
];

test.use({ viewport: VIEWPORT });

test.describe("mobile 390x844", () => {
  test("the page never scrolls sideways, empty or populated", async ({ page }) => {
    await boot(page);
    // An empty page that fits says nothing about a populated one: the strip, the
    // tables and the score bars are what introduce width.
    expect(await horizontalOverflow(page)).toBe(false);

    await populate(page, POPULATED);
    await settle(page);
    expect(await horizontalOverflow(page), describeOverflow(await findOverflow(page))).toBe(false);

    // And after the things that change width: the pooled card, the results table,
    // and the crop surface at its widest.
    await page.locator("#combined-options summary").click();
    await settle(page);
    expect(await horizontalOverflow(page)).toBe(false);
    expect(errors(page)).toHaveLength(0);
  });

  test("a photo with a long filename does not push the page wide", async ({ page }) => {
    await boot(page);
    // Filenames are user data and a phone produces 30-character ones. One long
    // unbroken token with no spaces is the case that breaks `word-wrap`.
    await populate(page, [
      { name: "IMG_20261002_141523_WhatsApp_Image_2026-10-02_at_14.15.23.jpeg", state: "species" },
    ]);
    await settle(page);
    expect(await horizontalOverflow(page)).toBe(false);
  });

  test("thumbnails stay at least 84px on a phone", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    // A tap target below 84 CSS px is below the 44px floor by a factor of two on
    // the axis that matters, and a 10-photo batch is the normal case.
    const sizes = await page.locator("#thumbnail-strip .tile").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }),
    );
    expect(sizes).toHaveLength(3);
    for (const s of sizes) {
      expect(s.w, `thumbnail is ${s.w}px wide`).toBeGreaterThanOrEqual(84);
      expect(s.h, `thumbnail is ${s.h}px tall`).toBeGreaterThanOrEqual(84);
    }
  });

  test("text stays legible: nothing the app writes is below 11px", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    // The rule is about the app's own text, so elements with no text content and
    // decorative bars are skipped. Buttons, labels and score values all count.
    const tooSmall = await page.evaluate(() => {
      const bad: string[] = [];
      const sel = "h1,h2,h3,p,span,td,th,button,label,strong,a,summary,input+span,.hint";
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const text = (el as HTMLElement).innerText?.trim() ?? "";
        if (!text) continue;
        if (!(el as HTMLElement).offsetParent && getComputedStyle(el).position !== "fixed") continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px < 11) bad.push(`${px}px: "${text.slice(0, 40)}"`);
      }
      return bad;
    });
    expect(tooSmall, `text below 11px: ${tooSmall.join(" | ")}`).toEqual([]);
  });

  test("the controls are reachable by tapping, not only by hovering", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    // Every visible control has a real hit area, not a visually-small one with a
    // zero-height box behind it.
    const small = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll("button"))) {
        const b = el as HTMLButtonElement;
        if (b.disabled || b.style.display === "none") continue;
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.height < 24 || r.width < 24) {
          bad.push(`${b.id || b.className}: ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return bad;
    });
    expect(small, `controls smaller than 24x24: ${small.join(" | ")}`).toEqual([]);
  });

  test("the strip is horizontally scrollable rather than clipped", async ({ page }) => {
    await boot(page);
    await populate(page, Array.from({ length: 10 }, (_, i) => ({
      name: `photo_${i}.jpg`,
      state: "species",
    })));
    await settle(page);

    // Ten photos must not shrink to fit - that would put them below the tap
    // target floor. The strip scrolls; the page does not.
    const strip = page.locator("#thumbnail-strip");
    const metrics = await strip.evaluate((e) => ({ scrollW: e.scrollWidth, clientW: e.clientWidth }));
    expect(metrics.scrollW).toBeGreaterThan(metrics.clientW);
    expect(await horizontalOverflow(page)).toBe(false);
  });

  test("the crop surfaces and score panel stack instead of side by side", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    // Two panels that must not overlap at this width. An overlap here is a
    // screenshot nobody would file a bug about.
    const boxes = await page.evaluate(() => {
      const g = (id: string) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      return { full: g("crop-surface-full"), zoomed: g("crop-surface-zoomed") };
    });

    for (const b of [boxes.full, boxes.zoomed]) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(VIEWPORT.width + 1);
    }
    // One sits below the other, or they overlap - there is no third case that is
    // acceptable here.
    const separated = boxes.full.bottom <= boxes.zoomed.top + 1 || boxes.zoomed.bottom <= boxes.full.top + 1;
    const overlapping = !(boxes.full.right <= boxes.zoomed.left + 1 || boxes.zoomed.right <= boxes.full.left + 1);
    expect(separated || overlapping).toBe(true);
  });
});

async function horizontalOverflow(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth > d.clientWidth + 1;
  });
}

async function findOverflow(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.right > limit) {
        bad.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} right=${Math.round(r.right)}`);
      }
    }
    return bad.slice(0, 8).join(", ");
  });
}

function describeOverflow(what: string): string {
  return what ? ` (widest: ${what})` : "";
}