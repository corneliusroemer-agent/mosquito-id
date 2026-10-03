import { test, expect, boot, populate, settle, errors } from "../helpers/app";

/**
 * A tile that cannot be opted in, and cannot be selected for viewing.
 *
 * Two symptoms were reported from the same photo: the thumbnail "does not select",
 * and its include checkbox "does not respond". The checkbox half is confirmed -
 * `renderThumbnails` writes `node.chk.disabled = true` for any photo the strip
 * will not pool, and a disabled checkbox silently ignores clicks, which is
 * indistinguishable from a broken one.
 *
 * The selection half is NOT what it looks like. `selectPhoto` runs, `selectedIndex`
 * moves, the tile takes `active`, the photo name changes and both panels redraw -
 * the click is honoured and the user can see it. What the panel cannot show is a
 * CROP, because there is no `cropCanvas`, so for two uncropped photos the zoomed
 * panel is the same picture either way. Tests below assert selection is VISIBLE
 * in observable state for exactly that reason: "no error was thrown" is what let
 * the checkbox half ship.
 *
 * `isSelectable` is a pure function of a photo record, so its whole truth table is
 * enumerated below rather than the two rows that happened to be reported. The
 * predicate itself lives in `src/app/main.js`, which is not this branch's to
 * restructure, so the table is exercised through the rendering that consumes it.
 */
type State = {
  /** The nuisance gate rejected the crop; the whole frame was classified. */
  crop_rejected?: boolean;
  pending?: boolean;
  error?: string | null;
  is_cropped?: boolean;
  /** A verdict RECORD, as the app stores it - the gate reads `verdict.state`. */
  verdict?: { state: "species" | "genus" | "unsure" | "non-mosquito" } | null;
};

const CASES: { name: string; state: State; poolable: boolean }[] = [
  { name: "cropped, classified to a species", state: { is_cropped: true, verdict: { state: "species" } }, poolable: true },
  { name: "cropped, classified to a genus", state: { is_cropped: true, verdict: { state: "genus" } }, poolable: true },
  { name: "cropped, not confident enough to name a genus", state: { is_cropped: true, verdict: { state: "unsure" } }, poolable: true },
  { name: "cropped, classified not-a-mosquito", state: { is_cropped: true, verdict: { state: "non-mosquito" } }, poolable: false },
  { name: "uncropped, whole frame named", state: { is_cropped: false, verdict: { state: "species" } }, poolable: true },
  { name: "crop rejected, whole frame named", state: { is_cropped: false, crop_rejected: true, verdict: { state: "species" } }, poolable: true },
  { name: "still classifying", state: { is_cropped: false, pending: true, verdict: null }, poolable: false },
  { name: "classification failed", state: { is_cropped: false, error: "Classification failed: boom", verdict: null }, poolable: false },
  { name: "crop rejected AND pending", state: { is_cropped: false, crop_rejected: true, pending: true, verdict: null }, poolable: false },
  { name: "crop rejected AND failed", state: { is_cropped: false, crop_rejected: true, error: "boom", verdict: null }, poolable: false },
  { name: "crop rejected AND classified not-a-mosquito", state: { is_cropped: false, crop_rejected: true, verdict: { state: "non-mosquito" } }, poolable: false },
  { name: "no verdict at all", state: { is_cropped: true, verdict: null }, poolable: true },
];

