import { test as base, expect, type Page } from "@playwright/test";

/**
 * The test seam.
 *
 * `main.js` is an ES module, so nothing in it is reachable by bare name from the
 * page. `window.__mosqAsync` is what the app itself publishes for probes, and it
 * is the ONLY way these tests reach the render path: the predecessor of this seam
 * drove the app through bare globals (`previews`, `renderThumbnails`), which kept
 * working while `main.js` was a classic script and silently reached nothing once
 * it was bundled. Every helper below goes through it.
 */
export interface MosqAsync {
  last: unknown;
  frames: number;
  longTasks: number;
  worstLongTaskMs: number;
  previews: any[];
  sessClip: unknown;
  sessDet: unknown;
  /**
   * The app's per-engine session cache. Writing an entry for an engine makes a
   * switch to it take `loadWebGPUModels`'s already-loaded branch, so the switch
   * runs for real - head, session and footer rebound - with no model download.
   */
  clipSessions: Record<string, { sess: unknown; ep: string }>;
  selectedIndex: number;
  includedIndices: Set<number>;
  /**
   * The idle-release controller (#36). A tier-1 spec drives a release through
   * `releaseNow()` rather than faking `document.visibilityState` and waiting out
   * the 60 s grace period; the grace period itself is unit-tested.
   */
  idleRelease: {
    released(): boolean;
    releaseNow(): Promise<void>;
    ensure(): Promise<void>;
    hidden(): void;
    visible(): void;
  };
  /** How many times a lazy restore has been entered. Tier 1 aborts the weights
   *  fetch, so "the restore was reached" is the only thing observable. */
  idleRestoreAttempts: number;
  /** The engine whose weights are currently bound, or null when none are. */
  loadedClipEngine: string | null;
  /** The app's "an engine is loaded and usable" flag. */
  modelsReady: boolean;
  embeds: any;
  verdictFrom: (spP: number[], agreement: unknown, adP: number[], nuP?: number[]) => any;
  verdictSentence: (v: any) => string;
  selectPhoto: (i: number) => void;
  processFiles: (files: FileList | File[]) => Promise<void>;
  deletePhoto: (i: number) => void;
  /** The engine re-run's photo-set narrowing, or null. See `main.js` ASYNC. */
  rerunPhotos: Set<any> | null;
  renderThumbnails: () => void;
  renderActivePhoto: () => void;
  updatePooling: () => void;
  renderResultsTable: () => void;
  downloadCSV: () => void;
}

declare global {
  interface Window {
    __mosqAsync?: MosqAsync;
    __mosqCls?: number;
    __mosqShiftCount?: number;
    /** One line per shift: value plus what moved. A CLS failure must say what moved. */
    __mosqShiftLog?: string[];
    /** The app's own "engine settled" flag. False once a load has failed. */
    modelsReady?: boolean;
  }
}

/**
 * Abort the classifier, let everything else through.
 *
 * The 1.26 GB BioCLIP 2.5 model and the YOLO detector are the only things that
 * cost a download, and Tier 1 must never pay it. `text_embeds*.json` is NOT
 * aborted: it is 673 KB and every layout and pooling assertion runs on the
 * shipped label list and embeddings, so aborting it would make the measurement
 * meaningless (and is what the old suite did).
 */
export async function stubModel(page: Page): Promise<void> {
  await page.route("**/*.onnx", (r) => r.abort());
  await page.route("**/*.r2.dev/**", (r) => r.abort());
}

/**
 * Console noise that is the STUB's doing, not the app's.
 *
 * Tier 1 aborts every model request, so the browser logs a failed load for each
 * one and `initEngine` catches the failure and logs its own. Both are the tier
 * working as designed. Filtering them is narrow on purpose: a blanket "ignore
 * failed to fetch" would also swallow a genuine 404 on `text_embeds.json`, which
 * is exactly the kind of breakage this tier exists to catch.
 */
const EXPECTED_STUB_NOISE =
  /net::ERR_FAILED|net::ERR_ABORTED|Engine initialization error.*Failed to fetch|Engine switch failed.*Failed to fetch|Failed to fetch|onnx|r2\.dev/i;

export async function boot(page: Page, url = "/"): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  (page as any).__errors = errors;
  await stubModel(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__mosqAsync?.renderThumbnails, null, { timeout: 15_000 });
}

/**
 * Console/page errors since `boot`, minus the stub's own noise.
 *
 * A pageerror is NEVER filtered: an uncaught exception is a real defect whether
 * or not a model was stubbed, and `main.js` is a `.js` file, which is exactly why
 * `tsc --noEmit` cannot catch a missing import in it - the module only fails when
 * the path is actually taken.
 */
