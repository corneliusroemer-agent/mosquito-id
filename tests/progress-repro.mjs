// Reproduce the model-load progress bar without ever downloading the real
// models. Every R2 URL is intercepted with route.continue({url}) pointing at a
// local streaming server, so the response body genuinely arrives in chunks over
// time with a real content-length: fetchWithProgress's reader loop fires real
// progress callbacks with real byte counts, at zero network cost.
//
// Usage: node progress-repro.mjs [classifierSizeBytes] [--dump outfile]
import { chromium } from "playwright";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const SIZE = Number(argv.find((a) => /^\d+$/.test(a)) || 0) || 1259593728;
const DUMP = argv.includes("--dump") ? argv[argv.indexOf("--dump") + 1] : null;
const REAL_R2 = argv.includes("--real-r2");
// Second load in the same context: every asset is a CacheStorage HIT.
const TWICE = argv.includes("--twice");
const CLASSIFIER_SIZE = SIZE;

const PAGE_PORT = 8731;
const R2 = "https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/";

// Declared sizes. The classifier uses the real 1259593728 so the percentage
// maths and ETA are exercised at true scale; nothing that large is ever
// allocated or sent over a network.
const DECLARED = {
  "yolo11n-mosquito-det-640.onnx": 10607017,
  "bioclip_2_5_fp16.onnx": CLASSIFIER_SIZE,
  "text_embeds.json": fs.statSync(path.join(ROOT, "text_embeds.json")).size,
};

// A valid ONNX so InferenceSession.create can actually succeed where we need
// the load to run to completion.
const VALID_ONNX = fs.readFileSync(path.join(ROOT, "tests/vendor/det.onnx"));

const events = [];
let streamServer = null;

// Streams DECLARED[name] bytes in real chunks, paced so a several-minute wait
// compresses into seconds. `body` supplies the actual bytes (used when we need a
// parseable model); otherwise zeros, which still drive genuine progress.
function startStreamServer() {
  return new Promise((resolve) => {
    streamServer = https.createServer({
      key: fs.readFileSync(path.join(ROOT, "tests/vendor/key.pem")),
      cert: fs.readFileSync(path.join(ROOT, "tests/vendor/cert.pem")),
    }, async (req, res) => {
      const name = decodeURIComponent(req.url.split("?")[0].slice(1));
      const size = DECLARED[name];
      if (size === undefined) { res.writeHead(404); res.end(); return; }
      let t0 = Date.now();
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "access-control-allow-origin": "*",
      });
      const CHUNK = 4 * 1024 * 1024;
      const src = name.endsWith(".onnx") ? VALID_ONNX : null;
      let cursor = 0;
      for (let off = 0; off < size; off += CHUNK) {
        const n = Math.min(CHUNK, size - off);
        let buf;
        if (src) {
          buf = Buffer.alloc(n);
          for (let i = 0; i < n; i++) buf[i] = src[(cursor + i) % src.length];
          cursor = (cursor + n) % src.length;
        } else {
          buf = Buffer.alloc(n);
        }
        if (!res.write(buf)) await new Promise((r) => res.once("drain", r));
        await new Promise((r) => setTimeout(r, 200));
      }
      res.end();
      events.push({ name, declared: size, ms: Date.now() - t0 });
    });
    streamServer.listen(8732, () => resolve());
  });
}

const pageServer = http.createServer((req, res) => {
  const f = req.url.split("?")[0];
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  const body = fs.readFileSync(p);
  const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".mjs") ? "text/javascript"
    : f.endsWith(".css") ? "text/css" : f.endsWith(".html") ? "text/html"
    : f.endsWith(".json") ? "application/json" : "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": String(body.length) });
  res.end(body);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, r));
await startStreamServer();

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const samples = [];

await page.route("**/cdn.jsdelivr.net/**", async (route) => {
  const m = route.request().url().match(/\/npm\/[^/]+\/dist\/(.+)$/);
  if (!m) return route.abort();
  const f = path.join(ROOT, "tests/vendor", m[1]);
  if (!fs.existsSync(f)) return route.abort();
  await route.fulfill({ body: fs.readFileSync(f), contentType: "text/javascript" });
});
await page.route(`${R2}**`, async (route) => {
  const name = decodeURIComponent(route.request().url().split("/").pop());
  if (DECLARED[name] === undefined) return route.fulfill({ status: 404, body: "no" });
  if (REAL_R2) {
    // 10 MB detector straight from Cloudflare: genuine headers and CORS. The
    // classifier is refused, so the 1.26 GB file is never fetched.
    if (name !== "yolo11n-mosquito-det-640.onnx") return route.fulfill({ status: 404, body: "refused" });
    console.log("  (real R2 passthrough for", name + ")");
    return route.continue();
  }
  route.continue({ url: `https://127.0.0.1:8732/${encodeURIComponent(name)}` });
});

let t0 = Date.now();
const t0Reset = () => { t0 = Date.now(); };
page.on("console", (m) => {
  const t = m.text();
  if (/HIT|MISS|initialization error/i.test(t)) console.log(`  +${Date.now() - t0}ms [page]`, t.slice(0, 130));
});

