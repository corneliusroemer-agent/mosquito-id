import { test, expect, boot, populate, settle } from "../helpers/app";

/**
 * A tile must act on ITS OWN photo, whatever has happened to the strip since it
 * was built.
 *
 * Two handlers in `buildTile` capture `idx` in a closure at BUILD time, while
 * `tileNodes` is keyed by the photo OBJECT - correctly, because a tile's index
 * stops being its index as soon as a photo before it is deleted. So a tile node
 * survives a deletion and keeps acting on the index it was built with.
 * `delBtn.onclick` is re-pointed on every render, which is why deletion works and
 * selection and inclusion do not.
 *
 * Consequence, in the terms a user would report: delete the leftmost photo, then
 * click a tile that now reads "photo 2" and the app selects photo 3. Click its
 * checkbox and photo 3's inclusion flips instead of photo 2's. Nothing throws,
 * nothing logs an error, and `select_photo` fires with a plausible index - which
 * is why this reached a bug report rather than a stack trace.
 *
 * These are RED against current behaviour. They are the reproduction, kept as
 * tests so the fix is verifiable rather than asserted.
 */

const FOUR = [
  { name: "photo_A.jpg", state: "species" as const },
  { name: "photo_B.jpg", state: "species" as const },
  { name: "photo_C.jpg", state: "species" as const },
  { name: "photo_D.jpg", state: "species" as const },
];

/** What each tile claims to be, read off its own accessible name. */
async function labels(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator("#thumbnail-strip .tile-btn").evaluateAll((els) =>
    els.map((e) => e.getAttribute("aria-label") ?? ""),
  );
}

test.describe("strip index stability", () => {
  test("deleting an earlier photo does not change what a later tile selects", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);
    expect(await labels(page)).toEqual([
      "View photo 1: photo_A.jpg",
      "View photo 2: photo_B.jpg",
      "View photo 3: photo_C.jpg",
      "View photo 4: photo_D.jpg",
    ]);

    // Delete the leftmost tile. Everything after it shifts down one place.
    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);
    expect(await labels(page)).toEqual([
      "View photo 1: photo_B.jpg",
      "View photo 2: photo_C.jpg",
      "View photo 3: photo_D.jpg",
    ]);

    // The tile that says "photo 2" is photo_C. Clicking it must select photo_C.
    await page.locator("#thumbnail-strip .tile").nth(1).locator(".tile-btn").click();
    await settle(page);

    // Asserted on what the app names, not on `selectedIndex` alone: a stale index
    // produces a perfectly valid number that points at the wrong photo, so the
    // number alone cannot tell the two cases apart.
    await expect(page.locator("#photo-name")).toContainText("photo_C.jpg");
    const selected = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      return A.previews[A.selectedIndex]?.name;
    });
    expect(selected, "the selected photo must be the one whose tile was clicked").toBe("photo_C.jpg");
  });

  test("a tile's checkbox toggles its own photo and no other", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);

    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);

    const before = await page.evaluate(() => [...window.__mosqAsync!.includedIndices]);
    const namesBefore = await page.evaluate(() =>
      window.__mosqAsync!.previews.map((p) => p.name),
    );
    expect(before).toEqual([0, 1, 2]);

    // Toggle tile index 1, which the labels say is photo_C.
    await page.locator("#thumbnail-strip .tile").nth(1).locator(".thumb-optin").uncheck();
    await settle(page);

    const after = await page.evaluate(() => [...window.__mosqAsync!.includedIndices]);
    // Exactly one entry left, and it is the one for photo_C.
    expect(after.length, `inclusion changed from ${before} to ${after} - more than one photo flipped`)
      .toBe(2);
    const excludedName = namesBefore[after.includes(0) ? 1 : 0] ?? namesBefore[1];
    // photo_C sits at index 1 after photo_A's deletion, so it must be the one
    // absent from the set.
    expect(
      excludedName,
      `photo_C.jpg is at strip position 1; the excluded photo was ${excludedName}`,
    ).toBe("photo_C.jpg");
  });

  test("a tile's delete button removes the photo its own label names", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);

    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);

    // The tile labelled "photo 3: photo_D.jpg" must delete photo_D. `delBtn` is
    // re-pointed per render, so this one is expected to pass - it is here to pin
    // the behaviour the other two must be brought up to.
    await page.locator("#thumbnail-strip .tile").nth(2).locator(".tile-delete-btn").click();
    await settle(page);

    expect(await labels(page)).toEqual([
      "View photo 1: photo_B.jpg",
      "View photo 2: photo_C.jpg",
    ]);
  });

  test("deleting every photo leaves no tile able to act on a stale index", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);

    // Delete from the left until one remains, then the last. Each deletion shifts
    // every later tile, so this is the sequence that maximises the chance of a
    // handler pointing at an index that no longer exists.
    for (let i = 0; i < 3; i++) {
      await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
      await settle(page);
    }
    expect(await labels(page)).toEqual(["View photo 1: photo_D.jpg"]);

    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-btn").click();
    await settle(page);
    await expect(page.locator("#photo-name")).toContainText("photo_D.jpg");

    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);
    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(0);

    // Nothing left to act on, and the gallery is closed rather than empty.
    await expect(page.locator("#gallery-section")).toBeHidden();
  });

  test("select all then delete one still leaves the remaining tiles correct", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);

    await page.locator("#btn-select-all").click();
    await settle(page);
    expect(await page.evaluate(() => [...window.__mosqAsync!.includedIndices])).toEqual([0, 1, 2, 3]);

    await page.locator("#thumbnail-strip .tile").nth(1).locator(".tile-delete-btn").click();
    await settle(page);

    // Deleting index 1 must renumber the SET, not just the strip: the remaining
    // photos are B, C, D at indices 0, 1, 2 and all three are still checked.
    const included = await page.evaluate(() => [...window.__mosqAsync!.includedIndices]);
    expect(included).toEqual([0, 1, 2]);
    const names = await page.evaluate(() => window.__mosqAsync!.previews.map((p) => p.name));
    expect(names).toEqual(["photo_A.jpg", "photo_C.jpg", "photo_D.jpg"]);

    // And every remaining tile's checkbox reflects its own photo.
    const checked = await page.locator("#thumbnail-strip .thumb-optin").evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).checked),
    );
    expect(checked).toEqual([true, true, true]);
  });
});