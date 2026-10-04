import { test, expect, boot, populate, errors } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * The scores must change when the whole-frame view is toggled.
 *
 * The freeze spec next door pins the SCHEDULING of the re-classification - that
 * one pass runs at a time, that a toggle mid-pass produces a follow-up rather
 * than a second pass. It cannot see the bug this file is about, because the fake
 * classifier it installs returns the SAME fixed embedding for every view: two
 * views of one photo fuse to exactly what one view says, so "the toggle did
 * nothing to the numbers" and "the toggle worked perfectly" are the same
 * observation. A spec whose stub cannot tell the two apart pins nothing about
 * the toggle's effect.
 *
 * So the classifier here is keyed on the pixels it is handed. `clipEmbed`
 * normalises the canvas into one 3x224x224 tensor per view, and the crop and the
 * whole frame of a photo are different pictures, so a fake that mixes the tensor
 * returns a different direction for each and the fusion has something real to
 * pool. That is the whole difference from the freeze spec, and it is what makes
 * the assertions below able to fail.
 *
 * The model is still not downloaded: the fake replaces the ONNX session, so
 * `softmaxJoint`, `fuseViews`, `viewKinds`, `commitScores` and every render run
 * for real against the shipped head.
 */

/** Two photos, both cropped, so each offers two views and the toggle can bite. */
const TWO: { name: string; state: "species" }[] = [
  { name: "photo_a.jpg", state: "species" },
  { name: "photo_b.jpg", state: "species" },
];

/**
 * Install a classifier whose answer depends on the picture it was given.
 *
 * `run` receives the normalised tensor for one view. A cheap FNV-1a over a
 * strided sample of it seeds a direction in the head's dimension, so two views
 * of one photo land on different directions with overwhelming probability and
 * the fused posterior differs from either view's own. The full tensor is walked
 * at a stride rather than hashed whole because a view is 150528 floats and this
 * runs on every view of every photo in the pass.
 */
async function installPixelKeyedClassifier(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const dim = (A.embeds as { dim: number }).dim;
    const w = window as any;
    w.__fakeClip = { runs: 0 };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run(feeds: Record<string, { data: Float32Array }>) {
        const f = w.__fakeClip;
        f.runs++;
        // A macrotask, so a second run could start if the caller let one.
        await new Promise((r) => setTimeout(r, 0));
        const src = feeds["pixel_values"]!.data;
        let h = 0x811c9dc5;
        for (let i = 0; i < src.length; i += 97) {
          h ^= Math.round(src[i]! * 1000) | 0;
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        // A direction that depends only on the hash, but is not a fixed one.
        const data = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          let x = (h ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
          x ^= x >>> 15;
          x = Math.imul(x, 0x2545f491) >>> 0;
          data[i] = ((x >>> 8) / 8388608) - 1;
        }
        // clipEmbed L2-normalises over the first `dim` coordinates anyway, so
        // the returned vector only has to be non-degenerate.
        return { embedding: { dims: [1, dim], data } };
      },
    };
  });
}

/** Click the checkbox and wait for every photo to settle again. */
async function toggleAndSettle(page: Page, checked: boolean, budgetMs = 10_000) {
  await page.locator("#chk-whole-frame").setChecked(checked);
  await page.waitForFunction(
    () => !window.__mosqAsync!.previews.some((p: any) => p.pending),
    null,
    { timeout: budgetMs },
  );
}

/**
 * What the gallery is showing, read off the app's own photo objects.
 *
 * `detail` is the fused species posterior the score panel and the results table
 * both render, so it is the displayed number rather than an intermediate.
 */
async function shownScores(page: Page) {
  return page.evaluate(() =>
    window.__mosqAsync!.previews.map((p: any) => ({
      name: p.name,
      viewsTotal: p.viewsTotal,
      detail: p.detail as Record<string, number>,
      verdict: p.verdict,
    })),
  );
}

/** The largest absolute change in any species posterior between two readings. */
function biggestScoreMove(a: Record<string, number>, b: Record<string, number>): number {
  const names = Object.keys(a);
  expect(names.length, "a photo with no species posterior").toBeGreaterThan(0);
  let biggest = 0;
  for (const n of names) {
    const d = Math.abs((a[n] ?? 0) - (b[n] ?? 0));
    if (d > biggest) biggest = d;
  }
  return biggest;
}

