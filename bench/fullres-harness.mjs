// Full-resolution retention and revisit latency, measured over the real app.
//
// Why this file exists: the numbers in the commit message ("1556 -> 764 MB",
// "82-99 ms") came from a harness that was not committed, so nobody could
// re-run them or check them. This is that harness.
//
//   node bench/fullres-harness.mjs                 # local engine, alternating clicks
//   node bench/fullres-harness.mjs --photos 20     # gallery size (default 20)
//   node bench/fullres-harness.mjs --engine server # the server-gpu batch path
//   node bench/fullres-harness.mjs --pattern once   # first-visit only (the
//                                                  # pattern that flatters a cache)
//
// It boots the built app the way the tier-1 e2e does - the same dist, the same
// faked sessions - so what is measured is the shipped intake and the shipped
// record, not a re-implementation of them. No model is downloaded: the detector
// and the classifier are stubbed with a tensor of the shape the shipped decoders
// read, which is what makes the number about RETENTION rather than about
// inference quality.
//
// Two figures, and they are not the same figure:
//
//   retained MB   the canvases on the photo records, counted by identity, so one
//                 canvas under three names is one canvas. This is the number the
//                 change is about.
//   revisit ms    wall time for one crop draw on a photo that has already been
//                 drawn on. This is the cost the cache exists to avoid, and it is
//                 only meaningful for the photos that are still in the cache.
//
// The alternating pattern is the default and the one that matters: A -> B -> A ->
// B is what comparing two photographs does, and it is the pattern under which a
// cache holding one frame re-decodes on every single visit.
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const N_PHOTOS = parseInt(arg("photos", "20"), 10);
const ENGINE = arg("engine", "local");
const PATTERN = arg("pattern", "alternating");
const PORT = parseInt(arg("port", process.env.MOSQ_E2E_PORT ?? "4199"), 10);
const BASE = arg("base", `http://127.0.0.1:${PORT}`);

const FULL_W = 4032, FULL_H = 3024;
const mb = (w, h) => +((w * h * 4) / 1048576).toFixed(2);

// `launchServer` rather than `launch` because only the server form exposes the
// browser's PID, and the renderer RSS is read by walking the process tree from
// it. `Browser.process()` does not exist on the `launch` form.
const server = await chromium.launchServer({ args: ["--no-sandbox"] });
const BROWSER_PID = server.process().pid;
const browser = await chromium.connect(server.wsEndpoint());
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { get: () => undefined });
});

// Tier 1's stub: no model is ever downloaded by this harness.
await ctx.route("**/*.onnx", (r) => r.abort());
await ctx.route("**/*.r2.dev/**", (r) => r.abort());

const page = await ctx.newPage();

if (ENGINE === "server") {
  // The server-gpu batch path asks /api/predict for three data URLs per photo
  // and decodes each into its own canvas - which is exactly what finding 4 is
  // about, so the stub answers with real JPEG data URLs at the photograph's own
  // dimensions rather than with something cheap.
  //
  // The payload is built on a blank page first: the routes have to be in place
  // before the app boots, because /api/health is probed during init and an
  // engine that reports unusable makes `processFiles` refuse the batch - which
  // reads as an empty gallery rather than as a failed run.
  const mk = async (w, h, hue) => page.evaluate(async ([w, h, hue]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    for (let y = 0; y < h; y += 128) {
      for (let xx = 0; xx < w; xx += 128) {
        x.fillStyle = `hsl(${(xx + y + hue) % 360},50%,40%)`;
        x.fillRect(xx, y, 128, 128);
      }
    }
    return c.toDataURL("image/jpeg", 0.85);
  }, [w, h, hue]);

  const UNCROPPED = argv.includes("--server-uncropped");
  const full = await mk(FULL_W, FULL_H, 0);
  // With the server's detection finding nothing, the crop and the context ARE
  // the whole frame - the same data URL, sent three times, which is the case the
  // aliasing in `aliasesWholeFrame` exists for.
  const crop = UNCROPPED ? full : await mk(1200, 900, 40);
  const context = UNCROPPED ? full : await mk(1600, 1200, 80);
  const payload = {
    filename: "server.jpg", engine_label: "stub", status: "ok",
    fullDataUrl: full, cropDataUrl: crop, contextDataUrl: context,
    fullWidth: FULL_W, fullHeight: FULL_H,
    cropBox: UNCROPPED ? null : [500, 400, 1700, 1300],
    contextBox: [200, 100, 2200, 1700],
    is_cropped: !UNCROPPED, crop_rejected: false,
    labels: { Aedes: 0.9 }, detail: { Aedes: 0.9 }, logits: { Aedes: 0.9 },
    adP: {}, adjacentDetail: {}, detTime: 1, clipTime: 1, totalTime: 2,
  };

  await ctx.route("**/api/health", (r) => r.fulfill({ status: 200, body: "{}" }));
  await ctx.route("**/api/predict", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }));
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__mosqAsync?.renderThumbnails, null, { timeout: 20_000 });

