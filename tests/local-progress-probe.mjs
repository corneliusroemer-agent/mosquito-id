// Local verification of the progress slot: no R2, no classifier, no CORS.
// Serves the app and a slow 3 MB body, then checks the bar width and the meter
// text a user would actually see, on a cache MISS and on a cache HIT.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CHUNK = 96 * 1024;
const BODY = Buffer.alloc(3 * 1024 * 1024, 7);

const server = http.createServer((req, res) => {
  if (req.url === "/slow.onnx") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(BODY.length),
      "access-control-allow-origin": "*",
    });
    let off = 0;
    const push = () => {
      if (off >= BODY.length) { res.end(); return; }
      const end = Math.min(off + CHUNK, BODY.length);
      res.write(BODY.subarray(off, end));
      off = end;
      setTimeout(push, 60);
    };
    push();
    return;
  }
  const f = path.join(ROOT, req.url.split("?")[0].replace(/^\//, "") || "index.html");
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`,
});
const page = await browser.newPage();
await page.goto(base);
await page.waitForFunction(() => typeof window.fetchWithCache === "function");

const run = async (label, url, seedCache) => page.evaluate(async ({ label, url, seedCache }) => {
  if (seedCache) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(new Uint8Array(4 * 1024 * 1024), {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(4 * 1024 * 1024) },
    }));
  }
  const seen = [];
  const t0 = performance.now();
  const timer = setInterval(() => {
    const fill = document.getElementById("progress-fill");
    const slot = document.getElementById("progress-slot");
    seen.push({
      t: Math.round(performance.now() - t0),
      w: fill.style.width,
      indeterminate: slot.classList.contains("indeterminate"),
      msg: document.getElementById("progress-msg").textContent,
      meter: document.getElementById("progress-meter").textContent,
      h: Math.round(slot.getBoundingClientRect().height),
    });
  }, 20);
  const buf = await fetchWithCache(url, makeTransferProgress("Detector (YOLO11n)"));
  await new Promise((r) => setTimeout(r, 120));
  clearInterval(timer);
  return {
    label,
    bytes: buf.byteLength,
    heights: [...new Set(seen.map((s) => s.h))],
    states: [...new Set(seen.map((s) => `${s.w} | msg="${s.msg}" | meter="${s.meter}"`))],
    final: seen[seen.length - 1],
  };
}, { label, url, seedCache });

console.log(JSON.stringify(await run("MISS (streaming 3 MB)", base + "slow.onnx", false), null, 1));
console.log(JSON.stringify(await run("HIT (4 MB from CacheStorage)", base + "slow.onnx", true), null, 1));
await browser.close();
server.close();
