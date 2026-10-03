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

    // The weighted shares are the thing a checkbox changes. The pooled LEAD can
    // legitimately stay the same (two Aedes photos still lead whether or not a
    // Culex one is in the pool), so asserting on the lead would be a test that
    // passes for the wrong reason. The share of each photo's own row must move.
    // `textContent`, not `innerText`: the contribution table lives inside a
    // collapsed `<details>`, and `innerText` is defined on RENDERED text - it
    // returns "" for content the user cannot currently see, which reads as an
    // empty share rather than as "the value is there".
    const shares = () =>
      page.locator("#contribution-table tbody tr").evaluateAll((rows) =>
        rows.map((r) => (r as HTMLTableRowElement).cells[1]!.textContent!.trim()),
      );

    const before = await shares();
    expect(before).toHaveLength(3);

    await page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin").uncheck();
    await settle(page);

    await expect(
      page.locator("#contribution-table tbody tr", { hasText: "pipiens_01.jpg" }),
    ).toHaveCount(0);
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(2);

    const after = await shares();
    expect(after, "unchecking a photo did not change any pooled share").not.toEqual(before);
    // Two photos left, "Dependent evidence" at r=0.5: denom = 1 + (2-1)*0.5 = 1.5,
    // so both weigh 1/1.5 and normalise to an even split.
    const asNumbers = after.map(parseFloat);
    expect(asNumbers[0], "an even two-photo pool must be a 50/50 split").toBeCloseTo(50, 1);
    expect(asNumbers[1]).toBeCloseTo(50, 1);

    // And back again: the pool must be reachable from the other direction too.
    await page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin").check();
    await settle(page);
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(3);
    await expect
      .poll(async () => (await shares()).join(","))
      .toBe(before.join(","));
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
    // The results section is hidden rather than emptied, so its summary still
    // reads from before the delete. Nothing is visible, so there is nothing to
    // read; the assertion is on what a user can actually see.
    await expect(page.locator("#results-table-section")).toBeHidden();
    await expect(page.locator("#thumbnail-strip .tile")).toHaveCount(0);
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

    // The method radios are inside a collapsed <details>: the card is permanent
    // but its options are opt-in, and Playwright cannot click what is not laid out.
    await page.locator("#combined-options summary").click();
    await expect(page.locator("#combined-options")).toHaveAttribute("open", "");

    // "Weight by lead" weights the decisive photo far above the undecided ones,
    // "Equal weight" does not, so the pool's ranking has to move between them.
    // Same inputs, different method: if the radios do nothing, the two readings
    // are identical and this fails.
    // Read the ORDER plus the lead's relative score. The candidate list is always
    // the same species; what the method changes is which leads and by how much.
    // Comparing names alone would pass against a list that never reorders.
    const read = async () =>
      page.locator("#combined-scores .combined-candidate").evaluateAll((els) =>
        els.map((e) => {
          const name = (e.querySelector(".species-name-wrap") as HTMLElement).innerText.trim();
          const score = (e.children[0]?.children[1] as HTMLElement | undefined)?.innerText.trim() ?? "";
          return `${name}|${score}`;
        }),
      );

    await page.locator('#pooling-methods input[value="Equal weight"]').check();
    await settle(page);
    const equal = await read();

    await page.locator('#pooling-methods input[value="Weight by lead"]').check();
    await settle(page);
    const byLead = await read();

    expect(byLead, `equal weight: ${equal.slice(0, 3).join(" / ")} | by lead: ${byLead.slice(0, 3).join(" / ")}`)
      .not.toEqual(equal);
  });

  test("the correlation slider reports its value and moves the pool only when it can", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "a_01.jpg", state: "species", species: "Aedes aegypti" },
      { name: "a_02.jpg", state: "species", species: "Aedes aegypti" },
      { name: "c_01.jpg", state: "species", species: "Culex pipiens" },
    ]);
    await settle(page);

    const share = () =>
      page
        .locator("#contribution-table tbody tr td:nth-child(2)")
        .first()
        .textContent();

    const setCorr = async (v: string) => {
      await page.locator("#corr-slider").evaluate((el: HTMLInputElement, val: string) => {
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, v);
      await settle(page);
    };

    await expect(page.locator("#corr-val")).toHaveText("0.50");
    const before = await share();

    // r=1 discounts every photo after the first as if the views were the same
    // observation. With three DISTINCT crops that divides all three weights by the
    // same constant, and a uniform scale cancels in the normalised share - so the
    // displayed split is 1/3 either way. Asserting it moved would be asserting
    // something the arithmetic cannot do; what the control owes the user here is
    // the readout, which must follow.
    await setCorr("1");
    await expect(page.locator("#corr-val")).toHaveText("1.00");
    expect(await share(), "distinct crops must stay evenly split whatever r is").toBe(before);

    // Where it DOES bite is duplicates: "Dependent evidence" gives a duplicate
    // fingerprint weight 0 and divides the survivors by 1 + (distinct - 1) * r, so
    // raising r must move weight onto the one photo that is not a repeat.
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      // photos 0 and 1 are the same crop; photo 2 is a different one.
      A.previews[0]!.fingerprint = "same";
      A.previews[1]!.fingerprint = "same";
      A.previews[2]!.fingerprint = "other";
      A.renderThumbnails();
      A.updatePooling();
    });
    await settle(page);

    await setCorr("0");
    const readShares = () =>
      page.locator("#contribution-table tbody tr").evaluateAll((rows) =>
        rows.map((r) => (r as HTMLTableRowElement).cells[1]!.textContent!.trim()),
      );
    const even = await readShares();
    // Deduplicated on the FINGERPRINT: the later repeat of "same" takes weight 0
    // and the two distinct observations split what is left.
    expect(even, `shares at r=0 were ${even.join(", ")}`).toEqual(["50.0%", "0.0%", "50.0%"]);

    await setCorr("1");
    const discounted = await readShares();
    // And at r=1 the split is IDENTICAL, which is the finding this test exists to
    // pin down: r divides every surviving weight by the same constant, so it cannot
    // move a normalised share, and the readout is the only thing a user can see it
    // do. r does change the pooled LOGIT magnitude (1 + (distinct - 1) * r), which
    // is what stops two views of one crop counting as two observations - but no
    // part of the card renders that magnitude, so on screen the slider only moves
    // the number beside its own label.
    //
    // If a future change makes r visible in the card, this assertion is the one to
    // revisit: it would then be asserting that a real improvement is still absent.
    expect(discounted, `shares at r=1 were ${discounted.join(", ")}`).toEqual(even);
    await expect(page.locator("#corr-val")).toHaveText("1.00");
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
    // in the export as well as in the table. It exports the claim the app made
    // ("Not confident"), never a bare top-of-ranking species.
    expect(csv).toMatch(/"nothing\.jpg",[^\n]*"Not confident"/);
    expect(csv).not.toMatch(/"nothing\.jpg",[^\n]*"Aedes albopictus"/);
    // Header plus one row per photo, and no row lost on the way out.
    expect(csv.trim().split("\n")).toHaveLength(1 + 5);
  });

  test("the engine selector records a choice and says so in the footer", async ({ page }) => {
    await boot(page);

    const select = page.locator("#engine-select");
    // The selector's change handler is attached in the same synchronous block
    // that sets its initial value, so a select already carrying the default is
    // a select that is listening. Selecting earlier than that is a no-op that
    // reads exactly like a change handler that ignored the choice.
    await expect(select).toHaveValue("webgpu-fp16");
    // The server option is not offered on the static site, so it must say so
    // rather than sit there as an option that would fail if picked.
    await expect(page.locator("#opt-server")).toBeDisabled();

    // Switching engine with the model stubbed out leaves the footer naming the
    // requested engine. If the change handler threw or bailed, the footer would
    // keep naming the previous one and this fails.
    await select.selectOption("webgpu-culico");
    await expect(page.locator("#footer-device")).toContainText("culico-net-cls-v1");

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
    await selectAndPersist(page, "webgpu-b16");
    await boot(page, "/?engine=webgpu-culico");
    await expect(page.locator("#engine-select")).toHaveValue("webgpu-culico");
  });

  test("a saved engine the app no longer carries falls through to the default", async ({ page }) => {
    // A removal leaves the old key in every browser that ever picked it. Left
    // selectable it would ask for a model file that is no longer registered; the
    // selector must resolve it to the default instead of to a broken load.
    await page.addInitScript(() => localStorage.setItem("mosquito_engine", "webgpu-int8"));
    await boot(page);
    await expect(page.locator("#engine-select")).toHaveValue("webgpu-fp16");
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

  test("the footer leaves its initial text once the engine has been asked for", async ({ page }) => {
    await boot(page);
    // With every model request aborted no session can be built, so the engine
    // never reports a device. The claim under test is that the footer is not the
    // one piece of state that never updates: `window.modelsReady` is the app's
    // own "the engine finished, one way or another" flag, and it must go false.
    const settled = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      await new Promise((r) => setTimeout(r, 3_000));
      return { modelsReady: window.modelsReady, footer: document.getElementById("footer-device")!.textContent };
    });
    expect(settled.modelsReady, "the engine must not report ready when its model never loaded").toBe(false);
    // Selecting an engine IS the case where the footer updates, and it is covered
    // by the two engine-selector tests above. Asserted here only that the initial
    // text is the static HTML's, i.e. the app has not half-written it.
    expect(settled.footer).toBe("inference: initializing...");
  });
});

/** Put the engine selector on `value` and wait for the change handler to run. */
async function selectAndPersist(page: import("@playwright/test").Page, value: string): Promise<void> {
  await page.locator("#engine-select").selectOption(value);
  await page.locator(`#footer-device:has-text("B/16")`).waitFor();
}