export function errors(page: Page): string[] {
  const all = ((page as any).__errors as string[]) ?? [];
  return all.filter((e) => !e.startsWith("console:") || !EXPECTED_STUB_NOISE.test(e));
}

export function expectNoErrors(page: Page): void {
  const e = errors(page);
  expect(e, `page reported errors: ${e.join(" | ")}`).toHaveLength(0);
}

/**
 * What a populated photo looks like to the app.
 *
 * `state` is the verdict the photo should carry, and it is produced by the
 * SHIPPED gate (`__mosqAsync.verdictFrom`) from a posterior built here - never
 * written in by hand. A test that hand-writes `{state: "species", genus: "Aedes"}`
 * is asserting against a fixture it invented, and it would keep passing if
 * `verdictFrom` stopped producing that state at all. Building a posterior and
 * letting the real gate decide means a change to a floor shows up here as a
 * different verdict.
 */
export interface PhotoSpec {
  name: string;
  state: "species" | "genus" | "unsure" | "non-mosquito";
  /** Species index within the shipped label list. Defaults to a per-name choice. */
  species?: string;
  /** Adjacent (non-mosquito) class name, for the `non-mosquito` state. */
  adjacent?: string;
  /** Peak posterior for the chosen species. Defaults per state. */
  top?: number;
  /** Adjacent mass, for the `non-mosquito` state. */
  adjTop?: number;
  /**
   * Nuisance class NAME, for a `non-mosquito` state tripped by the nuisance block
   * rather than the adjacent one - a photograph of a wall, a hand, a plant.
   *
   * The two are separate states to the user even though they share
   * `state: "non-mosquito"`: a midge is a finding and is named as one, a wall is
   * an absence and is reported as one. `nuTop` carries the mass, the same way
   * `adjTop` does for the adjacent block.
   */
  nuisance?: string;
  /** Nuisance mass, for a nuisance-block `non-mosquito`. */
  nuTop?: number;
  pending?: boolean;
  error?: string | null;
  is_cropped?: boolean;
}

const SPECIES_BY_NAME: Record<string, string> = {
  aegypti: "Aedes aegypti",
  albopictus: "Aedes albopictus",
  pipiens: "Culex pipiens",
  annulata: "Culiseta annulata",
  maculipennis: "Anopheles maculipennis",
};

/** A canvas the tile thumbnails can be drawn from, at phone-photo size. */
const MAKE_CANVAS_SRC = `
function makeCanvas(w, h, hue, label) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "hsl(" + hue + ", 45%, 58%)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(w * 0.25, h * 0.25, w * 0.5, h * 0.5);
  ctx.fillStyle = "#fff";
  ctx.font = Math.round(w / 20) + "px sans-serif";
  ctx.fillText(label, 20, Math.round(h / 12));
  return cv;
}
`;

/**
 * Install `n` populated photos and render them.
 *
 * With an empty `specs`, this seeds the shipped head onto `A.embeds` and draws
 * an empty gallery - which is how a test that needs the head but supplies its own
 * photos gets one without fetching and binding it a second time.
 *
 * The photos carry the fields every render function reads - `detail`, `scores`,
 * `logits`, `adP`, `adjacentDetail`, `verdict` - so `updatePooling` runs the
 * real `splitPoolable`/`aggregateLogits`/`pooledVerdict` chain rather than
 * something a test wrote. `logits` are placed on the log-posterior axis, which
 * is where the pooled softmax expects them and is shift-invariant, so the pooled
 * card shows real relative bars rather than a wall of identical ones.
 *
 * The body is a STRING, not a function literal. `page.evaluate` serializes the
 * function it is given, so it cannot close over module scope - a helper defined
 * next to this one is simply undefined inside the page. `makeCanvas` is inlined
 * and `new Function`'d for that reason, not for speed.
 *
 * Run this only on a booted page: it assumes `__mosqAsync` exists and that
 * `text_embeds.json` is reachable (it is NOT aborted - see `stubModel`).
 */
export interface PopulateOptions {
  /**
   * Which head to load, by filename. Defaults to the H/14 head, which is what
   * the page loads on its own.
   *
   * Set it to `text_embeds_culico.json` to exercise a head whose rows are
   * byte-identical in places - what the app may and may not name differs per
   * head, so a test that only ever loads H/14 cannot see that difference at all.
   */
  embeds?: string;
}

