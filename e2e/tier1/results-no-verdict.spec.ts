import { boot, errors, expect, populate, test } from "../helpers/app";

test("a photo with no verdict is shown as having none in the results table", async ({ page }) => {
  await boot(page);
  await populate(page, [{ name: "aegypti.jpg", state: "species", species: "Aedes aegypti" }]);
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    A.previews[0]!.verdict = null;
    A.renderResultsTable();
  });
  const row = page.locator("#results-table tbody tr").first();
  await expect(row).toContainText("No verdict");
  await expect(row).not.toContainText("Aedes aegypti");
  expect(errors(page)).toHaveLength(0);
});
