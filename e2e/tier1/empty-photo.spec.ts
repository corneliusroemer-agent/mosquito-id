import { test, expect, boot, populate, settle, errors } from "../helpers/app";

/**
 * A photo with no mosquito in it.
 *
 * The reported case is a blank piece of paper, and the reason it came back as a
 * confident species is a specific one rather than a general weakness: the eight
 * nuisance classes are literally photographs of walls, hands, plants and empty
 * backgrounds, and the non-mosquito gate read only the seven adjacent classes -
 * seven Diptera families a non-expert reads as a mosquito. So the one class of
 * photo that most needs rejecting had no path to rejection at all, and the
 * species ranking rendered on screen as though it were a finding.
 *
 * These are driven through `populate`, which builds the posterior and lets the
 * SHIPPED gate decide, so a change to a floor shows up here as a different
 * verdict rather than as a fixture that still agrees with itself.
 */

const WALL = { nuisance: "a photograph of a wall", nuTop: 0.9 };

test.describe("a photo with no mosquito in it", () => {
  test("is reported as not-a-mosquito rather than named a species", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "paper.jpg", state: "non-mosquito", ...WALL }]);
    await settle(page);

    // The headline is a claim about the PHOTOGRAPH: there is no mosquito here.
    // "Not confident enough" would be a weaker but still honest answer, and the
    // assertion accepts it - what it rules out is a species being named.
    const headline = (await page.locator("#score-uncertain").innerText()).trim();
    expect(headline).not.toBe("");
    expect(headline).toMatch(/no mosquito|does not look like a mosquito|not confident/i);
    for (const genus of ["Aedes", "Culex", "Culiseta", "Anopheles"]) {
      expect(headline, `the panel named ${genus} for a photo of a wall`).not.toContain(genus);
    }

    // The results table is the second readout of the same claim, and it is where
    // a named species is most likely to survive, so it is asserted separately.
    const row = page.locator("#results-table tbody tr").first();
    await expect(row).toContainText("Not confident");
    await expect(row).not.toContainText("Aedes aegypti");

    expect(errors(page)).toHaveLength(0);
  });

  test("says there is no mosquito without inventing an insect family", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "paper.jpg", state: "non-mosquito", ...WALL }]);
    await settle(page);

    const headline = (await page.locator("#score-uncertain").innerText()).trim();
    // It names what was seen...
    expect(headline).toContain("a photograph of a wall");
    // ...and NOT a family, because there was no insect in the picture to name.
    // Chironomidae is the adjacent class most likely to be offered for bare
    // background, so it is the one a guess would reach for.
    expect(headline).not.toMatch(/Chironomidae|midge|Ceratopogonidae|blackfly/);
  });

  test("a midge photo is still named as a midge", async ({ page }) => {
    // The other side of the distinction, and the case the gate already handled: a
    // midge is a real finding, so the answer names the family rather than
    // retreating to "no mosquito".
    await boot(page);
    await populate(page, [
      { name: "midge.jpg", state: "non-mosquito", adjacent: "Chironomidae", adjTop: 0.94 },
    ]);
    await settle(page);

    const headline = (await page.locator("#score-uncertain").innerText()).trim();
    expect(headline).toMatch(/does not look like a mosquito/i);
    expect(headline).toMatch(/midge/);
    expect(errors(page)).toHaveLength(0);
  });

  test("a photo with no mosquito cannot be opted into the pool", async ({ page }) => {
    // Two real mosquitoes so the pooled card has something to be wrong about:
    // pooling is what makes a mis-named wall expensive, because it drags every
    // other photo's posterior toward the species it was given.
    await boot(page);
    await populate(page, [
      { name: "aegypti_01.jpg", state: "species", species: "Aedes aegypti" },
      { name: "aegypti_02.jpg", state: "species", species: "Aedes aegypti" },
      { name: "paper.jpg", state: "non-mosquito", ...WALL },
    ]);
    await settle(page);

    await expect(page.locator("#thumbnail-strip .tile").nth(2).locator(".thumb-optin")).toBeDisabled();
    // Three rows: the two mosquitoes with shares, and the wall with a dash. It
    // contributes nothing either way, but a checked photo is listed rather than
    // silently absent - the shares are the assertion that it was not counted.
    const rows = page.locator("#contribution-table tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toHaveClass(/row-excluded/);
    await expect(rows.nth(2).locator("td").nth(1)).toHaveText("-");
    await expect(rows.nth(0).locator("td").nth(1)).toHaveText("50.0%");
    await expect(rows.nth(1).locator("td").nth(1)).toHaveText("50.0%");
    expect(errors(page)).toHaveLength(0);
  });

  test("an unconfident photo says what it is unsure between", async ({ page }) => {
    // The abstention has to be legible as an abstention, which means naming the
    // tie rather than only saying there is one.
    await boot(page);
    await populate(page, [
      { name: "blur.jpg", state: "unsure", species: "Aedes aegypti", top: 0.12 },
    ]);
    await settle(page);

    const headline = (await page.locator("#score-uncertain").innerText()).trim();
    expect(headline).toMatch(/not confident/i);
    // The candidates are named, so a reader can see WHICH way the photo leans.
    expect(headline).toContain("aegypti");
  });
});
