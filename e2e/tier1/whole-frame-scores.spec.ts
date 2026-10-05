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
 * Keyed on the pixels ALONE it is not enough. A fake that leans on no species row
 * leaves the crop near-flat, so the crop and the whole frame are close to
 * indistinguishable and a fusion bug has nothing to be visible in. The fake
 * therefore leans on a species row chosen by the hash, which keeps the two views
 * genuinely different. `expectConfidentCrop` asserts that.
 *
 * (This file used to have to keep the fixture ABOVE `CROP_ONLY_MAX_POSTERIOR`,
 * because `fuseViews` discarded the whole frame for an unconfident crop. That
 * router is gone - see the last spec, which is now the regression test for it.)
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
 * strided sample of it picks a species row out of the SHIPPED head and seeds a
 * direction from it, so two views of one photo land on different rows with
 * overwhelming probability and the fused posterior differs from either view's
 * own. The full tensor is walked at a stride rather than hashed whole because a
 * view is 150528 floats and this runs on every view of every photo in the pass.
 *
 * The species row matters as much as the pixel key. A direction that leans on no
 * row scores every species at the same near-zero cosine, `softmaxJoint` returns
 * an almost flat posterior, and `fuseViews` then routes the photo to its crop
 * alone - `CROP_ONLY_MAX_POSTERIOR` - without ever pooling the whole frame. The
 * specs here are about pooling, so the fake has to be confident enough to reach
 * it: `LEAN` is the cosine the chosen row is given against a hash-keyed
 * direction of comparable size, which puts the crop's top posterior far above the
 * router threshold while leaving every other species an order of magnitude below
 * it. `expectConfidentCrop` is what keeps that true.
 */
async function installPixelKeyedClassifier(page: Page, lean = 3): Promise<void> {
  await page.evaluate((LEAN) => {
    const A = window.__mosqAsync!;
    const w = window as any;
    // The head is read per run, not captured: `populate` is what installs it, and
    // an engine switch mid-test rebinds `A.embeds`.
    const head = () => A.embeds as { dim: number; species: string[]; species_emb: Float32Array };
    w.__fakeClip = { runs: 0 };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run(feeds: Record<string, { data: Float32Array }>) {
        const f = w.__fakeClip;
        f.runs++;
        // A macrotask, so a second run could start if the caller let one.
        await new Promise((r) => setTimeout(r, 0));
        const H = head();
        const dim = H.dim;
        const S = H.species.length;
        const src = feeds["pixel_values"]!.data;
        let h = 0x811c9dc5;
        for (let i = 0; i < src.length; i += 97) {
          h ^= Math.round(src[i]! * 1000) | 0;
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        // The species this view votes for, and that row unit-length so `lean`
        // means the same thing whatever the head's embedding norms are. A lean of
        // 0 is the same hash-keyed direction with no species row behind it: a
        // classifier with no opinion, which is what the confidence router reacts
        // to.
        const k = h % S;
        const rows = H.species_emb;
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += rows[k * dim + i]! * rows[k * dim + i]!;
        norm = Math.sqrt(norm) || 1;
        // A direction that depends only on the hash, but is not a fixed one.
        const noise = new Float32Array(dim);
        let noiseNorm = 0;
        for (let i = 0; i < dim; i++) {
          let x = (h ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
          x ^= x >>> 15;
          x = Math.imul(x, 0x2545f491) >>> 0;
          noise[i] = ((x >>> 8) / 8388608) - 1;
          noiseNorm += noise[i]! * noise[i]!;
        }
        // Unit-normalised, so `lean` is the cosine the chosen species row is
        // given against the hash direction and means the same at any dim. Left
        // un-normalised the hash direction's norm grows as sqrt(dim/3) and the
        // species row is simply drowned - which is what a flat posterior looks
        // like from inside the app, and what this fixture must not be.
        noiseNorm = Math.sqrt(noiseNorm) || 1;
        const data = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          data[i] = LEAN * (rows[k * dim + i]! / norm) + noise[i]! / noiseNorm;
        }
        // clipEmbed L2-normalises over the first `dim` coordinates anyway, so
        // the returned vector only has to be non-degenerate.
        return { embedding: { dims: [1, dim], data } };
      },
    };
  }, lean);
}

