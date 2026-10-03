// Does the score panel's abstention line actually render?
//
// index.html carries <p id="score-uncertain" style="display:none;">. main.js only
// ever sets textContent, className and title on it, so the `shown` class it adds
// meets an inline display:none, which no stylesheet rule can override. The line
// that should read "Not confident enough to name a genus" is laid out at zero
// height, which is why a blank wall scored 28.6% showed ten species with
// percentages and no indication that the classifier had declined to choose.
//
// The app abstains correctly. It then hides the abstention. This probe drives the
// real page, no classifier and no R2, and reads the computed style back.
//
// Run: node tests/abstention-line-probe.mjs   (needs playwright resolvable)
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url.split("?")[0].replace(/^\//, "") || "index.html");
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`,
});
const page = await browser.newPage();
await page.route(/(\.onnx|\.r2\.dev)/, (r) => r.abort());
await page.goto(base);

// Do exactly what main.js does when a photo's verdict is `unsure`.
const out = await page.evaluate(() => {
  const el = document.getElementById("score-uncertain");
  const vText = "Not confident enough to name a genus";
  el.textContent = vText;
  el.className = `uncertain${vText ? " shown" : ""}`;
  el.title = vText;
  const cs = getComputedStyle(el);
  return { inline: el.getAttribute("style"), className: el.className,
           display: cs.display, visibility: cs.visibility,
           rendered: el.offsetParent !== null, height: el.getBoundingClientRect().height };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();

if (out.rendered && out.height > 0) {
  console.log("\nok   the abstention line renders");
} else {
  console.log('\nFAIL  #score-uncertain is display:none even with class "shown".\n'
    + "      Remove the inline style attribute from it in index.html - an inline\n"
    + "      display:none beats the stylesheet's visibility rule.");
  process.exitCode = 1;
}
