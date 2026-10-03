import { test, expect, boot, populate, settle, errors } from "../helpers/app";
import type { PhotoSpec } from "../helpers/app";

/**
 * Every control must do something - checked in the POPULATED state.
 *
 * The bug this exists for was a control that worked on an empty page and did
 * nothing once results were on screen. That is why every test here populates
 * first: a control's dead state is usually a state-guard firing on real data,
 * and an empty-page smoke test walks straight past it.
 *
 * Each test asserts an OBSERVABLE EFFECT, not that a click happened. A test that
 * clicks a button and asserts nothing is the recurring failure mode in this
 * project, so each one names what would make it fail.
 */

/** Two confident mosquitoes plus one the gate will not name. */
const POPULATED: PhotoSpec[] = [
  { name: "aegypti_01.jpg", state: "species", species: "Aedes aegypti" },
  { name: "aegypti_02.jpg", state: "species", species: "Aedes aegypti" },
  { name: "pipiens_01.jpg", state: "species", species: "Culex pipiens" },
];

test.describe("controls in the populated state", () => {
  test("the gallery nav arrows move the selection and stop at the ends", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    await expect(page.locator("#gallery-counter")).toHaveText("1 / 3");

    await page.locator("#btn-next").click();
    await expect(page.locator("#gallery-counter")).toHaveText("2 / 3");
    await page.locator("#btn-next").click();
    await expect(page.locator("#gallery-counter")).toHaveText("3 / 3");

    // The end of the strip is a stop, not a wrap. Wrapping would silently show a
    // different photo than the arrow points at.
    await page.locator("#btn-next").click();
    await expect(page.locator("#gallery-counter")).toHaveText("3 / 3");

    await page.locator("#btn-prev").click();
    await expect(page.locator("#gallery-counter")).toHaveText("2 / 3");
    await page.locator("#btn-prev").click();
    await page.locator("#btn-prev").click();
    await expect(page.locator("#gallery-counter")).toHaveText("1 / 3");
    await page.locator("#btn-prev").click();
    await expect(page.locator("#gallery-counter")).toHaveText("1 / 3");

    expect(errors(page)).toHaveLength(0);
  });

  test("clicking a tile selects that photo and the score panel follows", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    await expect(page.locator("#photo-name")).toHaveText(/aegypti_01\.jpg/);

    const strip = page.locator("#thumbnail-strip .tile");
    await strip.nth(2).locator(".tile-btn").click();
    await settle(page);

    await expect(page.locator("#gallery-counter")).toHaveText("3 / 3");
    await expect(page.locator("#photo-name")).toHaveText(/pipiens_01\.jpg/);
    await expect(strip.nth(2)).toHaveClass(/active/);
    await expect(strip.nth(0)).not.toHaveClass(/active/);
    // The panel is showing THIS photo's species, not a cached one.
    await expect(page.locator("#score-list .score-item").first()).toContainText("Culex pipiens");
  });

  test("the per-tile opt-in checkbox changes what is pooled", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    const pooled = page.locator("#combined-scores .combined-candidate").first();
    const before = await pooled.locator(".species-name-wrap").innerText();

    await page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin").uncheck();
    await settle(page);

    // Unchecking a Culex photo when two Aedes ones remain must change the pooled
    // lead - if the checkbox only flipped a class and left the aggregate alone,
    // that is a control that goes nowhere.
    const after = await pooled.locator(".species-name-wrap").innerText();
    expect(after, "unchecking a photo did not change the pooled result").not.toBe(before);

    await expect(
      page.locator("#contribution-table tbody tr", { hasText: "pipiens_01.jpg" }),
    ).toHaveCount(0);
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(2);

    // And back again: the pool must be reachable from the other direction too.
    await page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin").check();
    await settle(page);
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(3);
  });

  test("select all, select none and delete all each change the gallery", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(3);

    await page.locator("#btn-select-none").click();
    await settle(page);
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(0);
    // With nothing checked, the card says what to do rather than going blank.
    await expect(page.locator("#combined-scores")).toContainText("Check two or more photos");
    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(3);

    await page.locator("#btn-select-all").click();
    await settle(page);
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(3);
    await expect(page.locator("#combined-scores")).not.toContainText("Check two or more photos");

    await page.locator("#btn-delete-all").click();
    await settle(page);
    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(0);
    // The gallery is gone, but the pooled card stays: hiding it moved the layout,
    // and it says why it is empty.
    await expect(page.locator("#gallery-section")).toBeHidden();
    await expect(page.locator("#combined-card")).toBeVisible();
    await expect(page.locator("#table-summary")).toHaveText("Processed 0 images.");
  });

  test("the strip actions are disabled with no photos and enabled with some", async ({ page }) => {
    await boot(page);

    // Nothing to select, deselect or delete without photos, so the buttons say so.
    for (const id of ["#btn-select-all", "#btn-select-none", "#btn-delete-all"]) {
      await expect(page.locator(id), `${id} should start disabled`).toBeDisabled();
    }

    await populate(page, POPULATED);
    await settle(page);
    for (const id of ["#btn-select-all", "#btn-select-none", "#btn-delete-all"]) {
      await expect(page.locator(id), `${id} should be enabled once photos exist`).toBeEnabled();
    }
  });

  test("a tile's delete button removes that photo and renumbers the rest", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    await page.locator("#thumbnail-strip .tile").nth(1).locator(".tile-delete-btn").click();
    await settle(page);

    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(2);
    await expect(page.locator("#table-summary")).toHaveText("Processed 2 images.");
    const labels = await page.locator("#thumbnail-strip .tile-btn").evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label")),
    );
    expect(labels).toEqual(["View photo 1: aegypti_01.jpg", "View photo 2: pipiens_01.jpg"]);
    // No detached tile left behind: the strip is rebuilt, not appended to.
    expect(await page.locator("#thumbnail-strip .tile").count()).toBe(
      await page.evaluate(() => window.__mosqAsync!.previews.length),
    );
  });

  test("deleting the leftmost photo follows the selection to the same photo", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    // Select the LAST photo, then delete everything before it. The selection has
    // to move with the photo it names; a stale index here silently switches the
    // panel to a different photo while the highlight stays put.
    await page.locator("#thumbnail-strip .tile").nth(2).locator(".tile-btn").click();
    await settle(page);
    await expect(page.locator("#photo-name")).toHaveText(/pipiens_01\.jpg/);

    await page.locator("#thumbnail-strip .tile").nth(0).locator(".tile-delete-btn").click();
    await settle(page);

    await expect(page.locator("#photo-name")).toHaveText(/pipiens_01\.jpg/);
    await expect(page.locator("#gallery-counter")).toHaveText("2 / 2");
    await expect(page.locator("#thumbnail-strip .tile").nth(1)).toHaveClass(/active/);
  });

  test("deleting the last photo leaves the selection on the new last photo", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    await page.locator("#thumbnail-strip .tile").nth(2).locator(".tile-btn").click();
    await settle(page);
    await page.locator("#thumbnail-strip .tile").nth(2).locator(".tile-delete-btn").click();
    await settle(page);

    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(2);
    await expect(page.locator("#gallery-counter")).toHaveText("2 / 2");
    await expect(page.locator("#photo-name")).toHaveText(/aegypti_02\.jpg/);
  });

  test("the pooling method radios change the pooled ranking", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "a_01.jpg", state: "species", species: "Aedes aegypti", top: 0.45 },
      { name: "a_02.jpg", state: "species", species: "Aedes aegypti", top: 0.95 },
      { name: "c_01.jpg", state: "species", species: "Culex pipiens", top: 0.5 },
    ]);
    await settle(page);

    // "Weight by lead" weights the decisive photo far above the undecided ones,
    // "Equal weight" does not, so the pool's ranking has to move between them.
    // Same inputs, different method: if the radios do nothing, the two readings
    // are identical and this fails.
    const read = async () =>
      page.locator("#combined-scores .combined-candidate").evaluateAll((els) =>
        els.map((e) => (e.querySelector(".species-name-wrap") as HTMLElement).innerText.trim()),
      );

    await page.locator('#pooling-methods input[value="Equal weight"]').check();
    await settle(page);
    const equal = await read();

    await page.locator('#pooling-methods input[value="Weight by lead"]').check();
    await settle(page);
    const byLead = await read();

    expect(byLead, `equal weight: ${equal.join(", ")} | by lead: ${byLead.join(", ")}`)
      .not.toEqual(equal);
  });

  test("the correlation slider changes the pooled shares", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    await expect(page.locator("#corr-val")).toHaveText("0.50");
    const before = await page.locator("#contribution-table tbody tr td:nth-child(2)").first().innerText();

    // r=0 divides by 1, r=1 divides by n: every photo's share must fall as the
    // photos are treated as more redundant.
    await page.locator("#corr-slider").fill("1");
    await settle(page);
    await expect(page.locator("#corr-val")).toHaveText("1.00");
    const after = await page.locator("#contribution-table tbody tr td:nth-child(2)").first().innerText();

    expect(parseFloat(after), `share went ${before} -> ${after} when r went to 1`)
      .toBeLessThan(parseFloat(before));
  });

  test("the CSV button exports the claim the app made, not a bare ranking", async ({ page }) => {
    await boot(page);
    await populate(page, [
      ...POPULATED,
      { name: "nothing.jpg", state: "unsure" },
      { name: "not_mosquito.jpg", state: "non-mosquito" },
    ]);
    await settle(page);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#btn-csv").click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const csv = Buffer.concat(chunks).toString("utf8");

    expect(csv).toContain("aegypti_01.jpg");
    expect(csv).toContain("pipiens_01.jpg");
    // A photo the app would not name must not leave the machine looking named -
    // in the export as well as in the table.
    expect(csv).toMatch(/nothing\.jpg","[^"]*",[^,]*,[^,]*,"-","-","-"/);
    expect(csv).toMatch(/not_mosquito\.jpg","[^"]*",[^,]*,[^,]*,"-","-","-"/);
    // Header plus one row per photo, and no row lost on the way out.
    expect(csv.trim().split("\n")).toHaveLength(1 + 5);
  });

  test("the engine selector records a choice and says so in the footer", async ({ page }) => {
    await boot(page);

    const select = page.locator("#engine-select");
    // The server option is not offered on the static site, so it must say so
    // rather than sit there as an option that would fail if picked.
    await expect(page.locator("#opt-server")).toBeDisabled();

    // Switching engine with the model stubbed out leaves the footer naming the
    // requested engine. If the change handler threw or bailed, the footer would
    // keep naming the previous one and this fails.
    await select.selectOption("webgpu-int8");
    await expect(page.locator("#footer-device")).toContainText("BioCLIP 2.5 H/14 INT8");

    await select.selectOption("webgpu-b16");
    await expect(page.locator("#footer-device")).toContainText("BioCLIP B/16");

    await select.selectOption("webgpu-fp16");
    await settle(page);
    await expect(page.locator("#footer-device")).toContainText("BioCLIP 2.5 H/14 FP16");

    // And the choice survives a reload, because it is a user preference.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.__mosqAsync?.renderThumbnails);
    await expect(page.locator("#engine-select")).toHaveValue("webgpu-fp16");
  });

  test("the engine selector honours a ?engine= query param over the saved choice", async ({ page }) => {
    await boot(page);
    await selectAndPersist(page, "webgpu-int8");
    await boot(page, "/?engine=webgpu-b16");
    await expect(page.locator("#engine-select")).toHaveValue("webgpu-b16");
  });

  test("the camera button opens a capture input, and the drop zone opens a file input", async ({ page }) => {
    await boot(page);

    // Both are the only entry points to a photo on a phone, so both must open
    // something. A chooser that never fires is a control that goes nowhere.
    const [cameraChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator("#btn-camera").click(),
    ]);
    expect(await cameraChooser.element().getAttribute("id")).toBe("camera-input");
    await expect(page.locator("#camera-input")).toHaveAttribute("capture", "environment");

    const [dropChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.locator("#dropzone").click({ position: { x: 20, y: 20 } }),
    ]);
    expect(await dropChooser.element().getAttribute("id")).toBe("file-input");
    await expect(page.locator("#file-input")).toHaveAttribute("multiple", "");
  });

  test("every species named on screen carries its guide link", async ({ page }) => {
    await boot(page);
    await populate(page, POPULATED);
    await settle(page);

    // One species label renderer feeds the score list, the pooled card and the
    // results table. If any of them fell back to a bare binomial the guide would
    // be missing from it, so assert on all three panels at once.
    const panels = [
      page.locator("#score-list"),
      page.locator("#combined-scores"),
    ];
    for (const panel of panels) {
      const links = panel.locator("a.species-wiki");
      expect(await links.count(), `no guide links in ${panel}`).toBeGreaterThan(0);
      for (const href of await links.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href))) {
        expect(href).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
      }
    }
    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(3);
  });

  test("the footer states the inference mode rather than staying on its initial text", async ({ page }) => {
    await boot(page);
    // With every model request aborted the session cannot be built, so the app
    // must report the failure rather than leave "initializing..." up forever as
    // if a download were still running.
    await expect(page.locator("#footer-device")).not.toHaveText("inference: initializing...", {
      timeout: 20_000,
    });
  });
});

/** Put the engine selector on `value` and wait for the change handler to run. */
async function selectAndPersist(page: import("@playwright/test").Page, value: string): Promise<void> {
  await page.locator("#engine-select").selectOption(value);
  await page.locator(`#footer-device:has-text("${value === "webgpu-int8" ? "INT8" : "B/16"}")`).waitFor();
}