if (ENGINE === "server") {
  // `?engine=server-gpu` does not work: `selectable()` returns false for
  // server-gpu unconditionally, so a URL parameter cannot select it. The engine
  // is switched through the dropdown, which is also the only route through which
  // `serverAvailable` from the health probe is consulted.
  await page.waitForFunction(() => !!window.modelsReady || !!document.getElementById("engine-select"), null,
                             { timeout: 20_000 });
  await page.evaluate(() => {
    const sel = document.getElementById("engine-select");
    sel.value = "server-gpu";
    sel.dispatchEvent(new Event("change"));
  });
  await page.waitForFunction(() => window.modelsReady === true, null, { timeout: 20_000 });
}

await page.evaluate(() => {
  const w = window;
  if (!w.ort) {
    w.ort = { Tensor: class { constructor(_t, data, dims) { this.data = data; this.dims = dims; } } };
  }
});

/** The stubbed sessions, plus `n` photographs built by the page's own canvas. */
await page.evaluate(async ([n, engine]) => {
  const A = window.__mosqAsync;
  // The head is needed on BOTH engines: the server path fuses the server's
  // response through the same `serverView`, which reads the module's EMB. Without
  // it the batch commits a classification error rather than a photo.
  const embeds = await fetch("text_embeds.json").then((r) => r.json());
  for (const k of ["species_emb", "nuisance_emb"]) embeds[k] = Float32Array.from(embeds[k]);
  A.embeds = embeds;
  if (engine === "local") {
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        const N = 8400;
        const d = new Float32Array(5 * N);
        d[0] = 320; d[N] = 240; d[2 * N] = 900; d[3 * N] = 800; d[4 * N] = 0.9;
        return { output0: { dims: [1, 5, N], data: d } };
      },
    };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim;
        return { embedding: { dims: [1, dim], data: Float32Array.from(A.embeds.species_emb.slice(0, dim)) } };
      },
    };
    A.clipSessions["webgpu-fp16"] = { sess: A.sessClip, ep: "wasm" };
  }

  const files = [];
  for (let i = 0; i < n; i++) {
    const cv = document.createElement("canvas");
    cv.width = 4032; cv.height = 3024;
    const x = cv.getContext("2d");
    for (let y = 0; y < 3024; y += 96) for (let xx = 0; xx < 4032; xx += 96) {
      x.fillStyle = `hsl(${(xx + y + i * 40) % 360},50%,${30 + ((xx / 96 + y / 96) % 40)}%)`;
      x.fillRect(xx, y, 96, 96);
    }
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.9));
    files.push(new File([blob], `big_${i}.jpg`, { type: "image/jpeg" }));
  }
  const t0 = performance.now();
  await A.processFiles(files);
  window.__batchMs = performance.now() - t0;
}, [N_PHOTOS, ENGINE]);

const retained = async () => page.evaluate(() => {
  const P = window.__mosqAsync.previews;
  const KEYS = ["displayCanvas", "cropCanvas", "contextCanvas", "sourceCanvas"];
  let distinct = 0, MB = 0;
  const perPhoto = [];
  for (const p of P) {
    const seen = new Set();
    for (const k of KEYS) if (p[k]) seen.add(p[k]);
    let m = 0;
    for (const c of seen) m += (c.width * c.height * 4) / 1048576;
    distinct += seen.size; MB += m; perPhoto.push(+m.toFixed(2));
  }
  return {
    n: P.length,
    shapes: P.map((p) => KEYS.filter((k) => p[k])
      .map((k) => `${k}:${p[k].width}x${p[k].height}`)),
    distinctCanvases: distinct,
    retainedMB: +MB.toFixed(1),
    perPhotoMB: perPhoto,
    cachedFrames: window.__mosqAsync.retainedFullCanvasCount(),
  };
});

/**
 * The browser PROCESS's resident set, and the page's JS heap.
 *
 * The canvas bytes are counted against the renderer, so `performance.memory`
 * under-reports them on every engine that does not account canvas backing
 * stores. The process RSS is the honest figure and is what a user would see in
 * Activity Monitor; the heap is reported alongside because it is the narrower
 * claim, and the two moving together is the evidence that the first is not just
 * the second plus overhead.
 */
