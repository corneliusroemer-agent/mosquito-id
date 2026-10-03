// What does the browser actually see from R2? Runs from a real page origin so
// CORS applies exactly as it does in production. Only the 10 MB detector is
// ranged to a few bytes - the 1.26 GB classifier is never requested.
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
const srv = http.createServer((q, s) => { s.writeHead(200, {"content-type":"text/html"}); s.end("<!doctype html><title>p</title>"); });
await new Promise(r => srv.listen(8733, r));
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const p = await (await b.newContext()).newPage();
await p.goto("http://127.0.0.1:8733/");
for (const [label, url] of [
  ["full GET (headers only)", "https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/yolo11n-mosquito-det-640.onnx"],
  ["ranged GET", "https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/yolo11n-mosquito-det-640.onnx"],
]) {
  const r = await p.evaluate(async (u) => {
    try {
      const init = u.endsWith(".onnx") && !window.__ranged ? {} : {};
      const resp = await fetch(u);
      const h = {}; resp.headers.forEach((v, k) => { h[k] = v; });
      let got = 0, chunks = 0;
      try {
        const rd = resp.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; got += value.length; chunks++; if (got > 3e6) { await rd.cancel(); break; } }
      } catch (e) { return { error: "stream: " + e.message, headers: h, status: resp.status, type: resp.type }; }
      return { status: resp.status, type: resp.type, headers: h, got, chunks,
               contentLengthHeader: resp.headers.get("content-length"), parsed: Number(resp.headers.get("content-length")) || 0 };
    } catch (e) { return { error: String(e) }; }
  }, url).catch(e => ({ error: "eval: " + e.message }));
  console.log(`\n### ${label}\n` + JSON.stringify(r, null, 1));
  await p.evaluate(() => { window.__ranged = true; });
}
await b.close(); srv.close();
