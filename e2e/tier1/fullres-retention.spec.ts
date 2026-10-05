import { boot, errors, expect, populate, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * A settled photo holds a display-sized canvas and its File, not the frame.
 *
 * The photograph used to stay on the record for the life of the gallery, at
 * 45.8 MiB for a 12-megapixel one and 108.6 MiB with a detection's crop and
 * context region on top. That is linear in the gallery with no plateau, so a
 * hundred photographs cost nearly eleven gigabytes and nothing about the app
 * needed them: the panels paint a few hundred CSS pixels and the browser can
 * decode the File again for nothing.
 *
 * What genuinely reads full-resolution pixels is cutting a crop and re-running
 * the classifier, and both go and get the frame back. So the contract is three
 * halves, and each is observable here: the frame is gone once a photo has
 * settled, a crop drawn afterwards still cuts the right pixels of a big
 * photograph, and the re-run still scores it.
 *
 * Tier 1 never downloads a model: the sessions are faked the way
 * `reprocess.spec.ts` fakes them, so the shipped letterbox, detector decode,
 * classifier path and fusion all run for real over real decoded photographs.
 */

/**
 * `ort.Tensor` when the CDN bundle did not load. Tier 1's only use of
 * onnxruntime is the tensor the detector's letterbox builds, which `decodeDets`
 * reads two fields off - the whole surface `src/app/ort.ts` declares.
 */
async function ensureTensor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.ort) return;
    w.ort = {
      Tensor: class {
        data: Float32Array;
        dims: number[];
        constructor(_type: string, data: Float32Array, dims: number[]) {
          this.data = data;
          this.dims = dims;
        }
      },
    };
  });
}

/**
 * Two photos at 4032x3024 - a real phone photograph's dimensions, and big
 * enough that holding the frame would be obvious in the numbers - through the
 * app's own intake, with a detector that finds a box in each.
 *
 * The fake detector's tensor is the shipped `[1, 5, 8400]` layout `decodeDets`
 * reads: four box coordinates in the 640px letterboxed space at offsets 0..3
 * and a class score at row 4. The fake classifier returns the first species'
 * own embedding, which is what a crop needs to PASS the nuisance gate and stay
 * cropped rather than falling back to the whole frame.
 */
async function loadBigPhotos(page: Page): Promise<void> {
  await ensureTensor(page);
  await page.evaluate(async () => {
    const A = window.__mosqAsync!;
    const w = window as any;
    // The text embeddings, fetched for real from the site rather than faked:
    // the classifier's softmax is the shipped arithmetic over a real head, so a
    // crop has to pass the nuisance gate on its merits and stay cropped.
    const embeds = await fetch("text_embeds.json").then((r) => r.json());
    for (const k of ["species_emb", "nuisance_emb"]) embeds[k] = Float32Array.from(embeds[k]);
    A.embeds = embeds;
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        const N = 8400;
        const d = new Float32Array(5 * N);
        d[0] = 320; d[N] = 240; d[2 * N] = 900; d[3 * N] = 800;
        d[4 * N] = 0.9;
        return { output0: { dims: [1, 5, N], data: d } };
      },
    };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        return {
          embedding: { dims: [1, dim], data: Float32Array.from(A.embeds.species_emb.slice(0, dim) as Float32Array) },
        };
      },
    };
    // The session cache entry is what makes the engine usable without a
    // download: `processFiles` refuses a batch while the session is missing, and
    // the path that seeds it is a fetch of the 1.26 GB model.
    A.clipSessions["webgpu-fp16"] = { sess: A.sessClip, ep: "wasm" };

    const files: File[] = [];
    for (let i = 0; i < 2; i++) {
      const cv = document.createElement("canvas");
      cv.width = 4032;
      cv.height = 3024;
      const ctx = cv.getContext("2d")!;
      // A gradient rather than a flat fill, so a crop of the wrong pixels is a
      // different picture and not merely a differently-sized one.
      for (let y = 0; y < 3024; y += 96) {
        for (let x = 0; x < 4032; x += 96) {
          ctx.fillStyle = `hsl(${(x + y + i * 40) % 360}, 50%, 30 + ((x / 96 + y / 96) % 40)}%)`;
          ctx.fillRect(x, y, 96, 96);
        }
      }
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      files.push(new File([blob!], `big_${i}.jpg`, { type: "image/jpeg" }));
    }
    await A.processFiles(files);
  });
}

