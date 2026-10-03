import { test, expect, boot, populate, settle, errors } from "../helpers/app";

/**
 * The non-mosquito path.
 *
 * This matters disproportionately: the fusion step pools a photo's evidence, so
 * a photograph of paper that reads as a confident mosquito does not just get one
 * wrong row in a table - it drags every other photo in the pool toward that
 * species. The pooled card is the place that had the bug, and it is covered here
 * even though Tier 2 is what would catch a model-side regression: this covers the
 * ARITHMETIC on real shipped embeddings, which is the part with no coverage.
 */

const ONE_MOSQUITO = { name: "aegypti_01.jpg", state: "species" as const, species: "Aedes aegypti" };

test.describe("non-mosquito", () => {
  test("a non-mosquito photo is not named as a mosquito in the score panel", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.94 },
    ]);
    await settle(page);

    // The claim is about the subject, not about the app's failure to classify.
    await expect(page.locator("#score-uncertain")).toContainText("does not look like a mosquito");
    await expect(page.locator("#score-uncertain")).toContainText("midge");

    // The ranking of species it is NOT is suppressed - a sixteen-row list of
    // mosquitoes this photo is not is the readout that made a photograph of
    // paper come back as a confident mosquito.
    // The app HIDES the species rows rather than removing them (the scores stay in
    // p.detail for the pooling maths), so the assertion is on visibility, not on
    // a count of zero - a count assertion would pass against an empty list for the
    // wrong reason.
    const visible = page.locator("#score-list .score-item:not(.is-not-mosquito)");
    expect(await visible.count(), "the species ranking must still be in the DOM").toBe(16);
    await expect(visible.first()).toBeHidden();
    // The winning non-mosquito class IS shown, so the answer names what it saw.
    await expect(page.locator("#score-list .score-item.is-not-mosquito")).toHaveCount(1);
    await expect(page.locator("#score-list .score-item.is-not-mosquito")).toContainText("Chironomidae");
  });

  test("a non-mosquito photo cannot be opted into the pool", async ({ page }) => {
    await boot(page);
    // Two poolable mosquitoes so the card has a pool at all: `updatePooling` shows
    // nothing below two contributors, and a card with nothing in it cannot show
    // that the midge was held out of it.
    await populate(page, [
      ONE_MOSQUITO,
      { name: "aegypti_02.jpg", state: "species", species: "Aedes aegypti" },
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.94 },
    ]);
    await settle(page);

    // It is a finished, valid photo with a verdict - it just has nothing to say
    // about a mosquito, so pooling it would fold a midge's evidence into a
    // mosquito's posterior.
    // Tile 2 is the midge: the two Aedes photos come first.
    const chk = page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin");
    await expect(chk).toBeDisabled();

    // And forced into the pool anyway, it contributes nothing and is named as
    // excluded rather than silently dropped.
    // Forced into the pool anyway, to check the arithmetic rather than the UI
    // guard: the midge must contribute no weight and be listed as excluded rather
    // than silently dropped.
    await page.evaluate(() => {
      window.__mosqAsync!.includedIndices.add(2);
      window.__mosqAsync!.renderThumbnails();
      window.__mosqAsync!.updatePooling();
    });
    await settle(page);

    // The two mosquitoes pool. `splitPoolable` files an `unsure` photo under
    // `abstained` and renders a row for it; a non-mosquito photo is in NEITHER
    // list, so it carries no row and contributes no weight - the assertion is on
    // the two survivors' shares, which must be the 50/50 split of a two-photo pool.
    const rows = page.locator("#contribution-table tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#contribution-table tbody tr.row-excluded")).toHaveCount(0);
    await expect
      .poll(async () =>
        rows.evaluateAll((r) => r.map((x) => ((x as HTMLTableRowElement).cells[1] as HTMLElement).innerText.trim())),
      )
      .toEqual(["50.0%", "50.0%"]);
  });

  test("a pool of three non-mosquito photos never names a species", async ({ page }) => {
    await boot(page);
    // The pooled-card bug: three photos each reading 97% biting midge were
    // announced as a species, because `pooledPosterior` softmaxes over the
    // species alone so the adjacent mass was in neither numerator nor denominator
    // and the species posteriors summed to 1 as if nothing else existed.
    await populate(page, [
      { name: "midge_01.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.97 },
      { name: "midge_02.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.97 },
      { name: "midge_03.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.97 },
    ]);
    await settle(page);

    // With every photo excluded, there is no pool to report - and the card says
    // so rather than naming a species. This is the assertion the bug would break:
    // before the fix, `pooledPosterior` softmaxed over the 16 species alone, the
    // adjacent mass was in neither numerator nor denominator, and these three
    // 97% biting midges were announced as a species.
    await expect(page.locator("#combined-scores")).toContainText("Check two or more photos");
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(0);
    const pooled = (await page.locator("#combined-scores").innerText()).trim();
    for (const genus of ["Aedes", "Culex", "Culiseta", "Anopheles"]) {
      expect(pooled, `the pooled card named ${genus} from three non-mosquito photos`).not.toContain(genus);
    }
    expect(errors(page)).toHaveLength(0);
  });

  test("the results table says not-confident rather than naming a species", async ({ page }) => {
    await boot(page);
    await populate(page, [
      ONE_MOSQUITO,
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.94 },
    ]);
    await settle(page);

    const rows = page.locator("#results-table tbody tr");
    await expect(rows).toHaveCount(2);
    // Row 0 is the mosquito and is named; row 1 must not be.
    await expect(rows.nth(0)).toContainText("Aedes aegypti");
    await expect(rows.nth(1)).toContainText("Not confident");
    await expect(rows.nth(1)).not.toContainText("Aedes aegypti");
  });

  test("a non-mosquito photo mixed into a real pool does not dilute it", async ({ page }) => {
    await boot(page);
    await populate(page, [
      { name: "a_01.jpg", state: "species", species: "Aedes aegypti", top: 0.8 },
      { name: "a_02.jpg", state: "species", species: "Aedes aegypti", top: 0.8 },
      { name: "a_03.jpg", state: "species", species: "Aedes aegypti", top: 0.8 },
      // A non-mosquito carrying its own high-confidence species score, which is
      // what a midge photo looks like to the classifier: strongly one thing, and
      // not a mosquito.
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.96 },
    ]);
    await settle(page);

    // The two real photos pool; the midge contributes nothing.
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(3);
    await expect(page.locator("#contribution-table tbody tr.row-excluded")).toHaveCount(1);
    // The pool still answers about a mosquito, and the midge has not dragged it.
    await expect(page.locator("#combined-scores")).not.toContainText("does not look like a mosquito");
    await expect(page.locator("#combined-scores")).toContainText("Aedes aegypti");
  });

  test("an unsure photo is excluded from the pool with its reason stated", async ({ page }) => {
    await boot(page);
    await populate(page, [
      ONE_MOSQUITO,
      { name: "aegypti_02.jpg", state: "species", species: "Aedes aegypti" },
      { name: "blur.jpg", state: "unsure", species: "Aedes albopictus" },
    ]);
    await settle(page);

    // Two mosquitoes pool into the aggregate; the unsure photo is listed BELOW
    // them with its reason, rather than folded in. So three rows: two with a
    // share, one without.
    const rows = page.locator("#contribution-table tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("aegypti_01.jpg");
    await expect(rows.nth(1)).toContainText("aegypti_02.jpg");
    await expect(rows.nth(2)).toContainText("blur.jpg");
    await expect(rows.nth(2)).toContainText("not confident enough to name a genus");
    await expect(rows.nth(2)).toHaveClass(/row-excluded/);
    // Only the two named photos carry a share.
    await expect(rows.nth(0).locator("td").nth(1)).toHaveText("50.0%");
    await expect(rows.nth(1).locator("td").nth(1)).toHaveText("50.0%");
    // It is still selectable - it is a valid photo, just not a decidable one.
    await expect(page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin")).toBeEnabled();
    await expect(page.locator("#score-uncertain")).toContainText("Not confident enough to name a genus");
  });

  test("one photo alone is not pooled into a claim", async ({ page }) => {
    await boot(page);
    // The card needs two or more: pooling is for gathering more evidence for a
    // claim, and a single photo's own verdict is already on its tile.
    await populate(page, [ONE_MOSQUITO]);
    await settle(page);
    await expect(page.locator("#combined-scores")).toContainText("Check two or more photos");
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(0);
  });
});