import { boot, errors, expect, populate, settle, test } from "../helpers/app";

/**
 * Where a click on a tile actually lands.
 *
 * Two reports, one cause. A click on the tile labelled "View photo 2:
 * photo_C.jpg" selected a different photo, and the rightmost tile's checkbox
 * could be clicked with nothing happening. Both are a handler writing an index
 * that is no longer the photo's: after a second batch prepends, every existing
 * photo's index grows by one while its tile node is reused, so a captured index
 * lands on a *neighbouring* photo - and because that neighbour is a real photo,
 * the re-render then unchecks the box that was clicked and the click looks inert.
 *
 * These tests prepend rather than delete, because deleting leaves a gap where a
 * stale index would be dropped and do nothing visible. Prepending is the case
 * that produces the reported symptom.
 */

const THREE = [
  { name: "photo_A.jpg", state: "species" as const },
  { name: "photo_B.jpg", state: "species" as const },
  { name: "photo_C.jpg", state: "species" as const },
];

/** What `processFiles` does when a second batch lands: new photos in front. */
async function prepend(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    const A = window.__mosqAsync!;
    const proto = A.previews[0];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 120;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#a37";
    g.fillRect(0, 0, 120, 120);
    const shifted = new Set<number>();
    for (const i of A.includedIndices) shifted.add(i + 1);
    A.includedIndices = shifted;
    A.previews.unshift({
      ...proto, name: n, fingerprint: "fp_" + n, fullCanvas: canvas,
      cropCanvas: canvas, contextCanvas: canvas, verdict: { ...proto.verdict },
    });
    A.renderThumbnails();
    A.renderActivePhoto();
    A.updatePooling();
  }, name);
  await settle(page);
}

const state = (page: import("@playwright/test").Page) => page.evaluate(() => ({
  sel: window.__mosqAsync!.selectedIndex,
  included: [...window.__mosqAsync!.includedIndices].sort((a, b) => a - b),
  names: window.__mosqAsync!.previews.map((p) => p.name),
  boxes: [...document.querySelectorAll<HTMLInputElement>("#thumbnail-strip .thumb-optin")]
    .map((c) => c.checked),
  labels: [...document.querySelectorAll("#thumbnail-strip .tile-btn")]
    .map((b) => b.getAttribute("aria-label")),
}));

test.describe("strip click targets", () => {
  test("the rightmost tile's checkbox checks the photo its own label names", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.includedIndices.clear();
      A.renderThumbnails();
      A.updatePooling();
    });
    await settle(page);

    await prepend(page, "NEW.jpg");

    const before = await state(page);
    expect(before.labels[before.labels.length - 1]).toBe("View photo 4: photo_C.jpg");

    await page.locator("#thumbnail-strip .tile").last().locator(".thumb-optin").click();
    await settle(page);

    const after = await state(page);
    expect(after.included, "the last photo entered the pool").toEqual([3]);
    expect(after.boxes[after.boxes.length - 1], "and the box that was clicked stays checked").toBe(true);
    expect(after.names[3]).toBe("photo_C.jpg");
    expect(errors(page)).toHaveLength(0);
  });

  test("every tile's checkbox checks the photo its own label names, after a prepend", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.includedIndices.clear();
      A.renderThumbnails();
      A.updatePooling();
    });
    await settle(page);
    await prepend(page, "NEW.jpg");

    const tiles = page.locator("#thumbnail-strip .tile");
    for (let i = 0; i < 4; i++) {
      await tiles.nth(i).locator(".thumb-optin").click();
      const s = await state(page);
      expect(s.boxes[i], `box ${i} after clicking it`).toBe(true);
      expect(s.boxes.slice(0, i).every(Boolean), `boxes 0..${i - 1} stay checked`).toBe(true);
      // Each click adds exactly its own photo and no other: the pool grows by one
      // entry, and that entry is the tile that was clicked.
      expect(s.included, `includedIndices after clicking box ${i}`)
        .toEqual(Array.from({ length: i + 1 }, (_, k) => k));
    }
    expect(errors(page)).toHaveLength(0);
  });

  test("every tile selects the photo its own label names, after a prepend", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await prepend(page, "NEW.jpg");

    const tiles = page.locator("#thumbnail-strip .tile");
    for (let i = 0; i < 4; i++) {
      const label = (await state(page)).labels[i]!;
      await tiles.nth(i).locator(".tile-btn").click();
      await settle(page);
      const s = await state(page);
      expect(s.sel, `clicked the tile labelled ${label}`).toBe(i);
      expect(`View photo ${i + 1}: ${s.names[i]}`, `label of tile ${i}`).toBe(label);
      await expect(tiles.nth(i)).toHaveClass(/active/);
    }
    expect(errors(page)).toHaveLength(0);
  });

  test("a tile's controls are not nested and the tile has no handler of its own", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);

    // The three shapes that make a click land on the wrong control: a control
    // inside a control, a label re-dispatching, and a tile-level handler catching
    // a bubbled click from its children. None may be present.
    const shape = await page.evaluate(() => {
      const tile = document.querySelector<HTMLElement>("#thumbnail-strip .tile")!;
      const controls = [...tile.querySelectorAll("button, input, label")];
      return {
        controls: controls.map((c) => c.tagName + "." + c.className),
        anyNested: controls.some((c) => c.parentElement?.closest("button, label") !== null),
        anyLabel: tile.querySelectorAll("label").length,
        tileInlineHandler: Object.keys(tile).some((k) => k.startsWith("on")),
      };
    });
    expect(shape.controls).toEqual([
      "BUTTON.tile-btn", "INPUT.thumb-optin", "BUTTON.tile-delete-btn",
    ]);
    expect(shape.anyNested, "no control inside another control").toBe(false);
    expect(shape.anyLabel, "no label wrapper").toBe(0);
    expect(shape.tileInlineHandler, "no handler on the tile itself").toBe(false);
  });

  test("the include checkbox is a real tap target, not a 14px dot", async ({ page }) => {
    await boot(page);
    await populate(page, THREE);
    await settle(page);

    const box = await page.locator("#thumbnail-strip .tile").first()
      .locator(".thumb-optin").boundingBox();
    // Square, and at least the WCAG 2.2 minimum target size. A stretched native
    // checkbox renders distorted, so the shape is asserted as well as the size.
    expect(box!.width, "checkbox width").toBeGreaterThanOrEqual(24);
    expect(box!.height, "checkbox height").toBeGreaterThanOrEqual(24);
    expect(box!.width, "the checkbox stays square").toBe(box!.height);

    // And the whole box is inside its own tile: a control that overhangs its
    // tile steals the neighbour's click.
    const inside = await page.evaluate(() => {
      const tile = document.querySelector<HTMLElement>("#thumbnail-strip .tile")!;
      const chk = tile.querySelector<HTMLElement>(".thumb-optin")!;
      const t = tile.getBoundingClientRect();
      const c = chk.getBoundingClientRect();
      return c.left >= t.left - 1 && c.right <= t.right + 1;
    });
    expect(inside, "the checkbox stays within its own tile").toBe(true);
  });
});
