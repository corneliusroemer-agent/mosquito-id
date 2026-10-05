import { boot, errors, expect, populate, settle, test } from "../helpers/app";

/**
 * What the strip tells you, and what it does when you act on a tile.
 *
 * Everything asserted here is `docs/THUMBNAIL-STRIP-SPEC.md` §3.3, §3.5, §5 and
 * §6: the parts of the strip's contract that are about FEEDBACK and about what a
 * click visibly does, rather than about which index a handler ends up using
 * (`strip-index-stability.spec.ts`) or about layout (`layout-shift.spec.ts`).
 *
 * Two of these are the reported defects themselves. A selection the user cannot
 * see is a selection that did not happen, and a queued photo whose panel claims
 * no mosquito was detected is a panel making a statement about a classification
 * that has not run.
 */

const FOUR = [
  { name: "photo_A.jpg", state: "species" as const },
  { name: "photo_B.jpg", state: "species" as const },
  { name: "photo_C.jpg", state: "species" as const },
  { name: "photo_D.jpg", state: "genus" as const },
];

const tile = (page: import("@playwright/test").Page, i: number) =>
  page.locator("#thumbnail-strip .tile").nth(i);

/** Put a photo into a state `populate` cannot build: no pixels, still queued. */
async function queue(page: import("@playwright/test").Page, indices: number[]): Promise<void> {
  await page.evaluate((idx) => {
    const A = window.__mosqAsync!;
    for (const i of idx) {
      A.previews[i].displayCanvas = null;
      A.previews[i].cropCanvas = null;
      A.previews[i].contextCanvas = null;
      A.previews[i].pending = true;
      A.previews[i].verdict = null;
      A.previews[i].is_cropped = false;
    }
    A.renderThumbnails();
    A.renderActivePhoto();
    A.updatePooling();
  }, indices);
  await settle(page);
}

