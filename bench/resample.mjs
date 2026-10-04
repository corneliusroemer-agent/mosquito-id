// Resample bench: the same instrumentation as bench/thumb.mjs, plus SOURCE
// pixels per drawImage.
//
// thumb.mjs counts a draw by its destination area, which is why a 50 MP ->
// 252 px downscale registers as 0.1 MP and the drawImage column said nothing
// useful while drawImage time nearly doubled. Source area is what a resample
// actually costs, and it is counted here from the arguments of each call:
// a 9-argument draw names its source rectangle, otherwise the whole element
// is read.
import { chromium } from "playwright";
// Fetched relative to the page, so the corpus never needs a CORS origin.
const ZIP = process.env.Z || "30picsload.zip";
const PORT = process.env.PORT || "4299";
const ENGINE = process.env.ENGINE || "webgpu-b16";
const OUT = process.env.OUT || "/tmp/resample.json";
const WANT = parseInt(process.env.WANT || "30", 10);
await (globalThis.__wfInit = (async () => {})());
const b = await chromium.launch({ args: ["--no-sandbox"] });
const c = await b.newContext();
await c.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { get: () => undefined });
});
await c.addInitScript(() => {
  const t = (fn, bk, pxOf) =>
    function (...a) {
      const t0 = performance.now();
      try {
        return fn.apply(this, a);
      } finally {
        bk.n++;
        bk.ms += performance.now() - t0;
        if (pxOf) bk.px += pxOf.call(this, a) || 0;
      }
    };
  const W = (window.__probe = {
    decode: { n: 0, ms: 0 },
    det: { n: 0, ms: 0 },
    clip: { n: 0, ms: 0 },
    drawImage: { n: 0, ms: 0, px: 0, srcPx: 0, bySrcPx: {} },
    getImageData: { n: 0, ms: 0, px: 0 },
    tdu: { n: 0, ms: 0, px: 0, byQ: {}, byW: {} },
    longTasks: [],
    wrapSession: null,
  });
  window.createImageBitmap = t(window.createImageBitmap, W.decode);
  const CX = CanvasRenderingContext2D.prototype;
  // Destination pixels (what thumb.mjs counted) and SOURCE pixels (what the
  // draw actually costs) both, because the two disagree by three orders of
  // magnitude on a 50 MP photograph.
  //
  // Only the NINE-argument form names a source rectangle; at indices 3 and 4.
  // The five-argument form is (src, dx, dy, dw, dh) - those are DESTINATION
  // extents, and reading them as source extents silently undercounts a 50 MP
  // read into a 1024 px intermediate as 0.8 MP, which is the mistake this whole
  // measurement exists to avoid repeating.
  const srcArea = (a) => {
    const src = a[0];
    if (!src) return 0;
    if (a.length >= 9) return (a[3] || 0) * (a[4] || 0);
    const w = src.naturalWidth || src.width || 0;
    const h = src.naturalHeight || src.height || 0;
    return w * h;
  };
  const realDraw = CX.drawImage;
  CX.drawImage = function (...a) {
    const t0 = performance.now();
    try {
      return realDraw.apply(this, a);
    } finally {
      const W2 = window.__probe.drawImage,
        ms = performance.now() - t0;
      const dest = this.canvas ? this.canvas.width * this.canvas.height : 0;
      const src = srcArea(a);
      W2.n++;
      W2.ms += ms;
      W2.px += dest;
      W2.srcPx += src;
      // Bucket by order of magnitude, so "where the reads are" is visible.
      const m = Math.floor(Math.log2(Math.max(1, src)));
      const key = "2^" + m;
      const b2 =
        W2.bySrcPx[key] || (W2.bySrcPx[key] = { n: 0, srcMP: 0, ms: 0 });
      b2.n++;
      b2.srcMP += src / 1e6;
      b2.ms += ms;
    }
  };
  CX.getImageData = t(CX.getImageData, W.getImageData, function (a) {
    return (a[2] || 0) * (a[3] || 0);
  });
  const o = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    const q = a[1] === undefined ? "def" : String(a[1]);
    const t0 = performance.now();
    try {
      return o.apply(this, a);
    } finally {
      W.tdu.n++;
      W.tdu.ms += performance.now() - t0;
      W.tdu.px += this.width * this.height;
      const b2 = W.tdu.byQ[q] || (W.tdu.byQ[q] = { n: 0, ms: 0, px: 0 });
      b2.n++;
      b2.ms += performance.now() - t0;
      b2.px += this.width * this.height;
      const w = this.width + "x" + this.height;
      const b3 = W.tdu.byW[w] || (W.tdu.byW[w] = { n: 0, px: 0 });
      b3.n++;
      b3.px += this.width * this.height;
    }
  };
  W.wrapSession = (s, bk) => {
    if (!s || s.__w) return;
    const f = s.run.bind(s);
    s.__w = 1;
    s.run = async (feeds) => {
      const t0 = performance.now();
      try {
        return await f(feeds);
      } finally {
        bk.n++;
        bk.ms += performance.now() - t0;
      }
    };
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        W.longTasks.push({ s: e.startTime, d: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
});
await c.addInitScript(
  `window.__WFON = ${process.env.WF === "off" ? "false" : "true"};`,
);
const p = await c.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
await p.goto("http://127.0.0.1:" + PORT + "/?engine=" + ENGINE, {
  waitUntil: "domcontentloaded",
});
await p.waitForFunction(() => window.modelsReady === true, null, {
  timeout: 300000,
});
console.log("READY zip=" + ZIP);
await p.evaluate(() => {
  const A = window.__mosqAsync;
  window.__probe.wrapSession(A.sessDet, window.__probe.det);
  window.__probe.wrapSession(A.sessClip, window.__probe.clip);
});

const r = await p.evaluate(
  async ({ zip, WANT }) => {
    window.__WF = window.__WFON !== false;
    const A = window.__mosqAsync;
    const blob = await (await fetch(zip)).blob();
    const file = new File([blob], "b.zip", { type: "application/zip" });
    const chk = document.getElementById("chk-whole-frame");
    if (chk && chk.checked !== window.__WF) {
      chk.checked = window.__WF;
      chk.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
    }
    const W = window.__probe;
    for (const k of ["decode", "det", "clip", "drawImage", "getImageData"]) {
      W[k].n = 0;
      W[k].ms = 0;
      W[k].px = 0;
    }
    W.drawImage.srcPx = 0;
    W.drawImage.bySrcPx = {};
    W.tdu.n = 0;
    W.tdu.ms = 0;
    W.tdu.px = 0;
    W.tdu.byQ = {};
    W.tdu.byW = {};
    W.longTasks = [];
    W.wrapSession(window.__mosqAsync.sessDet, W.det);
    W.wrapSession(window.__mosqAsync.sessClip, W.clip);

    const t0 = performance.now();
    A.processFiles([file]);
    const deadline = t0 + 12 * 60_000;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const n = A.previews.length;
      const settled = A.previews.filter((x) => !x.pending && !x.error).length;
      if (n >= WANT && settled >= WANT) break;
    }
    const tSettled = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    const inf = W.det.ms + W.clip.ms;
    const wall = performance.now() - t0;
    const lt = W.longTasks.filter((x) => x.d >= 50);
    return {
      wall: Math.round(wall),
      tSettled: Math.round(tSettled),
      infMs: Math.round(inf),
      nonInferMs: Math.round(wall - inf),
      nonInferPct: Math.round((1000 * (wall - inf)) / wall) / 10,
      inferPct: Math.round((1000 * inf) / wall) / 10,
      detN: W.det.n,
      detMs: Math.round(W.det.ms),
      clipN: W.clip.n,
      clipMs: Math.round(W.clip.ms),
      drawN: W.drawImage.n,
      drawMs: Math.round(W.drawImage.ms),
      drawMP: Math.round(W.drawImage.px / 1e6),
      tduN: W.tdu.n,
      tduMs: Math.round(W.tdu.ms),
      tduMP: Math.round(W.tdu.px / 1e6),
      tduByQ: Object.fromEntries(
        Object.entries(W.tdu.byQ).map(([q, v]) => [
          q,
          { n: v.n, mp: Math.round(v.px / 1e6), ms: Math.round(v.ms) },
        ]),
      ),
      tduByW: Object.fromEntries(
        Object.entries(W.tdu.byW).map(([w, v]) => [
          w,
          { n: v.n, mp: Math.round(v.px / 1e6) },
        ]),
      ),
      ltSum: Math.round(lt.reduce((a, x) => a + x.d, 0)),
      ltN: lt.length,
      n: A.previews.length,
      settled: A.previews.filter((x) => !x.pending && !x.error).length,
      drawSrcMP: Math.round(W.drawImage.srcPx / 1e6),
      drawSrcMPPerPhoto:
        Math.round(
          (W.drawImage.srcPx / 1e6 / Math.max(1, A.previews.length)) * 100,
        ) / 100,
      drawBySrc: Object.fromEntries(
        Object.entries(W.drawImage.bySrcPx).map(([k, v]) => [
          k,
          { n: v.n, srcMP: Math.round(v.srcMP), ms: Math.round(v.ms) },
        ]),
      ),
    };
  },
  { zip: ZIP, WANT },
);

const fs = await import("node:fs");
fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1));
await b.close();