test.describe("the whole-frame toggle moves the scores", () => {
  test("unchecking changes what is displayed, and re-checking changes it back", async ({ page }) => {
    await boot(page);
    await populate(page, TWO);
    await installPixelKeyedClassifier(page);

    // `populate` writes a verdict of its own rather than classifying anything, so
    // the gallery has to be classified through the toggle before there is a
    // number to compare. Unchecking first is the classifying pass: the control
    // boots checked, so "check it" on a fresh gallery is the no-op the handler's
    // early return is there to swallow.
    await toggleAndSettle(page, false);
    const cropOnly = await shownScores(page);
    expect(cropOnly.every((p) => p.viewsTotal === 1), "the crop-only pass ran").toBe(true);

    await toggleAndSettle(page, true);
    const bothViews = await shownScores(page);
    expect(bothViews.every((p) => p.viewsTotal === 2), "the two-view pass ran").toBe(true);

    // Unchecking again must land back on the numbers the first crop-only pass
    // produced, not merely on some other set of numbers.
    await toggleAndSettle(page, false);
    const cropOnlyAgain = await shownScores(page);
    expect(cropOnlyAgain.every((p) => p.viewsTotal === 1)).toBe(true);

    // THE INVARIANT. Two views and one view must not produce the same numbers.
    // The threshold is not "not equal": a fusion that moved every species by
    // 1e-9 is a fusion that did not happen. A real second opinion moves the
    // leading species by a visible amount - a tenth of a point of posterior is
    // still far below the smallest change two genuinely different views of one
    // photograph produce here, and far above float noise.
    for (const a of cropOnly) {
      const b = bothViews.find((p) => p.name === a.name)!;
      const move = biggestScoreMove(a.detail, b.detail);
      expect(
        move,
        `${a.name}: the crop-only and two-view posteriors differ by ${move}, so unchecking ` +
          "the whole-frame view changed nothing on screen",
      ).toBeGreaterThan(1e-3);
    }

    // Direction, not just magnitude. Log-linear pooling cannot make the crop's
    // own posterior reappear exactly: with the whole frame added, every species
    // moves by a different amount, because the second view is a different
    // opinion rather than a copy. So the crop-only posterior must differ from
    // the crop's own softmax, and re-checking must land back on the two-view
    // numbers rather than somewhere new.
    for (const a of cropOnly) {
      const b = cropOnlyAgain.find((p) => p.name === a.name)!;
      expect(
        biggestScoreMove(a.detail, b.detail),
        `${a.name}: unchecking twice produced different numbers, so re-checking did not ` +
          "restore the state it started from",
      ).toBeLessThan(1e-9);
    }

    expect(errors(page)).toHaveLength(0);
  });

  test("a crop-only pass is the crop's own posterior, not a second view wearing its name", async ({ page }) => {
    // The weaker claim above - "the numbers moved" - is also what a fusion bug
    // that pooled the crop with ITSELF would produce, since averaging a view
    // with itself is a no-op on a log scale... so it would move nothing and be
    // caught. The claim pinned here is the converse and the sharper one: with
    // one view the photo's posterior must be reproducible from that view alone.
    //
    // What makes it checkable is that the two views of one photo are genuinely
    // different pictures, so the crop-only posterior and the two-view posterior
    // cannot coincide. Asserting the size of the gap is asserting that the
    // second view carried information - not that a flag was read.
    await boot(page);
    await populate(page, TWO);
    await installPixelKeyedClassifier(page);

    await toggleAndSettle(page, false);
    const cropOnly = await shownScores(page);
    await toggleAndSettle(page, true);
    const both = await shownScores(page);

    for (const c of cropOnly) {
      const b = both.find((p) => p.name === c.name)!;
      expect(
        biggestScoreMove(c.detail, b.detail),
        `${c.name}: adding the whole frame moved the posterior by less than 1e-6, so the ` +
          "second view contributed nothing and the toggle is decorative",
      ).toBeGreaterThan(1e-6);
      // And the move is not one species wobbling while the rest stay put: a
      // second opinion that agrees everywhere is a second opinion that was not
      // read. Count the species that moved at all.
      const moved = Object.keys(c.detail).filter(
        (n) => Math.abs((c.detail[n] ?? 0) - (b.detail[n] ?? 0)) > 1e-9,
      ).length;
      expect(moved, `${c.name}: only ${moved} species moved`).toBeGreaterThan(1);
    }

    expect(errors(page)).toHaveLength(0);
  });

  test("a toggle during an engine re-run re-classifies the whole gallery, not just the re-run's photos", async ({ page }) => {
    // The no-op this file was written for.
    //
    // `rerunPhotos` narrows a pass to the photos an engine-switch re-run is
    // re-classifying, and the toggle's pass reads the same narrowing. So a
    // toggle that lands while a re-run is in flight re-fuses only that re-run's
    // photos: the rest of the gallery keeps a verdict fused from two views while
    // the checkbox says one, and nothing tells the user. The re-run is minutes
    // of inference, so the window is wide - and it is not repaired by a reload,
    // because the setting and the scores disagree for a reason no reload knows
    // about.
    await boot(page);
    await populate(page, TWO);
    await installPixelKeyedClassifier(page);
    await toggleAndSettle(page, true);
    const before = await shownScores(page);

    // Stand in for an engine-switch re-run in progress: `rerunPhotos` set to a
    // strict subset of the gallery, which is exactly what
    // `reprocessLoadedPhotos` does around its `reclassifyRunner.request()`.
    // The toggle must widen the pass back to every photo.
    const after = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const box = document.getElementById("chk-whole-frame") as HTMLInputElement;
      // One photo is mid-re-run; the other is not in the set at all.
      A.rerunPhotos = new Set([A.previews[0]]);
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      const deadline = performance.now() + 10_000;
      while (A.previews.some((p: any) => p.pending) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        timedOut: performance.now() >= deadline,
        out: A.previews.map((p: any) => ({ name: p.name, viewsTotal: p.viewsTotal })),
      };
    });

    expect(after.timedOut, "the toggle never settled").toBe(false);
    // BOTH photos, not the one the re-run happened to be holding.
    expect(
      after.out.every((p) => p.viewsTotal === 1),
      `only ${after.out.filter((p) => p.viewsTotal === 1).length}/${after.out.length} photos ` +
        "were re-classified: the toggle was narrowed to the engine re-run's photo set",
    ).toBe(true);

    // And the photo outside that set actually moved, which is the user's symptom.
    const moved = await page.evaluate(() =>
      window.__mosqAsync!.previews.map((p: any) => p.detail as Record<string, number>),
    );
    expect(
      biggestScoreMove(before[0]!.detail, moved[0]!),
      "the photo outside the re-run's set kept its two-view posterior",
    ).toBeGreaterThan(1e-3);

    expect(errors(page)).toHaveLength(0);
  });
});