/** What each photo on screen is holding, as numbers rather than as names. */
async function retained(page: Page) {
  return page.evaluate(() => {
    const P = window.__mosqAsync!.previews as any[];
    const mb = (c: any) => (c ? +((c.width * c.height * 4) / 1048576).toFixed(1) : 0);
    const per = (p: any) => {
      // Counted by identity, so one canvas under three names is one canvas -
      // which is what the no-detection case is, and counting it three times is
      // how a fix like this one can appear to save nothing.
      const seen = new Set<any>();
      for (const k of ["displayCanvas", "cropCanvas", "contextCanvas", "sourceCanvas"]) {
        if (p[k]) seen.add(p[k]);
      }
      return { distinct: seen.size, MB: +[...seen].reduce((a, c) => a + mb(c), 0).toFixed(1) };
    };
    return {
      n: P.length,
      displayLongEdges: P.map((p) => (p.displayCanvas ? Math.max(p.displayCanvas.width, p.displayCanvas.height) : null)),
      // Every canvas the record holds, and the largest edge of each. This is the
      // assertion that would fail if the frame came back: `fullCanvas` is gone
      // from `PhotoState`, so counting a field that is always undefined proves
      // nothing - what a re-introduced frame changes is the SIZE of what is
      // there, which is measurable without knowing the field's name.
      allEdges: P.map((p) => (["displayCanvas", "cropCanvas", "contextCanvas", "sourceCanvas"] as const)
        .filter((k) => p[k])
        .map((k) => Math.max(p[k].width, p[k].height))),
      cachedFrames: window.__mosqAsync!.retainedFullCanvasCount(),
      dims: P.map((p) => [p.fullW, p.fullH]),
      total: P.reduce((a, p) => { const r = per(p); return { distinct: a.distinct + r.distinct, MB: +(a.MB + r.MB).toFixed(1) }; }, { distinct: 0, MB: 0 }),
    };
  });
}


/**
 * A classifier that counts how many inferences it is asked for, so "one view" and
 * "two views" are counted rather than inferred from a `viewsTotal` field the
 * app itself writes.
 */
async function installCountingClassifier(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const w = window as any;
    w.__countedRuns = 0;
    const dim = (A.embeds as { dim: number }).dim;
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        w.__countedRuns++;
        const emb = (A.embeds as any).species_emb;
        return { embedding: { dims: [1, dim], data: Float32Array.from(emb.slice(0, dim)) } };
      },
    };
    A.clipSessions["webgpu-fp16"] = { sess: A.sessClip, ep: "wasm" };
    // The re-run refuses to start while the engine reports itself unusable, and
    // the fixtures install records without going through the batch, so nothing
    // else would have set this.
    w.modelsReady = true;
  });
}