test.describe("tile states", () => {
  test("the include checkbox is enabled exactly when the photo can be pooled", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "seed.jpg", state: "species" }]);

    const rows = await page.evaluate((cases) => {
      const A = window.__mosqAsync!;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 300;
      canvas.getContext("2d")!.fillRect(0, 0, 300, 300);
      const base: any = {
        fullCanvas: canvas, contextCanvas: null, detail: {}, scores: {}, logits: null, adP: null,
        adjacentDetail: null, pending: false, error: null, is_cropped: true, crop_rejected: false,
        status: "ok", rev: 0, agreement: null, viewsLanded: 0, viewsTotal: 0,
        verdict: { state: "species", genus: "Aedes", species: "Aedes aegypti", topGenusP: 0.9, topSpeciesP: 0.8, runnersUp: [] },
      };
      A.previews.length = 0;
      A.includedIndices.clear();
      for (const c of cases) {
        A.previews.push({
          ...base,
          fullCanvas: canvas,
          name: c.name,
          ...c.state,
          verdict: c.state.verdict ? { ...base.verdict, ...c.state.verdict } : null,
          fingerprint: "fp_" + c.name,
        });
      }
      A.selectedIndex = 0;
      document.getElementById("gallery-section")!.style.display = "block";
      document.getElementById("results-table-section")!.style.display = "block";
      A.renderThumbnails();
      A.renderActivePhoto();
      A.updatePooling();
      A.renderResultsTable();

      const strip = document.getElementById("thumbnail-strip")!;
      return cases.map((c, i) => {
        const tile = strip.children[i] as HTMLElement;
        const chk = tile.querySelector(".thumb-optin") as HTMLInputElement;
        const badge = tile.querySelector(".crop-badge") as HTMLElement;
        return {
          name: c.name,
          disabled: chk.disabled,
          badge: badge.textContent,
          badgeTitle: badge.title,
          labelTitle: (tile.querySelector(".thumb-optin") as HTMLInputElement).title,
          accessibleName: (tile.querySelector(".thumb-optin") as HTMLInputElement).getAttribute("aria-label"),
        };
      });
    }, CASES);

    for (const [i, c] of CASES.entries()) {
      const got = rows[i]!;
      expect(
        got.disabled,
        `"${c.name}": checkbox ${got.disabled ? "disabled" : "enabled"}, expected ${c.poolable ? "enabled" : "disabled"}`,
      ).toBe(!c.poolable);
    }
    expect(errors(page)).toHaveLength(0);
  });

  test("a tile that cannot be pooled says why, in text a user can reach", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "seed.jpg", state: "species" }]);

    const rows = await page.evaluate((cases) => {
      const A = window.__mosqAsync!;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 300;
      const base: any = {
        fullCanvas: canvas, contextCanvas: null, detail: {}, scores: {}, logits: null, adP: null,
        adjacentDetail: null, pending: false, error: null, is_cropped: true, crop_rejected: false,
        status: "ok", rev: 0, agreement: null, viewsLanded: 0, viewsTotal: 0,
        verdict: { state: "species", genus: "Aedes", species: "Aedes aegypti", topGenusP: 0.9, topSpeciesP: 0.8, runnersUp: [] },
      };
      A.previews.length = 0;
      A.includedIndices.clear();
      for (const c of cases) {
        A.previews.push({
          ...base, fullCanvas: canvas, name: c.name, ...c.state,
          verdict: c.state.verdict ? { ...base.verdict, ...c.state.verdict } : null,
          fingerprint: "fp_" + c.name,
        });
      }
      A.selectedIndex = 0;
      document.getElementById("gallery-section")!.style.display = "block";
      A.renderThumbnails();
      A.renderActivePhoto();
      A.updatePooling();
      A.renderResultsTable();
      const strip = document.getElementById("thumbnail-strip")!;
      return cases.map((_c, i) => {
        const tile = strip.children[i] as HTMLElement;
        const chk = tile.querySelector(".thumb-optin") as HTMLInputElement;
        return {
          disabled: chk.disabled,
          chkTitle: chk.title,
          labelTitle: (tile.querySelector(".thumb-optin") as HTMLInputElement).title,
          accessibleName: (tile.querySelector(".thumb-optin") as HTMLInputElement).getAttribute("aria-label"),
          badgeTitle: (tile.querySelector(".crop-badge") as HTMLElement).title,
          cursor: getComputedStyle(chk).cursor,
        };
      });
    }, CASES);

    for (const [i, c] of CASES.entries()) {
      const got = rows[i]!;
      if (c.poolable) continue;
      // A control the user cannot operate must SAY why. The rule this enforces is
      // the one that let the bug ship: a disabled checkbox with an empty tooltip
      // is indistinguishable from a broken one, and "it is greyed out" is not an
      // explanation anyone can act on.
      const reasons = [got.chkTitle, got.labelTitle, got.badgeTitle].filter(Boolean).join(" | ");
      expect(
        reasons.length,
        `"${c.name}" is not poolable but nothing on its tile says why (badge title: "${got.badgeTitle}")`,
      ).toBeGreaterThan(0);
      expect(
        reasons.toLowerCase(),
        `"${c.name}": the stated reason must name the cause, got "${reasons}"`,
      ).toMatch(/detect|classif|confidence|mosquito|pending|processing|fail/i);
      // And it must read as inert rather than merely ignoring clicks: the
      // `disabled` attribute has to be on the control, not only implied by it
      // looking greyed out, because that is what makes the browser refuse the
      // click instead of the click landing and changing nothing.
      expect(got.disabled, `"${c.name}" must carry the disabled attribute itself`).toBe(true);
      expect(got.cursor, `"${c.name}": a disabled control must not offer a pointer cursor`).not.toBe("pointer");
    }
  });

  test("clicking an uncropped thumbnail visibly selects it", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "cropped.jpg", state: "species", is_cropped: true },
      // No box to crop. Uncropped, so the zoomed panel has no crop to show.
      { name: "whole_frame.jpg", state: "species", is_cropped: false },
    ]);
    await settle(page);

    const strip = page.locator("#thumbnail-strip .tile");
    await expect(strip.nth(0)).toHaveClass(/active/);
    await expect(page.locator("#photo-name")).toContainText("cropped.jpg");
    const nameBefore = await page.locator("#photo-name").innerText();

    await strip.nth(1).locator(".tile-btn").click();
    await settle(page);

    // The selection is observable in three independent places. Any one of them
    // passing would be enough; all three is what "the click was honoured" means.
    await expect(strip.nth(1)).toHaveClass(/active/);
    await expect(strip.nth(0)).not.toHaveClass(/active/);
    await expect(page.locator("#photo-name")).toContainText("whole_frame.jpg");
    expect(await page.locator("#photo-name").innerText()).not.toBe(nameBefore);
    expect(await page.evaluate(() => window.__mosqAsync!.selectedIndex)).toBe(1);

    // And the panel shows the photo itself, so the user can see what they selected.
    // With no crop the panel draws the full frame rather than nothing: the claim
    // that an uncropped photo shows an empty panel is what makes the tile read as
    // inert, and an empty panel for a photo the user just selected is the defect.
    await expect(page.locator("#context-img")).toBeVisible();
    await expect(page.locator("#crop-empty")).toBeHidden();
    const src = await page.locator("#context-img").getAttribute("src");
    expect(src, "the zoomed panel must show something for the selected photo").toMatch(/^data:image/);

    // A photo with no crop says so, in the caption, rather than only on a badge.
    await expect(page.locator("#photo-name")).not.toContainText("analysing");
  });

  test("an uncropped photo says why it is not pooled, in the contribution table", async ({ page }) => {
    await boot(page);
    // Three poolable mosquitoes plus one the detector missed. Checked by force:
    // the checkbox is disabled for it, which is correct - the question is whether
    // the user is TOLD, and told in the pooled card rather than on a badge tooltip
    // they may never find.
    await populate(page, [
      { name: "a_01.jpg", state: "species", species: "Aedes aegypti" },
      { name: "a_02.jpg", state: "species", species: "Aedes aegypti" },
      { name: "a_03.jpg", state: "species", species: "Aedes aegypti" },
    ]);
    await settle(page);
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 300;
      A.previews.push({
        name: "nothing_here.jpg", fullCanvas: canvas, cropCanvas: null, contextCanvas: null,
        detail: {}, scores: {}, logits: null, adP: null, adjacentDetail: null, verdict: null,
        pending: false, error: null, is_cropped: false, crop_rejected: true, status: "whole photo analysed (the detector found no box)",
        rev: 0, agreement: null, viewsLanded: 0, viewsTotal: 0, fingerprint: "fp_nm",
      });
      A.includedIndices.add(3);
      A.renderThumbnails();
      A.updatePooling();
    });
    await settle(page);

    // It contributes nothing: the three mosquitoes' shares are unchanged by its
    // presence, which is the fusion-path guarantee the gate exists to protect.
    // It gets its own row, with a dash rather than a share, because a checked
    // photo that is not pooled has to be visible as such.
    const shares = await page.locator("#contribution-table tbody tr").evaluateAll((rows) =>
      rows.map((r) => `${(r as HTMLTableRowElement).cells[0]!.textContent!.split("\n")[0]}=${(r as HTMLTableRowElement).cells[1]!.textContent}`),
    );
    expect(shares.filter((s) => s.includes("33.3%"))).toHaveLength(3);
    // The excluded row's first cell carries its reason as well as its name, so
    // the row is matched on the name and read for the dash.
    const excluded = shares.find((s) => s.startsWith("no_mosquito.jpg"));
    expect(excluded, "the unclassified photo must be listed").toMatch(/=-$/);
  });

  test("a photo with no detection never hangs or crashes the batch", async ({ page }) => {
    // The reported first symptom, asserted the way it was reported: a photo with
    // no mosquito in it must not take the page down. Driven through the real
    // `processFiles` entry point with a real image file.
    await boot(page);
    const png = await page.evaluate(() => {
      const cv = document.createElement("canvas");
      cv.width = 400;
      cv.height = 300;
      const g = cv.getContext("2d")!;
      // A near-uniform field: nothing in it for a detector to find.
      g.fillStyle = "#8a8f92";
      g.fillRect(0, 0, 400, 300);
      return cv.toDataURL("image/png").split(",")[1]!;
    });
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await window.__mosqAsync!.processFiles([
        new File([bytes], "blank.png", { type: "image/png" }),
      ]);
    }, png);
    await settle(page);

    // No model session in this tier, so the batch queues; the contract under test
    // is that it says so and leaves the page working.
    const alive = await page.evaluate(() => ({
      hasSeam: !!window.__mosqAsync?.renderThumbnails,
      progressMsg: document.getElementById("progress-msg")!.textContent ?? "",
      bodyIntact: !!document.getElementById("dropzone"),
    }));
    expect(alive.hasSeam).toBe(true);
    expect(alive.bodyIntact).toBe(true);
    expect(alive.progressMsg.length, "a queued photo must say why it is waiting").toBeGreaterThan(0);
    expect(errors(page).filter((e) => !/onnx|r2\.dev|ERR_|Failed to fetch|initializ/i.test(e))).toHaveLength(0);
  });
});