export async function populate(page: Page, specs: PhotoSpec[], opts: PopulateOptions = {}): Promise<void> {
  const body = `
    const specs = ${JSON.stringify(specs)};
    const EMBEDS_FILE = ${JSON.stringify(opts.embeds ?? "text_embeds.json")};
    ${MAKE_CANVAS_SRC}
    (async () => {
    const A = window.__mosqAsync;
    const emb = await fetch(EMBEDS_FILE).then((r) => r.json());
    for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
    A.embeds = emb;

    const N = emb.species.length;
    const ADJ = emb.adjacent.length;
    const NUI = emb.nuisance.length;

    /** Posterior peaked on one species, the remainder spread evenly. */
    const peaked = (idx, top) => {
      const p = new Array(N).fill((1 - top) / (N - 1));
      p[idx] = top;
      return p;
    };
    /** Adjacent posterior concentrated on one class; the rest are exactly zero. */
    const adjacentP = (idx, top) => {
      const p = new Array(ADJ).fill(0);
      p[idx] = top;
      return p;
    };
    /** Nuisance posterior concentrated on one class; the rest are exactly zero. */
    const nuisanceP = (idx, top) => {
      const p = new Array(NUI).fill(0);
      p[idx] = top;
      return p;
    };

    const built = specs.map((spec, i) => {
      const hue = (i * 47) % 360;
      const full = makeCanvas(2400, 1800, hue, spec.name.slice(0, 6));
      const crop = makeCanvas(900, 900, (hue + 20) % 360, spec.name.slice(0, 4));

      const sname = spec.species ?? (i % 3 === 0 ? "Aedes aegypti" : "Culex pipiens");
      const sidx = emb.species.indexOf(sname);
      if (sidx < 0) throw new Error("fixture names a species the shipped head lacks: " + sname);

      // Per state: a posterior and an adjacent vector the floors turn into that
      // state. What the photo ends up carrying is the app's own gate's answer, not
      // one written here.
      //
      // These clear floorsFor(webgpu-fp16), which is what the app runs these
      // against. Species and genus are 0.80/0.90 on H/14 since 2026-10-04, where
      // they used to be the shipped 0.373/0.80. A default below the floor does not
      // fail loudly - the photo silently arrives as unsure, and the pooling
      // arithmetic under test is then measured over a different set.
      const DEFAULTS = { species: 0.86, genus: 0.94, unsure: 0.12, "non-mosquito": 0.2 };
      const top = spec.top ?? (DEFAULTS[spec.state] ?? 0.5);
      const spP = peaked(sidx, top);

      let adP = [];
      let nuP = [];
      if (spec.state === "non-mosquito") {
        if (spec.nuisance) {
          // The nuisance block carries its own mass and clears its own floor,
          // which is a different number from the adjacent one - see Floors.
          const nidx = emb.nuisance.indexOf(spec.nuisance);
          if (nidx < 0) throw new Error("fixture names a nuisance class the head lacks: " + spec.nuisance);
          nuP = nuisanceP(nidx, spec.nuTop ?? 0.9);
        } else {
          const aname = spec.adjacent ?? emb.adjacent[0];
          const aidx = emb.adjacent.indexOf(aname);
          if (aidx < 0) throw new Error("fixture names an adjacent class the head lacks: " + aname);
          adP = adjacentP(aidx, spec.adjTop ?? 0.93);
        }
      }

      const detail = Object.fromEntries(emb.species.map((s, j) => [s, spP[j]]));
      // Genus scores are the species posterior summed by genus prefix.
      const scores = {};
      for (const [s, p] of Object.entries(detail)) {
        const g = s.split(" ")[0];
        scores[g] = (scores[g] ?? 0) + p;
      }
      // log-posterior axis: consistent with scores, so aggregateAdjacent can
      // recover logZ from the species side and the pool can compare the two.
      const logits = Object.fromEntries(
        emb.species.map((s, j) => [s, Math.log(Math.max(spP[j], 1e-9))]),
      );

      const p = {
        name: spec.name,
        fullCanvas: full,
        cropCanvas: crop,
        contextCanvas: full,
        detail,
        scores,
        logits,
        adP: adP.length ? adP : null,
        adjacentDetail: adP.length
          ? Object.fromEntries(emb.adjacent.map((a, j) => [a, adP[j]]).filter(([, v]) => v > 0))
          : null,
        nuP: nuP.length ? nuP : null,
        verdict: null,
        pending: spec.pending ?? false,
        error: spec.error ?? null,
        is_cropped: spec.is_cropped ?? true,
        crop_rejected: false,
        status: spec.error ? "failed" : "ok",
        rev: 0,
        agreement: null,
        viewsLanded: 0,
        viewsTotal: 0,
        fingerprint: "fp_" + i,
        manual_full_photo: false,
      };
      // The real gate's answer, not ours - and the nuisance posteriors go with it,
      // because the gate reads that block and the seam drops nothing.
      p.verdict = A.verdictFrom(spP, null, adP, nuP);
      return p;
    });

    A.previews.length = 0;
    A.includedIndices.clear();
    for (const p of built) A.previews.push(p);
    for (let i = 0; i < built.length; i++) A.includedIndices.add(i);
    A.selectedIndex = 0;

    // What processFiles does when the first batch lands. The gallery sections are
    // display:none in index.html and only processFiles unhides them, so there is
    // no seam that reaches this - it is one line of setup, not a re-implementation
    // of the batch path.
    document.getElementById("gallery-section").style.display = "block";
    document.getElementById("results-table-section").style.display = "block";
    A.renderThumbnails();
    A.renderActivePhoto();
    A.updatePooling();
    A.renderResultsTable();
    // Two frames is not enough. The tile images are handed a data URL and the
    // browser decodes them on its own schedule, and a tile that grows to its
    // decoded size pushes the footer down - a layout shift charged to whoever
    // happens to be measuring. Waiting for every tile image to finish decoding is
    // what makes a later CLS reading mean "the app moved something", not "an
    // <img> finished loading".
    await Promise.all(
      Array.from(document.querySelectorAll<HTMLImageElement>("#thumbnail-strip img")).map((img) =>
        img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise((r) => {
              img.addEventListener("load", () => r(null), { once: true });
              img.addEventListener("error", () => r(null), { once: true });
            }),
      ),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    })();
  `;
  // The indirection through `new Function` is what lets the body be a string with
  // its helpers inlined, rather than a closure that cannot cross into the page.
  await page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    return (0, eval)(src);
  }, body);
}