test.describe("full-resolution retention", () => {
  test("a settled photo holds a display canvas and its dimensions, not the frame", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const r = await retained(page);
    expect(r.n).toBe(2);
    // No canvas anywhere on the records is bigger than the cap, so there is no
    // frame hiding under any of the four names. Before this change the frame was
    // a 4032px canvas on every photo, which is what fails here.
    for (const edges of r.allEdges) {
      expect(edges.length).toBeGreaterThan(0);
      for (const e of edges) expect(e).toBeLessThanOrEqual(2048);
    }
    // And nothing is sitting in the on-demand cache for a photo that has never
    // been cropped.
    expect(r.cachedFrames).toBe(0);
    // A display canvas is present, and bounded - the panels are CSS boxes a few
    // hundred pixels across, so nothing shows the pixels above the cap.
    for (const edge of r.displayLongEdges) {
      expect(edge).not.toBeNull();
      expect(edge!).toBeLessThanOrEqual(2048);
      expect(edge!).toBeGreaterThan(1000);
    }
    // And the photograph's own dimensions are still on the record, which is
    // what every crop box is expressed in.
    for (const [w, h] of r.dims) {
      expect([w, h]).toEqual([4032, 3024]);
    }
    expect(errors(page)).toHaveLength(0);
  });

  test("two big photographs cost a fraction of what the frame costs", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const { total } = await retained(page);
    // Each photograph is 4032x3024 = 46.5 MiB at full resolution, and with a
    // detection's crop and context region on top of it the old cost was 108.6
    // MiB per photo. What is left is three canvases at the display cap, which
    // cannot exceed three times 2048x2048x4 = 48 MiB per photo however large
    // the photograph is - that is the property, not this number.
    expect(total.MB).toBeLessThan(2 * 3 * (2048 * 2048 * 4) / 1048576);
  });

  test("a crop drawn on a 4032x3024 photo cuts a box in the photo's own pixels", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    // The surface fractions of a drag over the whole-photo panel, which the app
    // maps back to the photograph. The box it must produce is in the
    // photograph's pixels, and it is the box the same drag produced when the
    // panel was mapped against the full-resolution canvas.
    const before = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      const p = A.previews[0]!;
      return { box: (p.cropBox as number[]).slice(), fullW: p.fullW, fullH: p.fullH };
    });

    const after = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const p = A.previews[0]!;
      // The same rectangle a user would drag: 20%-70% across, 25%-75% down.
      await A.applyCropFromFullSurface(0, [0.2, 0.25, 0.7, 0.75], performance.now());
      const q = A.previews[0]!;
      const r = document.getElementById("crop-surface-full")!.getBoundingClientRect();
      return {
        box: (q.cropBox as number[]).slice(),
        cropCanvas: q.cropCanvas ? [q.cropCanvas.width, q.cropCanvas.height] : null,
        // The panel's own rect, so the expectation below is built from the map
        // rather than from a constant that only held for one viewport.
        surf: { w: r.width, h: r.height },
        // The frame was fetched, drawn from and released rather than moved onto
        // the photo. Measured by what the cache holds, which is the only place a
        // fetched frame can now be: the `fullCanvas` field this used to read was
        // removed from the record, so reading it proved nothing.
        cachedFrames: A.retainedFullCanvasCount(),
        error: q.error ?? null,
      };
    });

    expect(after.error).toBeNull();
    // The frame is still not resident after a crop, beyond the small cache bound.
    expect(after.cachedFrames).toBeLessThanOrEqual(2);

    // The box is in PHOTOGRAPH pixels. Contain against a 4:3 photograph in the
    // panel's own box letterboxes one axis, so the vertical fractions are
    // remapped - which is exactly why the panel's mapping is per-axis and why
    // these numbers are not simply the drag's fractions times 3024.
    //
    // What makes this a contract rather than a snapshot: the horizontal
    // fractions ARE the drag's, because the photo's width fills the panel. The
    // display canvas is a proportional reduction of the photograph, so if the
    // geometry read ITS dimensions the horizontal numbers would come out at
    // roughly 2048/4032 of these - the whole test would fail.
    //
    // CONTRARY TO WHAT THIS ASSERTION USED TO SAY: the committed box is not the
    // dragged rectangle. #106 makes every manual crop square, and the agreed
    // contract is CUT-THE-BOX - `squareBox` keeps the centre and drops the
    // overflow off the longer axis, rather than padding the shorter one up to
    // 1:1 with pixels the user never pointed at. So the side is the SHORTER of
    // the two mapped extents, here 1928 rather than the dragged 2016, and the
    // horizontal edges sit inside the drag's rather than on them. Do not
    // "restore" the width assertion below: it encodes the pre-square contract,
    // which is the one thing #106 changed.
    const boxAspect = after.surf.w / after.surf.h;
    const imgAspect = before.fullW! / before.fullH!;
    // contain, as `fitMapping` computes it: the axis where the surface has room
    // to spare keeps k = 1 and the other is scaled up, letterboxed.
    const kx = Math.max(1, boxAspect / imgAspect);
    const ky = Math.max(1, imgAspect / boxAspect);
    // The dragged rectangle in photograph pixels, before the constraint.
    const dragW = 0.5 * kx * before.fullW!;
    const dragH = 0.5 * ky * before.fullH!;
    // ...and the square the constraint commits: the shorter extent, centred.
    const side = Math.floor(Math.min(dragW, dragH));

    const [x1, y1, x2, y2] = after.box as [number, number, number, number];
    // The box is SQUARE. This is the contract #106 introduced, asserted in its
    // own terms rather than as a side length that happens to match.
    expect(x2 - x1).toBe(y2 - y1);
    // Its side is the shorter of the two mapped extents - cut-the-box, not
    // pad-to-1:1 - and not the dragged width, which is the longer one.
    expect(x2 - x1).toBeCloseTo(side, -2);
    expect(x2 - x1).not.toBeCloseTo(dragW, -2);
    // The overflow is dropped symmetrically about the drag's centre, so the box
    // is centred on the drag rather than anchored at either of its edges.
    expect((x1 + x2) / 2).toBeCloseTo((0.2 + 0.7) / 2 * before.fullW!, -2);
    // Still where the pointer was: the horizontal edges bracket the drag's, just
    // inside it now that the longer axis has been trimmed.
    expect(x1).toBeGreaterThanOrEqual(0.2 * before.fullW! - 1);
    expect(x2).toBeLessThanOrEqual(0.7 * before.fullW! + 1);
    // The vertical extent is inside the photograph whatever the letterboxing,
    // and is a real region rather than a sliver.
    expect(y1).toBeGreaterThan(0);
    expect(y2).toBeLessThan(before.fullH!);
    expect(y2 - y1).toBeGreaterThan(300);
    // And the crop canvas is the box, not the photograph: a 2048-wide canvas
    // would be nowhere near a square side computed from the photo's own pixels.
    expect(after.cropCanvas![0]).toBeCloseTo(x2 - x1, -2);
    expect(after.cropCanvas![1]).toBeCloseTo(y2 - y1, -2);
    expect(after.cropCanvas![0]).toBeGreaterThan(1500);
    expect(before.box.length).toBe(4);
  });

  test("a photo re-classifies after a crop, and is left holding no frame", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const r = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const p = A.previews[0]!;
      const before = { viewsLanded: p.viewsLanded, total: p.viewsTotal, is_cropped: p.is_cropped };
      await A.applyCropFromFullSurface(0, [0.25, 0.3, 0.75, 0.8], performance.now());
      // The recompute is async: wait for the pending flag the release set to clear.
      for (let i = 0; i < 400 && A.previews[0]!.pending; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      const q = A.previews[0]!;
      return {
        before,
        after: { viewsLanded: q.viewsLanded, viewsTotal: q.viewsTotal, is_cropped: q.is_cropped, pending: q.pending },
        // A photo with a File has nothing to decode it again from, so it keeps
        // no frame of its own - this one is still a real assertion, because
        // `sourceCanvas` IS still a field on the record.
        hasSourceCanvas: !!q.sourceCanvas,
        cachedFrames: A.retainedFullCanvasCount(),
        edges: (["displayCanvas", "cropCanvas", "contextCanvas", "sourceCanvas"] as const)
          .filter((k) => (q as any)[k])
          .map((k) => Math.max((q as any)[k].width, (q as any)[k].height)),
        error: q.error ?? null,
        scores: Object.keys(q.scores).length,
      };
    });

    expect(r.error).toBeNull();
    // It settled, and it re-ran both views rather than leaving the previous
    // crop's numbers on screen under a new box.
    expect(r.after.pending).toBe(false);
    expect(r.after.is_cropped).toBe(true);
    expect(r.after.viewsLanded).toBe(r.after.viewsTotal);
    expect(r.scores).toBeGreaterThan(0);
    // Still nothing full-resolution on the record afterwards.
    expect(r.hasSourceCanvas).toBe(false);
    for (const e of r.edges) expect(e).toBeLessThanOrEqual(2048);
    expect(errors(page)).toHaveLength(0);
  });

  test("two crop draws in a row decode the photograph once, not twice", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const decodes = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      let decodes = 0;
      const real = window.createImageBitmap.bind(window);
      // Count only decodes of a PHOTO's File, which is what the on-demand frame
      // is built from; the intake's own decodes happened before this ran.
      (window as any).createImageBitmap = async (src: any, opts: any) => {
        if (src instanceof File) decodes++;
        return real(src, opts);
      };
      const p = A.previews[0]!;
      await A.applyCropFromFullSurface(0, [0.1, 0.1, 0.5, 0.5], performance.now());
      for (let i = 0; i < 400 && A.previews[0]!.pending; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      await A.applyCropFromFullSurface(0, [0.2, 0.2, 0.6, 0.6], performance.now());
      for (let i = 0; i < 400 && A.previews[0]!.pending; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      (window as any).createImageBitmap = real;
      return decodes;
    });
    // One. The second draw reuses the frame the first one fetched, which is why
    // the cache exists at all: a 12 MP decode is hundreds of milliseconds.
    expect(decodes).toBe(1);
  });

  test("an uncropped photo runs ONE view; a cropped one runs two", async ({ page }) => {
    // The predicate that decides this is `cropBox`, and it has to be visible
    // here rather than only in a unit test: an uncropped photo's `cropCanvas` is
    // its display canvas, a DIFFERENT object from the frame the re-run decodes,
    // so a check on canvas identity says "cropped" and the photograph is pooled
    // against itself as two independent views.
    //
    // The fixtures carry a real crop box on the cropped photo and none on the
    // uncropped one, so the two cases are actually distinguishable - a fixture
    // with a crop canvas and no box makes both look cropped and this test passes
    // for the wrong reason.
    await boot(page);
    await populate(page, [
      // `revertedToFull` so this record takes the re-classify path rather than the
      // re-detect one: the fixtures hold no File, and a photo with no File and no
      // crop cannot be re-run at all - which is a fixture limitation, not the
      // thing under test.
      { name: "uncropped.jpg", state: "species", is_cropped: false, revertedToFull: true },
      { name: "cropped.jpg", state: "species", is_cropped: true },
    ]);
    await installCountingClassifier(page);
    // A cropped photo's second view is conditional on `#chk-whole-frame`, which
    // the crop-only default leaves off, so the run count this test reads is the
    // one-view count unless the control is put where a user would put it.
    //
    // Checking it re-classifies the whole gallery, and that pass runs the same
    // counting classifier this test measures, so it has to finish before
    // `__countedRuns` is read as the baseline - a `settle` two frames deep does
    // not wait for an inference. Polled until the count stops moving.
    await page.locator("#chk-whole-frame").setChecked(true);
    // The re-classification the toggle kicks off runs the same counting
    // classifier, and `reprocessLoadedPhotos` refuses to start while that pass is
    // in flight - so a re-run issued before it lands is silently dropped and the
    // count reads one view short. Wait for the pass: quiet counter, no photo
    // pending, and the two-view outcome actually recorded.
    for (let i = 0; i < 200; i++) {
      const idle = await page.evaluate(async () => {
        const w = window as any;
        const n = w.__countedRuns ?? 0;
        await new Promise((r) => setTimeout(r, 60));
        return (w.__countedRuns ?? 0) === n
          && !window.__mosqAsync!.previews.some((p: any) => p.pending)
          && window.__mosqAsync!.previews.map((p: any) => p.viewsTotal).join() === "1,2";
      });
      if (idle) break;
    }

    const r = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const before = window.__countedRuns ?? 0;
      const reads = {
        uncropped: {
          cropBox: A.previews[0]!.cropBox,
          cropIsDisplay: A.previews[0]!.cropCanvas === A.previews[0]!.displayCanvas,
        },
        cropped: {
          cropBox: A.previews[1]!.cropBox,
          cropIsDisplay: A.previews[1]!.cropCanvas === A.previews[1]!.displayCanvas,
        },
      };
      // First pass, cache intact. The toggle above already scored every view
      // these photos offer, and `beginRecompute(p, false)` left `contentRev`
      // alone, so this re-fuses what is cached and infers nothing. That is the
      // per-view cache's whole claim (#105), asserted here rather than assumed.
      await A.reprocess();
      for (let i = 0; i < 600 && A.previews.some((p: any) => p.pending); i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      const cachedRuns = (window.__countedRuns ?? 0) - before;

      // Second pass with the cache dropped, so the run COUNT is measured on
      // pixels nothing has been scored from yet. What this test is really about
      // is the predicate - how many views a photo offers - and the count is
      // the evidence for it: three inferences means one view for the uncropped
      // photo and two for the cropped one. Asserting the count against a warm
      // cache would measure the cache instead of the predicate.
      A.previews.forEach((p: any) => { p.viewCache = {}; });
      const beforeFresh = window.__countedRuns ?? 0;
      await A.reprocess();
      for (let i = 0; i < 600 && A.previews.some((p: any) => p.pending); i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        reads,
        cachedRuns,
        runs: (window.__countedRuns ?? 0) - beforeFresh,
        viewsLanded: A.previews.map((p: any) => p.viewsLanded),
        viewsTotal: A.previews.map((p: any) => p.viewsTotal),
        detail: A.previews.map((p: any) => ({ name: p.name, err: p.error, is_cropped: p.is_cropped,
                                               box: p.cropBox, pending: p.pending, status: p.status })),
      };
    });

    // The fixture really is the two cases, not two copies of one.
    expect(r.reads.uncropped.cropBox).toBeNull();
    expect(r.reads.uncropped.cropIsDisplay).toBe(true);
    expect(r.reads.cropped.cropBox).not.toBeNull();
    expect(r.reads.cropped.cropIsDisplay).toBe(false);

    // A re-run over views the toggle already scored infers nothing, and still
    // lands the same number of views per photo.
    expect(r.cachedRuns, `cachedRuns=${r.cachedRuns} viewsTotal=${JSON.stringify(r.viewsTotal)} landed=${JSON.stringify(r.viewsLanded)} detail=${JSON.stringify(r.detail)}`).toBe(0);

    // Three runs on uncached pixels: one for the uncropped photo, two for the
    // cropped one.
    expect(r.runs, `runs=${r.runs} viewsTotal=${JSON.stringify(r.viewsTotal)} landed=${JSON.stringify(r.viewsLanded)} detail=${JSON.stringify(r.detail)}`).toBe(3);
    expect(r.viewsTotal).toEqual([1, 2]);
    expect(r.viewsLanded).toEqual([1, 2]);
  });

  test("emptying the gallery releases every frame it had out on loan", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const r = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      // Two crops on two photographs, so the cache is at its bound and both
      // photographs have a frame that a per-photo release would not reach.
      for (const i of [0, 1]) {
        await A.applyCropFromFullSurface(i, [0.2, 0.2, 0.6, 0.6], performance.now());
      }
      for (let k = 0; k < 400 && A.previews.some((p: any) => p.pending); k++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      const held = A.retainedFullCanvasCount();
      A.deleteAllPhotos();
      const A2 = window.__mosqAsync!;
      return { held, after: A2.retainedFullCanvasCount(), n: A2.previews.length };
    });
    expect(r.n).toBe(0);
    // The cache was occupied, so this is not passing because there was nothing
    // to release - `deleteAllPhotos` empties `previews` without touching the
    // cache, which leaves both frames resident.
    expect(r.held).toBeGreaterThan(0);
    expect(r.after).toBe(0);
  });

  test("alternating between two photographs decodes each of them once", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const r = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      let decodes = 0;
      const real = window.createImageBitmap.bind(window);
      (window as any).createImageBitmap = async (src: any, opts: any) => {
        if (src instanceof File) decodes++;
        return real(src, opts);
      };
      const settle = async () => {
        for (let i = 0; i < 400 && A.previews.some((p: any) => p.pending); i++) {
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      // A -> B -> A -> B: the pattern a user comparing two photographs makes.
      // A cache that keeps only one frame holds A forever, so every B here is a
      // fresh 46 MiB decode.
      const per: number[] = [];
      const pattern: [number, number[]][] = [
        [0, [0.1, 0.1, 0.5, 0.5]], [1, [0.2, 0.2, 0.6, 0.6]],
        [0, [0.3, 0.3, 0.7, 0.7]], [1, [0.4, 0.4, 0.8, 0.8]],
      ];
      for (const [i, box] of pattern) {
        const before = decodes;
        await A.applyCropFromFullSurface(i, box, performance.now());
        await settle();
        per.push(decodes - before);
      }
      (window as any).createImageBitmap = real;
      return { decodes, per, cached: A.retainedFullCanvasCount() };
    });
    // Two photographs, four crop draws, two decodes. Each is re-decoded at most
    // once, which is what a two-frame bound buys over a one-frame one.
    expect(r.decodes).toBe(2);
    // No single draw cost two decodes, which is the other half: the second and
    // later visits were free rather than merely cheaper.
    expect(Math.max(...r.per)).toBe(1);
    expect(r.cached).toBeLessThanOrEqual(2);
  });

  test("the viewer still shows the photo, and the strip still shows a thumbnail", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    // The point of keeping a display canvas at all: the panels and the tiles
    // have something to paint. The full panel shows the photo's own File by
    // object URL, so the canvas is not on that path - the zoom panel is.
    const shown = await page.evaluate(async () => {
      const img = document.getElementById("full-img") as HTMLImageElement;
      await img.decode();
      const thumb = document.querySelector("#thumbnail-strip img") as HTMLImageElement;
      return {
        fullVisible: img.style.visibility === "visible",
        fullNatural: [img.naturalWidth, img.naturalHeight],
        thumbLoaded: !!thumb && thumb.complete && thumb.naturalWidth > 0,
      };
    });
    expect(shown.fullVisible).toBe(true);
    expect(shown.fullNatural).toEqual([4032, 3024]);
    expect(shown.thumbLoaded).toBe(true);
  });

  test("deleting a photo releases the frame it had out on loan", async ({ page }) => {
    await boot(page);
    await loadBigPhotos(page);
    await settle(page);

    const r = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      await A.applyCropFromFullSurface(0, [0.2, 0.2, 0.6, 0.6], performance.now());
      for (let i = 0; i < 400 && A.previews[0]!.pending; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      A.deletePhoto(0);
      const A2 = window.__mosqAsync!;
      return { n: A2.previews.length, retained: A2.retainedFullCanvasCount() };
    });
    expect(r.n).toBe(1);
    // The crop left the frame in the cache for the next draw on this photo;
    // deleting the photo has to take it out, or a gallery that is emptied
    // leaves the last photograph's pixels resident.
    expect(r.retained).toBe(0);
  });
});
