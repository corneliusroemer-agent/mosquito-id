// Thumb-perf bench. Same instrumentation as the 2026-10-04-js-perf diag2.mjs,
// plus a capture of every tile <img>'s src at the end of the batch so the
// before/after thumbnails can be compared pixel-wise.
import { chromium } from "playwright";
const ZIP = process.env.Z || "/30picsload.zip";
const OUT = process.env.OUT || "/tmp/bench.json";
const WANT = parseInt(process.env.WANT || "30", 10);
await (globalThis.__wfInit = (async () => {})());
const b = await chromium.launch({ args: ["--no-sandbox"] });
const c = await b.newContext();
await c.addInitScript(() => { Object.defineProperty(navigator, "gpu", { get: () => undefined }); });
await c.addInitScript(() => {
  const t = (fn, bk, pxOf) => function (...a) { const t0 = performance.now(); try { return fn.apply(this, a); } finally { bk.n++; bk.ms += performance.now() - t0; if (pxOf) bk.px += pxOf.call(this, a) || 0; } };
  const W = (window.__probe = { decode: { n: 0, ms: 0 }, det: { n: 0, ms: 0 }, clip: { n: 0, ms: 0 }, drawImage: { n: 0, ms: 0, px: 0 }, getImageData: { n: 0, ms: 0, px: 0 }, tdu: { n: 0, ms: 0, px: 0, byQ: {}, byW: {} }, longTasks: [], wrapSession: null });
  window.createImageBitmap = t(window.createImageBitmap, W.decode);
  const CX = CanvasRenderingContext2D.prototype;
  CX.drawImage = t(CX.drawImage, W.drawImage, function () { const cv = this.canvas; return cv ? cv.width * cv.height : 0; });
  CX.getImageData = t(CX.getImageData, W.getImageData, function (a) { return (a[2] || 0) * (a[3] || 0); });
  const o = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    const q = a[1] === undefined ? "def" : String(a[1]);
    const t0 = performance.now();
    try { return o.apply(this, a); }
    finally {
      W.tdu.n++; W.tdu.ms += performance.now() - t0; W.tdu.px += this.width * this.height;
      const b2 = (W.tdu.byQ[q] || (W.tdu.byQ[q] = { n: 0, ms: 0, px: 0 })); b2.n++; b2.ms += performance.now() - t0; b2.px += this.width * this.height;
      const w = this.width + "x" + this.height; const b3 = (W.tdu.byW[w] || (W.tdu.byW[w] = { n: 0, px: 0 })); b3.n++; b3.px += this.width * this.height;
    }
  };
  W.wrapSession = (s, bk) => { if (!s || s.__w) return; const f = s.run.bind(s); s.__w = 1; s.run = async (feeds) => { const t0 = performance.now(); try { return await f(feeds); } finally { bk.n++; bk.ms += performance.now() - t0; } }; };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) W.longTasks.push({ s: e.startTime, d: e.duration }); }).observe({ entryTypes: ["longtask"] }); } catch (e) { }
});
await c.addInitScript(`window.__WFON = ${process.env.WF === "off" ? "false" : "true"};`);
const p = await c.newPage();
p.on("pageerror", e => console.log("PAGEERROR:", String(e).slice(0, 300)));
await p.goto("http://127.0.0.1:4299/?engine=webgpu-b16", { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => window.modelsReady === true, null, { timeout: 300000 });
console.log("READY zip=" + ZIP);
await p.evaluate(() => { const A = window.__mosqAsync; window.__probe.wrapSession(A.sessDet, window.__probe.det); window.__probe.wrapSession(A.sessClip, window.__probe.clip); });

const r = await p.evaluate(async ({ zip, WANT }) => {
  window.__WF = window.__WFON !== false;
  const A = window.__mosqAsync;
  const blob = await (await fetch(zip)).blob();
  const file = new File([blob], "b.zip", { type: "application/zip" });
  const chk = document.getElementById("chk-whole-frame");
  if (chk && chk.checked !== window.__WF) { chk.checked = window.__WF; chk.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(r => setTimeout(r, 800)); }
  const W = window.__probe;
  for (const k of ["decode", "det", "clip", "drawImage", "getImageData"]) { W[k].n = 0; W[k].ms = 0; W[k].px = 0; }
  W.tdu.n = 0; W.tdu.ms = 0; W.tdu.px = 0; W.tdu.byQ = {}; W.tdu.byW = {}; W.longTasks = [];
  W.wrapSession(window.__mosqAsync.sessDet, W.det); W.wrapSession(window.__mosqAsync.sessClip, W.clip);

  // Observe every tile <img> src assignment the app makes, in order, so we can
  // see the full-res thumbnail and the crop thumbnail for the same photo.
  const seen = [];
  const mo = new MutationObserver((muts) => {
    for (const m of muts) { const el = m.target; if (el.tagName !== "IMG") continue;
      const s = el.getAttribute("src"); if (!s || !s.startsWith("data:")) continue;
      seen.push({ t: Math.round(performance.now()), bytes: s.length, src: s }); }
  });
  mo.observe(document.getElementById("thumbnail-strip"), { subtree: true, attributes: true, attributeFilter: ["src"] });

  const t0 = performance.now();
  A.processFiles([file]);
  const deadline = t0 + 12 * 60_000;
  while (performance.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const n = A.previews.length;
    const settled = A.previews.filter(x => !x.pending && !x.error).length;
    if (n >= WANT && settled >= WANT) break;
  }
  const tSettled = performance.now() - t0;
  await new Promise(r => setTimeout(r, 300));
  mo.disconnect();

  const tiles = [...document.querySelectorAll("#thumbnail-strip img")].map((el, i) => ({
    i, bytes: (el.getAttribute("src") || "").length, src: el.getAttribute("src") || "",
    alt: el.alt,
  }));
  const inf = W.det.ms + W.clip.ms;
  const wall = performance.now() - t0;
  const lt = W.longTasks.filter(x => x.d >= 50);
  return {
    wall: Math.round(wall), tSettled: Math.round(tSettled),
    infMs: Math.round(inf),
    nonInferMs: Math.round(wall - inf), nonInferPct: Math.round(1000 * (wall - inf) / wall) / 10,
    inferPct: Math.round(1000 * inf / wall) / 10,
    detN: W.det.n, detMs: Math.round(W.det.ms), clipN: W.clip.n, clipMs: Math.round(W.clip.ms),
    drawN: W.drawImage.n, drawMs: Math.round(W.drawImage.ms), drawMP: Math.round(W.drawImage.px / 1e6),
    tduN: W.tdu.n, tduMs: Math.round(W.tdu.ms), tduMP: Math.round(W.tdu.px / 1e6),
    tduByQ: Object.fromEntries(Object.entries(W.tdu.byQ).map(([q, v]) => [q, { n: v.n, mp: Math.round(v.px / 1e6), ms: Math.round(v.ms) }])),
    tduByW: Object.fromEntries(Object.entries(W.tdu.byW).map(([w, v]) => [w, { n: v.n, mp: Math.round(v.px / 1e6) }])),
    ltSum: Math.round(lt.reduce((a, x) => a + x.d, 0)), ltN: lt.length,
    n: A.previews.length, settled: A.previews.filter(x => !x.pending && !x.error).length,
    assignments: seen.length, tiles: tiles.length, seen, tiles,
  };
}, { zip: ZIP, WANT });

// Drop the base64 payloads from the report; keep byte counts and a hash.
import { createHash } from "node:crypto";
const hash = (s) => s ? createHash("sha1").update(s).digest("hex").slice(0, 12) : null;
const r2 = { ...r, seen: r.seen.map(s => ({ t: s.t, bytes: s.bytes, hash: hash(s.src) })), tiles: r.tiles.map(s => ({ i: s.i, bytes: s.bytes, hash: hash(s.src), alt: s.alt })) };
const fs = await import("node:fs");
fs.writeFileSync(OUT, JSON.stringify(r2, null, 1));
// Full payloads, for the pixel comparison.
fs.writeFileSync(OUT.replace(/\.json$/, "-tiles.json"), JSON.stringify({ tiles: r.tiles }));
console.log(JSON.stringify({ ...r2, seen: undefined, tiles: r2.tiles.length }, null, 1));
await b.close();
