import { test, expect, boot, populate, settle, errors } from "../helpers/app";
import type { Page } from "@playwright/test";
import type { PhotoSpec } from "../helpers/app";

/**
 * Toggling the whole-frame view must not re-run inference (#59).
 *
 * The control changes which views are POOLED. The crop canvas and the whole
 * frame are the same pixels either way, so every view a gallery was classified
 * with was already scored - and the toggle was re-running a full ONNX pass over
 * all of them to get a number it already had. That is why it was slow, why it
 * blocked the thread in bursts, and why it had to be serialised one photo at a
 * time.
 *
 * What is asserted is a COUNT, not a duration: the classifier's own call counter,
 * read through the same seam everything else in this tier uses. A timing
 * assertion here would be unfalsifiable - the box is shared and the model is a
 * fake - whereas "zero classifier calls" is exactly the claim, and a regression
 * makes it false immediately.
 *
 * `views.test.ts` and `whole-frame-toggle-effect.test.ts` already pin the
 * scheduling and the pooling arithmetic. Neither can see this: both drive
 * something other than the app's own classify path. So the toggle here is the
 * real one, on a real gallery, with a real `sessClip` counting what it is asked
 * for.
 */

const TEN: PhotoSpec[] = Array.from({ length: 10 }, (_, i) => ({
  name: `photo_${i}.jpg`,
  state: "species",
}));

/**
 * A classifier that returns a real-shaped embedding without downloading
 * anything, and counts every run.
 *
 * A fixed direction is the same embedding for every view, so two views of a
 * photo pool to exactly what one view says. That is deliberate here: this spec
 * is about how many times the classifier was called, and about the numbers on
 * screen not changing, neither of which a view-dependent fake would serve. The
 * posteriors themselves are pinned against the shipped `fuseViews` in
 * `tests/view-cache.test.ts`, where the two views genuinely disagree.
 */
async function installCountingClassifier(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const emb = A.embeds as { dim: number };
    const w = window as any;
    w.__fakeClip = { started: 0 };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        w.__fakeClip.started++;
        const data = new Float32Array(emb.dim);
        // A fixed direction L2-normalises to itself, so the softmax is real
        // arithmetic over a real embedding.
        data.fill(1 / Math.sqrt(emb.dim));
        return { embedding: { dims: [1, emb.dim], data } };
      },
    };
  });
}

/** How many classifier runs have been asked for since the counter was last read. */
async function classifierCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__fakeClip.started);
}

/**
 * The numbers a photo is displaying, as a comparable string.
 *
 * Read through the record rather than the DOM so the comparison cannot be
 * satisfied by the UI rendering a stale label over changed scores. `detail` is
 * the fused species posterior the results table and the score panel both read.
 */
async function displayedScores(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__mosqAsync!.previews.map((p: any) => JSON.stringify(p.detail)),
  );
}

/**
 * Turn on the whole-frame view, which the crop-only default leaves off.
 *
 * This spec is about the round trip between the two views, so it needs the app
 * in the configuration where both exist. The control boots unchecked since the
 * crop-only default (#102), and setting an already-unchecked box fires no change
 * at all - so a spec that warmed the cache by toggling off first would be
 * warming nothing. Checked through the same control a user would, after
 * `populate` has made the gallery visible (the control lives in a section that
 * is `display:none` until then), so this also runs the pass that classifies
 * every photo under both views.
 */
async function enableWholeFrame(page: Page): Promise<void> {
  await page.locator("#chk-whole-frame").setChecked(true);
  await page.waitForFunction(
    () => !window.__mosqAsync!.previews.some((p: any) => p.pending),
    null,
    { timeout: 10_000 },
  );
}

/** Click the checkbox and wait for the pass it triggers to settle. */
async function toggleAndSettle(page: Page, checked: boolean, budgetMs = 5000) {
  await page.locator("#chk-whole-frame").setChecked(checked);
  await page.waitForFunction(
    () => !window.__mosqAsync!.previews.some((p: any) => p.pending),
    null,
    { timeout: budgetMs },
  );
}

