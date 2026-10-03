import { test, expect, boot, populate, settle, startCls, readCls, errors } from "../helpers/app";
import type { PhotoSpec } from "../helpers/app";

/**
 * Cumulative LayoutShift = 0.
 *
 * Zero, not "small". The app's whole layout budget is spent before the CLS is
 * measured: `index.html` gives the progress slot a fixed height, the combined
 * card a fixed-height score region, and the results table fixed column widths,
 * all specifically so that work starting and finishing moves nothing. The number
 * is the check that those mechanisms still hold.
 *
 * `hadRecentInput` shifts are excluded (the standard's own exclusion), so what is
 * counted here is the app moving something on its own: a tile resolving, a
 * selection changing, a row leaving.
 */

const BATCH: PhotoSpec[] = Array.from({ length: 10 }, (_, i) => ({
  name: `photo_${i}.jpg`,
  state: "species",
  species: i % 2 ? "Aedes aegypti" : "Culex pipiens",
}));

test.describe("cumulative layout shift", () => {
  test("a batch landing moves nothing", async ({ page }) => {
    await boot(page);
    await startCls(page);

    await populate(page, BATCH);
    await settle(page);

    expect(await readCls(page), await describeShifts(page)).toBe(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("moving the selection around moves nothing", async ({ page }) => {
    await boot(page);
    await populate(page, BATCH);
    await startCls(page);

    for (let i = 0; i < 10; i++) {
      await page.locator("#thumbnail-strip .tile").nth(i).locator(".tile-btn").click();
      await settle(page);
    }
    expect(await readCls(page), await describeShifts(page)).toBe(0);
  });

  test("selecting and deselecting photos moves nothing", async ({ page }) => {
    await boot(page);
    await populate(page, BATCH);
    await startCls(page);

    await page.locator("#btn-select-none").click();
    await settle(page);
    await page.locator("#btn-select-all").click();
    await settle(page);

    const boxes = page.locator("#thumbnail-strip .tile .thumb-optin");
    for (const i of [0, 3, 7, 9]) {
      await boxes.nth(i).uncheck();
      await settle(page);
      await boxes.nth(i).check();
      await settle(page);
    }
    expect(await readCls(page), await describeShifts(page)).toBe(0);
  });

  test("deleting the leftmost and the last photo moves nothing", async ({ page }) => {
    await boot(page);
    await populate(page, BATCH);
    await startCls(page);

    // Leftmost first: it is the case that renumbers every tile after it and
    // shifts the selection down, so it is the one that would move the page if
    // anything did.
    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);

    await page.locator("#thumbnail-strip .tile").last().locator(".tile-delete-btn").click();
    await settle(page);

    await page.locator("#btn-delete-all").click();
    await settle(page);

    expect(await readCls(page), await describeShifts(page)).toBe(0);
  });

  test("the whole sequence - batch, select, delete - accumulates to zero", async ({ page }) => {
    // The measured value the requirement names is the total across all of it, not
    // each step alone: four steps that each shift 0.4 sum to a CLS that fails.
    await boot(page);
    await startCls(page);

    await populate(page, BATCH);
    await settle(page);
    const afterBatch = await readCls(page);

    await page.locator("#thumbnail-strip .tile").nth(4).locator(".tile-btn").click();
    await settle(page);

    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);

    await page.locator("#btn-delete-all").click();
    await settle(page);

    expect(afterBatch, "the batch alone already shifted").toBe(0);
    expect(await readCls(page), await describeShifts(page)).toBe(0);
  });

  test("a verdict resolving from unsure to named moves nothing", async ({ page }) => {
    await boot(page);
    // The pooled card's candidate list grows when the pool becomes decidable, and
    // a growing list inside the card would push the gallery down. The card's
    // height is fixed for exactly this.
    await populate(page, [
      { name: "a_01.jpg", state: "unsure", species: "Aedes aegypti" },
      { name: "a_02.jpg", state: "unsure", species: "Aedes aegypti" },
      { name: "c_01.jpg", state: "species", species: "Culex pipiens" },
    ]);
    await settle(page);
    await startCls(page);

    await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const emb = A.embeds;
      // The two abstentions become real claims, through the shipped gate.
      for (let i = 0; i < 2; i++) {
        const p = A.previews[i]!;
        const spP = new Array(emb.species.length).fill(0.02);
        spP[emb.species.indexOf("Aedes aegypti")] = 0.78;
        p.detail = Object.fromEntries(emb.species.map((s: string, j: number) => [s, spP[j]]));
        p.scores = { Aedes: 0.82, Culex: 0.18 };
        p.logits = Object.fromEntries(emb.species.map((s: string, j: number) => [s, Math.log(spP[j])]));
        p.verdict = A.verdictFrom(spP, null, []);
      }
      A.renderThumbnails();
      A.renderActivePhoto();
      A.updatePooling();
      A.renderResultsTable();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    });

    // The pool now has three contributors rather than one, so the card carries a
    // real ranking and the contribution table has three rows.
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(3);
    expect(await readCls(page), await describeShifts(page)).toBe(0);
  });
});

/** Names the offending elements when CLS is nonzero, so a failure is diagnosable. */
async function describeShifts(page: import("@playwright/test").Page): Promise<string> {
  const log = await page.evaluate(() => window.__mosqShiftLog ?? []);
  return log.length ? `shifts: ${log.join(" | ")}` : "";
}