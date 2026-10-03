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
    const visible = page.locator("#score-list .score-item:not(.is-not-mosquito)");
    await expect(visible).toHaveCount(0);
    // The winning non-mosquito class IS shown, so the answer names what it saw.
    await expect(page.locator("#score-list .score-item.is-not-mosquito")).toHaveCount(1);
    await expect(page.locator("#score-list .score-item.is-not-mosquito")).toContainText("Chironomidae");
  });

  test("a non-mosquito photo cannot be opted into the pool", async ({ page }) => {
    await boot(page);
    await populate(page, [
      ONE_MOSQUITO,
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.94 },
    ]);
    await settle(page);

    // It is a finished, valid photo with a verdict - it just has nothing to say
    // about a mosquito, so pooling it would fold a midge's evidence into a
    // mosquito's posterior.
    const chk = page.locator("#thumbnail-strip .tile").nth(1).locator(".thumb-optin");
    await expect(chk).toBeDisabled();

    // And forced into the pool anyway, it contributes nothing and is named as
    // excluded rather than silently dropped.
    await page.evaluate(() => window.__mosqAsync!.includedIndices.add(1));
    await page.evaluate(() => {
      window.__mosqAsync!.renderThumbnails();
      window.__mosqAsync!.updatePooling();
    });
    await settle(page);

    const rows = page.locator("#contribution-table tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toHaveClass(/row-excluded/);
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

    await expect(page.locator("#combined-scores")).toContainText("does not look like a mosquito");
    await expect(page.locator("#combined-scores")).toContainText("midge");
    // Not one of the sixteen species may be named anywhere in the pooled card.
    await expect(page.locator("#combined-scores")).not.toContainText("Aedes");
    await expect(page.locator("#combined-scores")).not.toContainText("Culex");
    await expect(page.locator("#combined-scores")).not.toContainText("Culiseta");
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
      // A non-mosquito carrying its own high-confidence species score, which is
      // what a midge photo looks like to the classifier: strongly one thing, and
      // not a mosquito.
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.96 },
    ]);
    await settle(page);

    // The two real photos pool; the midge contributes nothing.
    await expect(page.locator("#contribution-table tbody tr")).toHaveCount(2);
    await expect(page.locator("#contribution-table tbody tr.row-excluded")).toHaveCount(1);
    // The pool still answers about a mosquito, and the midge has not dragged it.
    await expect(page.locator("#combined-scores")).not.toContainText("does not look like a mosquito");
    await expect(page.locator("#combined-scores")).toContainText("Aedes aegypti");
  });

  test("an unsure photo is excluded from the pool with its reason stated", async ({ page }) => {
    await boot(page);
    await populate(page, [
      ONE_MOSQUITO,
      { name: "blur.jpg", state: "unsure", species: "Aedes albopictus" },
    ]);
    await settle(page);

    const rows = page.locator("#contribution-table tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("not confident enough to name a genus");
    // It is still selectable - it is a valid photo, just not a decidable one.
    await expect(page.locator("#thumbnail-strip .tile").nth(1).locator(".thumb-optin")).toBeEnabled();
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