/**
 * Start counting layout shifts before anything is on screen.
 *
 * `hadRecentInput` shifts are excluded, which is what the CLS standard does: a
 * layout change the user caused by tapping is not an instability. Everything
 * left over is the app moving something under the user on its own.
 */
export async function startCls(page: Page): Promise<void> {
  // Installed ONCE per page. A second `observe({buffered: true})` replays every
  // entry the browser has buffered since load - including the shift that happened
  // before the reset - so re-installing the observer on reset silently charges
  // the pre-reset shift to whatever is being measured afterwards. This is the
  // whole trap in one line: reset the numbers, never the observer.
  await page.evaluate(() => {
    if ((window as any).__mosqClsObserver) return;
    window.__mosqCls = 0;
    window.__mosqShiftCount = 0;
    window.__mosqShiftLog = [];
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        // `hadRecentInput` shifts are the standard's own exclusion: a layout
        // change the user caused by tapping is not an instability.
        if (e.hadRecentInput) continue;
        window.__mosqCls! += e.value;
        window.__mosqShiftCount!++;
        // A CLS number with no source is not diagnosable, and a CLS assertion
        // that fails without saying what moved gets ignored.
        const src = (e.sources ?? [])
          .map((s: any) => {
            const n = s.node as Element | null;
            if (!n) return "(detached)";
            const id = n.id ? `#${n.id}` : "";
            const cls =
              n.className && typeof n.className === "string"
                ? `.${n.className.trim().split(/\s+/).slice(0, 2).join(".")}`
                : "";
            return `${n.tagName.toLowerCase()}${id}${cls}`;
          })
          .join(" <- ");
        window.__mosqShiftLog!.push(`+${e.value.toFixed(5)} ${src || "(no source)"}`);
      }
    });
    // `buffered: false`: only shifts from here on. The alternative replays history.
    obs.observe({ type: "layout-shift", buffered: false });
    (window as any).__mosqClsObserver = obs;
  });
}

/**
 * Zero the CLS counter.
 *
 * Call this once the gallery is up and laid out, before measuring. Revealing a
 * `display:none` gallery is one large shift, and it belongs to the harness's setup
 * rather than to the app: `index.html` ships the gallery hidden and only
 * `processFiles` unhides it, so every photo in the very first batch is measured
 * against a section that was not there a frame earlier.
 * `tests/full-photo-contain-probe.mjs` zeroes the counter at exactly this point
 * and says so; the two measurements are meant to be comparable.
 */
export async function resetCls(page: Page): Promise<void> {
  await startCls(page);
  await page.evaluate(() => {
    window.__mosqCls = 0;
    window.__mosqShiftCount = 0;
    window.__mosqShiftLog = [];
  });
}

export function readCls(page: Page): Promise<number> {
  return page.evaluate(() => window.__mosqCls ?? 0);
}

/**
 * Wait for the app's queued render to have painted.
 *
 * Two animation frames cover `afterNextPaint` and any render already queued. It
 * deliberately does NOT wait for image decoding - use `resetCls` after a
 * `populate` when the reading has to exclude decode-driven growth, and see the
 * note there.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

/** `settle`, plus every tile thumbnail decoded. The state a CLS reading needs. */
export async function settleDecoded(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(document.querySelectorAll<HTMLImageElement>("#thumbnail-strip img")).map((img) =>
        img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise((r) => {
              img.addEventListener("load", () => r(null), { once: true });
              img.addEventListener("error", () => r(null), { once: true });
            }),
      ),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
  });
}

export const test = base;
export { expect };