/**
 * Resident set of THIS browser's renderer processes, in MB.
 *
 * The canvas bytes live in the renderer and `performance.memory` does not count
 * them on every engine, so the JS heap under-reports the thing being measured.
 * The renderer RSS is what a user would see in Activity Monitor, and it is
 * measured by walking the process tree from this browser's own PID: several
 * agents run browsers on this box, so "the chrome processes" is not a
 * measurement, it is a race.
 */
const rendererRSSMB = async () => {
  const { execSync } = await import("node:child_process");
  const rows = execSync("ps -eo pid=,ppid=,rss=,args=", { encoding: "utf8" })
    .split("\n").filter(Boolean)
    .map((l) => {
      const [pid, ppid, rssKb, ...rest] = l.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), rssKb: Number(rssKb), args: rest.join(" ") };
    });
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  // Everything under the browser pid, at any depth: the renderer is a grandchild.
  const mine = [];
  const walk = (pid) => { for (const c of byParent.get(pid) ?? []) { mine.push(c); walk(c.pid); } };
  walk(BROWSER_PID);
  const renderers = mine.filter((r) => r.args.includes("--type=renderer"));
  const sum = renderers.reduce((a, r) => a + r.rssKb, 0);
  return renderers.length ? { mb: +(sum / 1024).toFixed(1), processes: renderers.length } : null;
};

const rss = async () => ({
  rendererRSS: await rendererRSSMB(),
  pageHeapMB: await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)
    .then((v) => (v ? +(v / 1048576).toFixed(1) : null)),
});

/** One crop draw, timed, with the decodes it caused counted separately. */
const cropOnce = async (idx, frac) => page.evaluate(async ([idx, frac]) => {
  const A = window.__mosqAsync;
  if (!A.applyCropFromFullSurface) return { ms: 0, decodes: 0, skipped: "no crop-release path on this build" };
  let decodes = 0;
  const real = window.createImageBitmap.bind(window);
  window.createImageBitmap = async (src, opts) => {
    if (src instanceof File) decodes++;
    return real(src, opts);
  };
  const t0 = performance.now();
  await A.applyCropFromFullSurface(idx, frac, performance.now());
  for (let i = 0; i < 600 && A.previews[idx].pending; i++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  const ms = performance.now() - t0;
  window.createImageBitmap = real;
  return { ms, decodes };
}, [idx, frac]);

const out = { engine: ENGINE, pattern: PATTERN, photos: N_PHOTOS, photoDims: [FULL_W, FULL_H] };

out.afterBatch = await retained();
if (out.afterBatch.n === 0) {
  out.diagnose = await page.evaluate(() => ({
    engine: window.__mosqAsync.engine?.() ?? null,
    modelsReady: window.modelsReady,
    err: (window.__mosqAsync.previews || []).map((p) => p.error ?? null),
    keys: (window.__mosqAsync.previews || []).map((p) => Object.keys(p).filter((k) => /[Cc]anvas/.test(k))),
    progress: document.getElementById("progress")?.textContent ?? null,
  }));
}
out.afterBatch.cachedFrames = out.afterBatch.cachedFrames;
out.memAfterBatch = await rss();
out.batchMs = await page.evaluate(() => window.__batchMs ?? null);

// Revisit latency. `alternating` walks A,B,A,B...; `once` visits each photo a
// single time. Both are crop draws on photographs already in the gallery.
const visits = [];
const order = PATTERN === "once"
  ? Array.from({ length: N_PHOTOS }, (_, i) => i)
  : Array.from({ length: N_PHOTOS * 2 }, (_, i) => i % Math.min(2, N_PHOTOS));
for (const i of order) {
  if (out.afterBatch.n === 0) break;
  const v = await cropOnce(i, [0.15, 0.15, 0.6, 0.6]);
  visits.push({ photo: i, ...v });
}
out.visits = visits;
out.revisitMs = visits.map((v) => +v.ms.toFixed(1));
out.totalDecodesDuringVisits = visits.reduce((a, v) => a + v.decodes, 0);
const later = visits.filter((_, i) => i > 0).map((v) => v.ms);
out.revisitMedianMs = later.length
  ? +later.slice().sort((a, b) => a - b)[Math.floor(later.length / 2)].toFixed(1)
  : null;
out.afterVisits = await retained();
out.memAfterVisits = await rss();

console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