test.describe("strip feedback", () => {
  test("a selected tile outside the strip's viewport is scrolled into view (spec §5)", async ({ page }) => {
    await boot(page);
    // Fourteen photos: enough for the strip to overflow its box at desktop width.
    await populate(page, Array.from({ length: 14 }, (_, i) => ({
      name: `p${String(i + 1).padStart(2, "0")}.jpg`,
      state: "species" as const,
    })));
    await settle(page);

    const boxOf = (i: number) => page.evaluate((n) => {
      const strip = document.getElementById("thumbnail-strip")!;
      const t = document.querySelectorAll<HTMLElement>("#thumbnail-strip .tile")[n]!;
      const sr = strip.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      return { left: tr.left, right: tr.right, viewLeft: sr.left, viewRight: sr.right };
    }, i);

    // Walk the selection to the far end with the keyboard, which is how a user
    // reaches a tile they never scrolled to.
    await page.locator("#thumbnail-strip .tile-btn").first().focus();
    for (let i = 0; i < 13; i++) await page.keyboard.press("ArrowRight");
    await settle(page);

    expect(await page.evaluate(() => window.__mosqAsync!.selectedIndex)).toBe(13);
    const end = await boxOf(13);
    expect(end.right, "the selected tile's right edge").toBeLessThanOrEqual(end.viewRight + 1);
    expect(end.left, "the selected tile's left edge").toBeGreaterThanOrEqual(end.viewLeft - 1);

    // And back to the start, the other way.
    for (let i = 0; i < 13; i++) await page.keyboard.press("ArrowLeft");
    await settle(page);
    const start = await boxOf(0);
    expect(start.left).toBeGreaterThanOrEqual(start.viewLeft - 1);
    expect(start.right).toBeLessThanOrEqual(start.viewRight + 1);
    expect(errors(page)).toHaveLength(0);
  });

  test("focus follows the selection when the keyboard moves it (spec §6)", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);

    await page.locator("#thumbnail-strip .tile-btn").first().focus();
    await page.keyboard.press("ArrowRight");
    await settle(page);
    // Focus left behind on tile 0 would make Enter act on a photo other than the
    // one the highlight is on.
    await expect(page.locator("#thumbnail-strip .tile").nth(1).locator(".tile-btn")).toBeFocused();
    await page.keyboard.press("End");
    await settle(page);
    await expect(page.locator("#thumbnail-strip .tile").nth(3).locator(".tile-btn")).toBeFocused();
    await page.keyboard.press("Home");
    await settle(page);
    await expect(page.locator("#thumbnail-strip .tile").first().locator(".tile-btn")).toBeFocused();
  });

  test("the tile's controls are in reading order, with delete last (spec §6)", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);

    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#thumbnail-strip .tile")[0]!.children)
        .map((c) => c.className),
    );
    expect(order[0]).toContain("tile-btn");
    expect(order[1]).toContain("thumb-optin");
    expect(order[2]).toContain("tile-delete-btn");

    // Tab from the select button reaches the checkbox next, not the delete button.
    await page.locator("#thumbnail-strip .tile-btn").first().focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#thumbnail-strip .tile").first().locator(".thumb-optin")).toBeFocused();
  });

  test("every tile control has an accessible name, in every state (spec §3, §6)", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "cropped.jpg", state: "species" },
      { name: "non_mosquito.jpg", state: "non-mosquito" },
      { name: "unsure.jpg", state: "unsure" },
      { name: "failed.jpg", state: "species", error: "decode failed" },
    ]);
    await queue(page, [3]);
    await settle(page);

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#thumbnail-strip .tile")).map((t) => {
        const q = (s: string) => t.querySelector(s) as HTMLElement;
        const chk = q(".thumb-optin") as HTMLInputElement;
        return {
          view: q(".tile-btn").getAttribute("aria-label"),
          remove: q(".tile-delete-btn").getAttribute("aria-label"),
          check: chk.getAttribute("aria-label"),
          checkTitle: chk.title,
          disabled: chk.disabled,
          badgeTitle: q(".crop-badge").getAttribute("title"),
        };
      }),
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.view, "select button name").toBeTruthy();
      expect(r.remove, "delete button name").toBeTruthy();
      expect(r.check, "checkbox accessible name").toBeTruthy();
      expect(r.checkTitle, "checkbox tooltip").toBeTruthy();
      expect(r.badgeTitle, "badge tooltip").toBeTruthy();
      // A closed checkbox must not advertise itself as openable.
      if (r.disabled) expect(r.check!).not.toMatch(/^Include photo/);
    }

    // Each state names its own cause, in the checkbox's own name.
    expect(rows[0]!.check).toMatch(/^Include photo 1 \(cropped\.jpg\)/);
    expect(rows[1]!.check).toMatch(/no mosquito/i);
    expect(rows[2]!.check).toMatch(/not confident enough/i);
    expect(rows[3]!.check).toMatch(/waiting|analysed|analys/i);
  });

  test("a badge never has an empty tooltip, and never claims a crop that was not made (spec §3.5)", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "cropped.jpg", state: "species" },
      { name: "non_mosquito.jpg", state: "non-mosquito" },
      { name: "unsure.jpg", state: "unsure" },
    ]);
    await queue(page, [2]);
    await settle(page);

    const badges = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#thumbnail-strip .crop-badge")).map((b) => ({
        glyph: b.textContent,
        title: b.getAttribute("title"),
        cls: b.className,
      })),
    );
    for (const b of badges) expect((b.title ?? "").trim().length).toBeGreaterThan(0);

    // The green cropped tick must not sit on a photo that is not a mosquito.
    const nonMosquito = badges[1]!;
    const unsure = badges[2]!;
    expect(nonMosquito.glyph).toBe("✕");
    expect(nonMosquito.title).toMatch(/no mosquito/i);
    expect(nonMosquito.cls).not.toContain("cropped");
    // A photo the gate could not name is not the same as a photo with no crop.
    expect(nonMosquito.title).not.toBe(unsure.title);
  });

  test("the strip's own buttons say why they are disabled (spec §3.6)", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await settle(page);
    for (const id of ["btn-select-all", "btn-select-none", "btn-delete-all"]) {
      await expect(page.locator(`#${id}`)).toBeEnabled();
      await expect(page.locator(`#${id}`)).toHaveAttribute("title", /\S/);
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-label", /\S/);
    }

    await page.click("#btn-delete-all");
    await settle(page);
    for (const id of ["btn-select-all", "btn-select-none", "btn-delete-all"]) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
      await expect(page.locator(`#${id}`)).toHaveAttribute("title", /no photos/i);
    }
  });

  test("selecting a photo never changes what is checked (spec §2)", async ({ page }) => {
    await boot(page);
    await populate(page, FOUR);
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.includedIndices.clear();
      A.includedIndices.add(0);
      A.includedIndices.add(2);
      A.renderThumbnails();
      A.updatePooling();
    });
    await settle(page);

    const before = await page.evaluate(() => [...window.__mosqAsync!.includedIndices].sort((a, b) => a - b));
    expect(before).toEqual([0, 2]);

    for (const i of [1, 3, 0, 2]) {
      await tile(page, i).locator(".tile-btn").click();
      await settle(page);
      expect(await page.evaluate(() => window.__mosqAsync!.selectedIndex)).toBe(i);
      expect(await page.evaluate(() => [...window.__mosqAsync!.includedIndices].sort((a, b) => a - b)))
        .toEqual(before);
    }
  });

  test("the pooled card says how many are checked and how many are pooled (spec §3.3)", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "named.jpg", state: "species" },
      { name: "also_named.jpg", state: "genus" },
      { name: "unsure.jpg", state: "unsure" },
    ]);
    await settle(page);

    // All three are checked and all three are pooled - an unsure photo is
    // counted, down-weighted - so there is no longer a gap between the ticks and
    // the table. The card still has to say when there is one.
    const summary = page.locator("#inclusion-summary");
    await expect(summary).toHaveText("3 photos in the pooled result");
    const rows = await page.locator("#contribution-table tbody tr").allTextContents();
    expect(rows).toHaveLength(3);
    // The row still says why one of them counts for less than the others.
    expect(rows.join(" ")).toMatch(/not confident enough/i);

    // Unchecking the unsure photo leaves nothing to explain.
    await tile(page, 2).locator(".thumb-optin").click();
    await settle(page);
    await expect(summary).toHaveText("2 photos in the pooled result");
  });

  test("a queued photo's panel does not claim a mosquito was not detected (spec §3.1, §8)", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "queued_a.jpg", state: "species" },
      { name: "queued_b.jpg", state: "species" },
    ]);
    await queue(page, [0, 1]);
    await settle(page);

    const empty = page.locator("#crop-empty");
    await tile(page, 0).locator(".tile-btn").click();
    await settle(page);
    await expect(empty).toBeVisible();
    const first = (await empty.textContent())!.trim();
    expect(first, "a queued photo is not a photo with no mosquito in it").not.toMatch(/no mosquito/i);
    expect(first).toMatch(/queued_a/);

    // Two queued photos must be distinguishable, or selecting one changes nothing
    // the user can see.
    await tile(page, 1).locator(".tile-btn").click();
    await settle(page);
    expect((await empty.textContent())!.trim()).not.toBe(first);
    expect((await empty.textContent())!).toMatch(/queued_b/);
    expect(errors(page)).toHaveLength(0);
  });

  test("on a phone a tile can be selected, checked and deleted (spec §7)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    await populate(page, FOUR);
    // populate() checks every photo; start from one known selection so the
    // assertion is about the tap, not about the fixture.
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.includedIndices.clear();
      A.renderThumbnails();
      A.updatePooling();
    });
    await settle(page);

    await tile(page, 1).locator(".tile-btn").click();
    await settle(page);
    expect(await page.evaluate(() => window.__mosqAsync!.selectedIndex)).toBe(1);
    await expect(tile(page, 1)).toHaveClass(/active/);

    await tile(page, 1).locator(".thumb-optin").click();
    await settle(page);
    expect(await page.evaluate(() => [...window.__mosqAsync!.includedIndices])).toEqual([1]);

    await tile(page, 0).locator(".tile-delete-btn").click();
    await settle(page);
    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(3);
    await expect(page.locator("#thumbnail-strip .tile").first().locator(".tile-btn"))
      .toHaveAttribute("aria-label", "View photo 1: photo_B.jpg");
    // The check follows its photo rather than staying at index 1.
    expect(await page.evaluate(() => [...window.__mosqAsync!.includedIndices])).toEqual([0]);
    expect(errors(page)).toHaveLength(0);
  });
});
