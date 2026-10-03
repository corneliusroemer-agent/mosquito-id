// The verdict line, end to end through the real render path: no classifier, no
// R2. A synthetic posteriors vector goes in, renderActivePhoto() draws it, and
// what the user would see is read back off the page.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
// The classifier and the model host are never fetched.
await page.route(/(\.onnx|\.r2\.dev)/, (r) => r.abort());
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
await page.goto(base);
await page.waitForFunction(() => window.__mosqAsync && window.__mosqAsync.embeds !== undefined);

// Three photos: the two verdicts the feature exists for, and a confident one
// that must say nothing. Everything the app needs is set through the same
// window the app itself uses.
await page.evaluate(async () => {
  const EMB0 = (await (await fetch("text_embeds.json")).json());
  const SP = EMB0.species;
  window.__mosqAsync.embeds = { species: SP, logit_scale: 100 };
  // Posteriors directly, summing to 1 over the 16 shipped species.
  const post = (over) => {
    const v = SP.map((n) => over[n] || 0);
    const s = v.reduce((a, b) => a + b, 0);
    return v.map((x) => x / s);
  };
  const arr = window.__mosqAsync.previews;
  arr.length = 0;
  const cases = [
    ["torn.jpg", post({ "Aedes aegypti": 0.36, "Aedes albopictus": 0.35, "Aedes japonicus": 0.14, "Culex pipiens": 0.15 })],
    ["flat.jpg", post({ "Aedes aegypti": 1, "Culex pipiens": 1, "Anopheles claviger": 1, "Culiseta annulata": 1, "Culex quinquefasciatus": 1, "Aedes albopictus": 1, "Aedes vexans": 1, "Culex torrentium": 1 })],
    ["sure.jpg", post({ "Aedes aegypti": 0.96, "Aedes albopictus": 0.02, "Culex pipiens": 0.01, "Anopheles claviger": 0.01 })],
  ];
  for (const [name, sp] of cases) {
    arr.push({
      name, scores: SP, logits: null, demoted: false, verdict: null,
      pending: false, error: null, rev: 0, fullCanvas: null, contextCanvas: null,
      detail: Object.fromEntries(SP.map((n, i) => [n, sp[i]])),
    });
  }

  // The verdict comes from main.js's own verdictFrom(), read out of the served
  // source rather than reimplemented, and the floors from the served constants.
  const src = await (await fetch("main.js")).text();
  const grab = (fn) => {
    const s = src.indexOf(`function ${fn}(`);
    let i = src.indexOf("{", s), d = 0;
    for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(s, i + 1); }
  };
  const cst = (n) => parseFloat(src.match(new RegExp(`^const ${n} = ([\\d.]+);$`, "m"))[1]);
  globalThis.__EMBX = window.__mosqAsync.embeds;
  (0, eval)(`const EMB=globalThis.__EMBX;let genusIndexCache=null;
${grab("genusOf")}${grab("speciesGenusIndex")}
const SPECIES_CONFIDENCE_FLOOR=${cst("SPECIES_CONFIDENCE_FLOOR")};
const GENUS_CONFIDENCE_FLOOR=${cst("GENUS_CONFIDENCE_FLOOR")};
${grab("verdictFrom")}${grab("verdictSentence")}
globalThis.__v={verdictFrom,verdictSentence};`);
  for (const p of arr) {
    p.verdict = window.__v.verdictFrom(SP.map((n) => p.detail[n]));
  }
  window.__probeVerdicts = arr.map((p) => ({
    name: p.name, state: p.verdict.state, genus: p.verdict.genus,
    text: window.__v.verdictSentence(p.verdict),
  }));
});

const read = async (i) => page.evaluate((i) => {
  const el = document.getElementById("score-uncertain");
  const panel = document.querySelector(".scores-panel");
  const list = document.getElementById("score-list");
  window.__mosqAsync.selectPhoto(i);
  const cs = getComputedStyle(el);
  const pb = panel.getBoundingClientRect(), lb = list.getBoundingClientRect();
  const eb = el.getBoundingClientRect();
  return {
    text: el.textContent,
    title: el.title,
    cls: el.className,
    display: cs.display,
    visibility: cs.visibility,
    inlineStyle: el.getAttribute("style"),
    panelH: +pb.height.toFixed(2),
    panelTop: +pb.top.toFixed(2),
    listTop: +lb.top.toFixed(2),
    verdictBoxH: +eb.height.toFixed(2),
    rows: list.children.length,
    firstRowTop: list.firstElementChild ? +list.firstElementChild.getBoundingClientRect().top.toFixed(2) : null,
    rendered: el.offsetParent !== null && cs.visibility === "visible" && el.textContent !== "",
  };
}, i);

// gallery has to be on for the panel to have a box
await page.evaluate(() => { document.getElementById("gallery-section").style.display = "block"; });
console.log(JSON.stringify(await page.evaluate(() => window.__probeVerdicts), null, 1));
const out = { torn: await read(0), flat: await read(1), sure: await read(2) };
console.log(JSON.stringify(out, null, 1));

const fail = [];
if (out.torn.rendered !== true) fail.push("torn: verdict line not rendered");
if (!/^Definitely Aedes - maybe /.test(out.torn.text)) fail.push(`torn: unexpected text ${JSON.stringify(out.torn.text)}`);
if (out.flat.rendered !== true) fail.push("flat: verdict line not rendered");
if (out.flat.text !== "Not confident enough to name a genus") fail.push(`flat: unexpected text ${JSON.stringify(out.flat.text)}`);
if (out.sure.rendered !== false) fail.push(`sure: spurious verdict ${JSON.stringify(out.sure.text)}`);
if (out.sure.text !== "") fail.push("sure: verdict element carries text");
// The reservation: the panel, the list and the first score row must not move.
for (const k of ["panelH", "panelTop", "listTop", "firstRowTop"]) {
  if (out.torn[k] !== out.sure[k]) fail.push(`layout shift on ${k}: ${out.torn[k]} vs ${out.sure[k]}`);
}
if (out.torn.rows !== out.sure.rows) fail.push("row count differs");
console.log(fail.length ? "FAIL\n" + fail.join("\n") : "PASS");
await browser.close();
process.exit(fail.length ? 1 : 0);