test.describe("a whole-frame toggle re-fuses cached views", () => {
  test("runs no inference at all, and leaves the displayed scores alone", async ({ page }) => {
    await boot(page);
    await populate(page, TEN);
    await installCountingClassifier(page);
    await settle(page);

    // `populate` writes records without classifying them, so the cache starts
    // empty. Crop-only is the default (#102), so the pass that fills the cache
    // is the one that CHECKS the control: with both views pooled it scores the
    // crop and the whole frame of every photo. That is real work, not a
    // regression, and it is asserted rather than assumed - a pass that widened
    // the pool without scoring the view it added would leave the toggles below
    // free for the wrong reason.
    await enableWholeFrame(page);
    expect(
      await classifierCalls(page),
      "widening the pool classified nothing, so no view was ever cached",
    ).toBeGreaterThan(0);

    const settledScores = await displayedScores(page);

    // Turning the view OFF changes the numbers - it pools fewer views, which is
    // the control doing its job - so this pass is expected to differ.
    await toggleAndSettle(page, false);
    const cropOnlyScores = await displayedScores(page);
    expect(cropOnlyScores, "dropping the whole-frame view did not change the pool").not.toEqual(
      settledScores,
    );
    const viewsTotalOff = await page.evaluate(() =>
      window.__mosqAsync!.previews.map((p: any) => p.viewsTotal),
    );
    expect(viewsTotalOff.every((v: number) => v === 1)).toBe(true);

    // THE ASSERTION. Both views of all ten photos are cached now, and this
    // toggle pools both again. Nothing about the pixels changed, so the only
    // work a correct implementation has to do is arithmetic - and the numbers it
    // arrives at are the two-view pool from before, exactly.
    const before = await classifierCalls(page);
    await toggleAndSettle(page, true);
    const after = await classifierCalls(page);

    expect(
      after - before,
      `the toggle ran ${after - before} classifier calls; it should have run none`,
    ).toBe(0);
    expect(
      await displayedScores(page),
      "a cached re-fusion did not reproduce the two-view pool it came from",
    ).toEqual(settledScores);
    const viewsTotalOn = await page.evaluate(() =>
      window.__mosqAsync!.previews.map((p: any) => p.viewsTotal),
    );
    expect(viewsTotalOn.every((v: number) => v === 2)).toBe(true);

    expect(errors(page)).toHaveLength(0);
  });

  test("caches every view, so every later toggle in either direction is free", async ({ page }) => {
    // One toggle proves the cache fills. Repeated toggling is what a user
    // actually does, and it is where a cache that only ever holds the views of
    // the last pass would still pass the test above and still re-classify on
    // every other press.
    await boot(page);
    await populate(page, TEN);
    await installCountingClassifier(page);
    await settle(page);

    // Warm both kinds.
    await toggleAndSettle(page, false);
    await toggleAndSettle(page, true);

    // Both directions, twice each, all four of them free.
    for (const checked of [false, true, false, true]) {
      const before = await classifierCalls(page);
      await toggleAndSettle(page, checked);
      const after = await classifierCalls(page);
      expect(after - before, `the toggle to ${checked} ran inference`).toBe(0);
    }

    expect(errors(page)).toHaveLength(0);
  });

  test("a photo whose crop changes is classified again, not served from the cache", async ({ page }) => {
    // The other direction of the key. A new crop is new pixels: the posterior on
    // the record describes a picture the photo is no longer showing, and its
    // shape is identical to the right one, so nothing downstream could notice.
    await boot(page);
    await populate(page, TEN);
    await installCountingClassifier(page);
    await settle(page);

    // Warm both kinds for every photo, then re-cut photo 0's crop the way a crop
    // release does - new pixels on the canvas, and the pixel generation bumped.
    // This drives the record's own fields rather than a pointer drag, because the
    // claim under test is about the cache key and a synthetic pointer gesture
    // would fail for reasons that have nothing to do with it.
    await toggleAndSettle(page, false);
    await toggleAndSettle(page, true);
    const before = await classifierCalls(page);

    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      const p = A.previews[0]!;
      const cv = p.cropCanvas!;
      cv.getContext("2d")!.fillRect(0, 0, cv.width, cv.height);
      p.contentRev = (p.contentRev || 0) + 1;
    });

    // A pooling-only toggle over that photo must NOT serve the old crop's
    // posterior, so this one is expected to run the classifier.
    await toggleAndSettle(page, false);
    const after = await classifierCalls(page);
    expect(
      after - before,
      "a re-cropped photo reused a posterior of the previous crop's pixels",
    ).toBeGreaterThan(0);

    expect(errors(page)).toHaveLength(0);
  });

  test("the cached views still let viewAgreement see both views", async ({ page }) => {
    // The trap. `viewAgreement` reports whether the pooled views agree, which
    // needs each view's own posterior. A cache of the FUSED posterior would make
    // a cached toggle report agreement the app never computed - and would make
    // it impossible to compute later, because the per-view detail would already
    // be gone. Read straight off the record: both kinds are present, and they
    // are distinct results.
    await boot(page);
    await populate(page, TEN);
    await installCountingClassifier(page);
    await settle(page);

    // Both kinds get scored: the off-toggle scores the crop, the on-toggle
    // scores the whole frame.
    await toggleAndSettle(page, false);
    await toggleAndSettle(page, true);

    const caches = await page.evaluate(() =>
      window.__mosqAsync!.previews.map((p: any) => ({
        kinds: Object.keys(p.viewCache ?? {}).sort(),
        sameObject: p.viewCache?.crop?.result === p.viewCache?.whole?.result,
        agreement: p.agreement === null ? null : p.agreement.agree,
      })),
    );

    for (const c of caches) {
      // Both views are on the record after a pooling-only toggle, so widening
      // the pool is free and `viewAgreement` has the detail to recompute from.
      expect(c.kinds, "a toggle dropped a cached view").toEqual(["crop", "whole"]);
      // Distinct results, not the fused posterior filed under both kinds.
      expect(c.sameObject, "both kinds hold the same object: the fused posterior is cached").toBe(false);
    }

    expect(errors(page)).toHaveLength(0);
  });
});