/** One photo as the helper below needs it: the fused posterior and the adjacent mass. */
interface CropReading {
  name: string;
  detail: Record<string, number>;
  adP: number[] | null;
  /** Views the pass was asked for, written by `applyViews` before `fuseViews` runs. */
  viewsTotal: number;
}

/**
 * The top JOINT species posterior - the number the confidence router reads.
 *
 * `fuseViews` gates on `Math.max(...viewResults[0].spP)`, which is the species
 * slice of the one softmax `softmaxJoint` runs over species, nuisance and
 * adjacent together. `detail` is not that: `fuseViews` renormalises the pooled
 * species block over species+nuisance only, so every species posterior on the
 * record is inflated by whatever mass the adjacent block took. On the shipped
 * H/14 head the two coincide only when that mass is ~0 - which is exactly the
 * regime this file's `lean = 3` fixture sits in, and the reason the mismatch has
 * never failed here. On a head carrying live adjacent rows the inflation is real
 * (measured 2.03x on a 16+8+7 head), and a helper reading `detail` would certify
 * a crop the router rejects at 0.44 - the same scale error
 * `tests/router-scale.test.ts` exists to catch, one layer out.
 *
 * So the joint scale is recovered rather than read off `detail`. With one view
 * the renormalisation divides the species block by `1 - sum(adjacent)`, so
 * `max(spP) = max(detail) * (1 - sum(adP))` exactly - checked to 1e-12 against
 * the shipped head across `lean` 0, 1.5 and 3 and five hash seeds. `adP` is on
 * the photo record (`commitScores` files it), so this costs no production code.
 *
 * ONE VIEW ONLY. On a pooled record `detail` is the fused posterior, so this
 * recovers the FUSED joint top, not the crop view's joint top that the router
 * conditional actually compares - a different quantity, and no rescaling gets
 * from one to the other, because the pool is a log-linear combination and is not
 * invertible. Measured on this file's own fixtures: 14 of 14 two-view rows wrong,
 * errors to 0.37, and 9 of 14 disagree about the 0.80 threshold itself. The
 * precondition is asserted here rather than stated in prose, because the obvious
 * refactor - reading a post-toggle score instead of a crop-only one - would
 * otherwise leave a guard that fails about two thirds of the time for reasons
 * that read as a drifted fixture.
 */
function jointTopPosterior(p: CropReading): number {
  expect(
    p.viewsTotal,
    `${p.name}: jointTopPosterior recovers the CROP view's joint posterior, which is ` +
      "only what fuseViews' router conditional compares when a single view was " +
      `pooled. This reading came from ${p.viewsTotal} views, so it is the fused ` +
      "posterior and the router never read it. Read the score with the whole-frame " +
      "toggle off, or use the fused posterior directly.",
  ).toBe(1);
  const adjacentMass = (p.adP ?? []).reduce((a, b) => a + b, 0);
  return Math.max(...Object.values(p.detail)) * (1 - adjacentMass);
}

/**
 * The crop-only posterior must sit above the confidence router's threshold.
 *
 * Below it, `fuseViews` answers the photo from the crop alone and never pools the
 * whole frame, so every "the two views disagree" assertion in this file would be
 * measuring the router rather than the fusion. Asserted against the threshold
 * imported from the source rather than a copy of the number, so a change to the
 * router that puts this fixture back under it fails here with the reason, and on
 * the joint scale the router reads rather than the renormalised `detail` - see
 * `jointTopPosterior`.
 */