await page.addInitScript(() => {
  window.__bytes = [];
  const origFetch = window.fetch;
  window.fetch = async (...a) => {
    const url = String(a[0]);
    const t0 = performance.now();
    const resp = await origFetch(...a);
    if (!/r2\.dev/.test(url)) return resp;
    const total = Number(resp.headers.get("content-length")) || 0;
    window.__bytes.push({
      url: url.split("/").pop(),
      phase: "response",
      ms: Math.round(performance.now() - t0),
      totalHeader: resp.headers.get("content-length"),
      totalParsed: total,
      type: resp.type,
    });
    if (!resp.body) return resp;
    const reader = resp.body.getReader();
    return new Response(new ReadableStream({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) {
          window.__bytes.push({
            url: url.split("/").pop(), phase: "done",
            ms: Math.round(performance.now() - t0), totalParsed: total,
          });
          ctrl.close();
          return;
        }
        window.__bytes.push({
          url: url.split("/").pop(), phase: "chunk",
          ms: Math.round(performance.now() - t0), len: value.length, totalParsed: total,
        });
        ctrl.enqueue(value);
      },
    }), { headers: resp.headers, status: resp.status, statusText: resp.statusText });
  };
});

const url = `http://127.0.0.1:${PAGE_PORT}/index.html?engine=webgpu-fp16`;
if (TWICE) {
  // Warm the CacheStorage, then reload so the load we measure is all HITs.
  await page.goto(url);
  await page.waitForFunction(() => window.modelsReady === true || (document.getElementById("progress-msg")?.textContent || "").startsWith("Error"), { timeout: 300_000 }).catch(() => {});
  console.log("  (warmed cache; reloading to measure the HIT path)");
  samples.length = 0;
  await page.evaluate(() => { window.__bytes = []; });
  await page.reload();
  t0Reset();
} else {
  await page.goto(url);
}

const poll = setInterval(async () => {
  try {
    const s = await page.evaluate(() => {
      const slot = document.getElementById("progress-slot");
      const fill = document.getElementById("progress-fill");
      const msg = document.getElementById("progress-msg");
      const track = document.querySelector(".progress-bar-track");
      if (!slot || !fill) return null;
      return {
        vis: getComputedStyle(slot).visibility,
        indet: slot.classList.contains("indeterminate"),
        inlineW: fill.style.width,
        renderW: +fill.getBoundingClientRect().width.toFixed(1),
        trackW: track ? +track.getBoundingClientRect().width.toFixed(1) : null,
        msg: msg ? msg.textContent : null,
        slotH: +slot.getBoundingClientRect().height.toFixed(1),
      };
    });
    if (s) samples.push({ ms: Date.now() - t0, ...s });
  } catch {}
}, 250);

await page.waitForFunction(() => {
  const m = document.getElementById("progress-msg");
  return (m && m.textContent.startsWith("Error")) || document.getElementById("progress-slot")?.dataset.done === "1";
}, { timeout: 300_000 }).catch(() => console.log("  (wait timed out; stopping sampling)"));
await page.waitForTimeout(1500);
clearInterval(poll);

console.log(`\n=== intercepted streams (declared bytes -> delivered in ${Date.now() - t0}ms) ===`);
for (const e of events) console.log(`  ${e.name.padEnd(32)} ${e.declared} bytes in ${e.ms}ms`);
const seen = new Set(samples.map((s) => s.renderW));
console.log(`\n=== ${samples.length} samples ===`);
for (const s of samples) {
  console.log(`  +${String(s.ms - t0).padStart(6)}ms vis=${s.vis} ${s.indet ? "INDET" : "     "} inline=${(s.inlineW || "-").padStart(7)} render=${String(s.renderW).padStart(5)}/${s.trackW} slotH=${s.slotH} msg=${JSON.stringify(s.msg)}`);
}
console.log("\ndistinct rendered widths:", [...seen].sort((a, b) => a - b).join(", "));
console.log("max rendered width:", Math.max(...samples.map((s) => s.renderW)), "px of track", samples[0]?.trackW);
const msgs = [...new Set(samples.map((s) => s.msg).filter(Boolean))];
console.log("distinct messages:", JSON.stringify(msgs));
console.log("slot height range:", Math.min(...samples.map((s) => s.slotH)), "-", Math.max(...samples.map((s) => s.slotH)));

const bytes = await page.evaluate(() => window.__bytes || []).catch(() => []);
const byUrl = {};
for (const b of bytes) { (byUrl[b.url] ||= []).push(b); }
console.log("\n=== fetch byte log (as the app's reader sees it) ===");
for (const [u, list] of Object.entries(byUrl)) {
  const resp = list.find((b) => b.phase === "response") || {};
  const chunks = list.filter((b) => b.phase === "chunk");
  console.log(`  ${u}`);
  console.log(`    response: content-length header=${JSON.stringify(resp.totalHeader)} parsed=${resp.totalParsed} type=${resp.type} at ${resp.ms}ms`);
  console.log(`    chunks: ${chunks.length}, total bytes ${chunks.reduce((a, b) => a + b.len, 0)}, span ${chunks[0]?.ms}..${chunks[chunks.length - 1]?.ms}ms`);
  console.log(`    chunk sizes: ${[...new Set(chunks.map((c) => c.len))].join(", ")}`);
}
const setPct = await page.evaluate(() => {
  const f = document.getElementById("progress-fill");
  return f ? f.style.width : null;
});
console.log("\nfinal fill inline width:", setPct);

if (DUMP) fs.writeFileSync(DUMP, JSON.stringify({ samples, events }, null, 1));
await browser.close();
pageServer.close();
streamServer.close();
