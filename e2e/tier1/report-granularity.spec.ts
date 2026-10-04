import { test, expect, boot, populate, errors } from "../helpers/app";

/**
 * What the app is allowed to NAME, on a head that cannot name it.
 *
 * culico's head DID give three of its sixteen species one weight row each - Aedes
 * vexans/geniculatus/cinereus, the whole of Culex, three Culiseta, three
 * Anopheles. Within a set the two logits are the same number, so the two
 * posteriors are the same number and the tie breaks on list order: `Aedes vexans`
 * was observed winning essentially every Aedes tie and the app printed that as an
 * identification.
 *
 * That head was refitted on 2026-10-04 and every species now has its own row, so
 * no shipped head has a group any more and the machinery below has nothing in
 * `public/` to exercise it on. `text_embeds_grouped-fixture.json` is the same
 * sixteen labels in the same four collapsed groups, built for this; the last
 * describe block asserts the refitted culico really does name all sixteen.
 *
 * These assertions are on the RENDERED TEXT, in all three places a species name
 * reaches the user - the sentence above the ranking, the ranking itself, and the
 * results table. A name is the defect; no intermediate value ever held one.
 *
 * The head is swapped through `populate`'s `embeds` option rather than by
 * selecting the engine: tier 1 aborts every `.onnx`, so selecting culico would
 * never load a model and the classifier's output could not be shaped. What is
 * under test is what the app does with a head and a posterior, and the head is
 * the part that has to change.
 *
 * Spec: docs/REPORT-GRANULARITY-SPEC.md.
 */

const CULICO = { embeds: "text_embeds_culico.json" } as const;
/** A head with four collapsed groups of three, as culico's used to be. */
const GROUPED = { embeds: "text_embeds_grouped-fixture.json" } as const;

/** Every binomial a four-group head cannot separate. */
const UNSEPARABLE = [
  "Aedes vexans", "Aedes geniculatus", "Aedes cinereus",
  "Culex pipiens", "Culex torrentium", "Culex quinquefasciatus",
  "Culiseta annulata", "Culiseta morsitans", "Culiseta longiareolata",
  "Anopheles maculipennis", "Anopheles claviger", "Anopheles plumbeus",
];

test.describe("a head that cannot separate species", () => {
  test("a confident posterior on an unseparable species prints the genus, not the species", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "aedes.jpg", state: "species", species: "Aedes vexans", top: 0.9 }], GROUPED);

    // The photo's own claim, above the ranking.
    const sentence = page.locator("#score-uncertain");
    // The exact wording, not a substring: one format, so a reader who has seen
    // one of these knows what every other one means.
    await expect(sentence).toHaveText("Aedes (vexans / geniculatus / cinereus not separable)");
    // The bare binomial is the claim the head cannot support.
    await expect(sentence).not.toContainText("Aedes vexans");

    expect(errors(page)).toEqual([]);
  });

  test("the score list shows one row per class, and no member is named alone", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "aedes.jpg", state: "species", species: "Aedes vexans", top: 0.9 }], GROUPED);

    const rows = page.locator("#score-list .score-item");
    // 16 species: four singletons the head separates, plus the four sets of
    // three it does not, which are four classes between them. 8 rows.
    await expect(rows).toHaveCount(8);
    const text = await rows.allInnerTexts();
    for (const binomial of UNSEPARABLE) {
      expect(text.join("\n"), `${binomial} must not be named on its own row`).not.toContain(binomial);
    }
    expect(text.join("\n")).toContain("Culex (pipiens / torrentium / quinquefasciatus not separable)");

    expect(errors(page)).toEqual([]);
  });

  test("the results table and the CSV carry the same coarser claim", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "aedes.jpg", state: "species", species: "Aedes vexans", top: 0.9 }], GROUPED);

    const row = page.locator("#results-table tbody tr").first();
    await expect(row).toContainText("not separable");
    await expect(row).not.toContainText("Aedes vexans");

    const csv = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const realCreate = URL.createObjectURL;
      let blob: Blob | null = null;
      (URL as any).createObjectURL = (b: Blob) => {
        blob = b;
        return realCreate.call(URL, b);
      };
      try {
        A.downloadCSV();
      } finally {
        (URL as any).createObjectURL = realCreate;
      }
      if (!blob) throw new Error("the export never reached createObjectURL");
      return await (blob as unknown as Blob).text();
    });
    expect(csv).toContain("not separable");
    expect(csv).not.toContain("Aedes vexans");

    expect(errors(page)).toEqual([]);
  });

  test("a species the head CAN separate is still named", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "albopictus.jpg", state: "species", species: "Aedes albopictus", top: 0.9 }], GROUPED);

    // Its row is a binomial, with the guide link and the common name, exactly as
    // on a head that separates every row.
    const top = page.locator("#score-list .score-item").first();
    await expect(top).toContainText("Aedes albopictus");
    await expect(top).toContainText("Asian tiger mosquito");
    await expect(top).not.toContainText("not separable");
    // The rest of the list still collapses: this is a property of the head, not
    // of the photo.
    await expect(page.locator("#score-list .score-item")).toHaveCount(8);

    expect(errors(page)).toEqual([]);
  });
});

test.describe("a head that separates every species", () => {
  test("names the species, exactly as before", async ({ page }) => {
    await boot(page);
    await populate(page, [{ name: "vexans.jpg", state: "species", species: "Aedes vexans", top: 0.9 }]);

    await expect(page.locator("#score-list .score-item")).toHaveCount(16);
    await expect(page.locator("#score-list .score-item").first()).toContainText("Aedes vexans");
    const all = await page.locator("#score-list").innerText();
    expect(all).not.toContain("not separable");
    await expect(page.locator("#results-table tbody tr").first()).toContainText("Aedes vexans");

    expect(errors(page)).toEqual([]);
  });

  test("and that is culico's own head now, not a hypothetical", async ({ page }) => {
    // The 2026-10-04 refit gave all sixteen rows their own coefficients. Every
    // row of the ranking is a binomial again, and the phrase is gone from every
    // place the app prints a name.
    await boot(page);
    await populate(page, [{ name: "vexans.jpg", state: "species", species: "Aedes vexans", top: 0.9 }], CULICO);

    await expect(page.locator("#score-list .score-item")).toHaveCount(16);
    await expect(page.locator("#score-list .score-item").first()).toContainText("Aedes vexans");
    const all = await page.locator("#score-list").innerText();
    expect(all).not.toContain("not separable");

    expect(errors(page)).toEqual([]);
  });
});

test.describe("the engine dropdown", () => {
  test("says what an engine reports, before it is chosen, and in the dropdown", async ({ page }) => {
    await boot(page);
    const options = page.locator("#engine-select");
    // culico's head was refitted and separates all sixteen species, so no engine
    // reports genus only any more. The note is still wired: `capabilityNote` is
    // what renders it, and a head that gains a group puts it back.
    await expect(options.locator("option[value=webgpu-culico]")).not.toContainText("genus only");
    await expect(options.locator("option[value=webgpu-fp16]")).not.toContainText("genus only");
    // The existing labelling is untouched, and no caveat block has crept back in
    // above the content - it moved the page (0.27 CLS) and was rejected twice.
    await expect(options.locator("option[value=webgpu-culico]")).toContainText("experimental");
    await expect(page.locator("#engine-caveat")).toHaveCount(0);
  });
});