function expectConfidentCrop(cropOnly: CropReading[]) {
  // No longer a guard against the router, which is gone: every crop is pooled
  // whatever its confidence. What it still protects is the other specs' premise -
  // that the two views are genuinely different, so a fusion bug has something to
  // be visible in. A flat crop and a flat frame fuse to something neither of them
  // said, and the specs below would pass for the wrong reason.
  for (const p of cropOnly) {
    expect(
      jointTopPosterior(p),
      `${p.name}: the crop is flat, so the crop and the whole frame are not ` +
        "distinguishable and these specs cannot see a fusion bug through that",
    ).toBeGreaterThan(0.5);
  }
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
 * both render, so it is the displayed number rather than an intermediate - but
 * the router reads the joint scale `detail` was renormalised away from, so `adP`
 * comes along with it and `jointTopPosterior` puts the two back together.
 */
async function shownScores(page: Page) {
  return page.evaluate(() =>
    window.__mosqAsync!.previews.map((p: any) => ({
      name: p.name,
      viewsTotal: p.viewsTotal,
      detail: p.detail as Record<string, number>,
      adP: (p.adP ?? null) as number[] | null,
      verdict: p.verdict,
      // What `viewAgreement` reported about the views that were actually pooled,
      // which is what the score panel renders any claim about a second view from.
      agreement: p.agreement as unknown,
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
    // The whole-frame view only gets pooled when the crop is confident enough to
    // be worth pooling with, so this is a precondition of everything below rather
    // than part of the claim.
    expectConfidentCrop(cropOnly);

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
    expectConfidentCrop(cropOnly);
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

  test("an unconfident crop is still pooled with the whole frame (#90)", async ({ page }) => {
    // The regression test for #90, and the inverse of what used to be here.
    //
    // This spec previously pinned the ROUTER: with a crop whose top joint
    // posterior fell below CROP_ONLY_MAX_POSTERIOR, `fuseViews` answered from the
    // crop alone, so checking "include the whole photo" scored a second view and
    // then discarded it. The scores could not move, and the app told the user
    // nothing - no second opinion, no disagreement, `viewsTotal` written to the
    // photo record and never rendered.
    //
    // The router is gone. Every view counts whatever its confidence, so the same
    // fixture - a flat crop, installed with `lean = 0` - must now show the whole
    // frame changing the answer. If this ever goes back to a no-op, the cause is a
    // discard rule of some kind, and this is where it surfaces.
    await boot(page);
    await populate(page, TWO);
    await installPixelKeyedClassifier(page, 0);

    await toggleAndSettle(page, false);
    const cropOnly = await shownScores(page);
    await toggleAndSettle(page, true);
    const both = await shownScores(page);

    // The fixture is what makes this the interesting case: the crop is not sure,
    // which is exactly the condition the router used to key on.
    for (const c of cropOnly) {
      expect(
        jointTopPosterior(c),
        `${c.name}: this fixture is only interesting when the crop is UNSURE; ` +
          `a confident crop is pooled by every rule, so this test would pass for the wrong reason`,
      ).toBeLessThan(0.5);
    }

    // The whole frame WAS classified...
    expect(
      both.every((p) => p.viewsTotal === 2),
      "the whole frame was never classified, so there is nothing to assert about pooling",
    ).toBe(true);

    // ...and it is now pooled, so the scores must have moved. This assertion
    // could not exist while the router was in place: on that branch `fuseViews`
    // returned the crop's own softmax, so `cropOnly.detail` and `both.detail`
    // being identical was a property of the arithmetic rather than of the app.
    for (const c of cropOnly) {
      const b = both.find((p) => p.name === c.name)!;
      expect(
        b.detail,
        `${c.name}: the whole frame was classified and the pooled scores are identical to the ` +
          "crop's own - a view is being discarded somewhere between fuseViews and the score panel",
      ).not.toEqual(c.detail);
    }

    // And with two views actually pooled, the app can report whether they agree.
    // A crop-only answer could not: `viewAgreement` runs over the views that were
    // pooled, and there were none.
    expect(
      both.some((p) => p.agreement !== null),
      "two views were pooled but no agreement was reported - viewAgreement is being skipped",
    ).toBe(true);

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
