// The view-disagreement gate, end to end through the real fuseViews() and the
// real render: no classifier, no R2. Two synthetic views go in per photo through
// fuseViews() itself - the app's own function, not a reimplementation - and the
// verdict line a user would read is read back off the page.
//
// The three photos differ only in whether their two views name the same species:
//   flip.jpg    the views name different species, and the pool is decisive
//   undecided.jpg  the views name different species, and the leading genus is too
//                 thin to name on its own
//   agree.jpg   the views agree
// A gate that abstains on everything fails on agree.jpg; a gate that reads the
// fused posterior alone fails on the other two.
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
let bytes = 0;
await page.route(/(\.onnx|\.r2\.dev)/, (r) => { bytes++; r.abort(); });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
await page.goto(base);
await page.waitForFunction(() => window.__mosqAsync && window.__mosqAsync.embeds !== undefined);

const built = await page.evaluate(async () => {
  const EMB0 = await (await fetch("text_embeds.json")).json();
  const SP = EMB0.species;
  window.__mosqAsync.embeds = { species: SP, logit_scale: EMB0.logit_scale, dim: EMB0.dim };
  const scale = EMB0.logit_scale / 2.5;
  const post = (over) => {
    const v = SP.map((n) => over[n] || 0);
    const s = v.reduce((a, b) => a + b, 0);
    return v.map((x) => x / s);
  };
  const view = (over) => ({ spP: post(over), nuTotal: 1e-6, scale });

  const CASES = {
    // The reported bug: the crop says one species, the whole frame another, and
    // the average of the two is a confident-looking number.
    "flip.jpg": [view({ "Aedes aegypti": 0.60, "Aedes albopictus": 0.20, "Culex pipiens": 0.20 }),
                 view({ "Aedes albopictus": 0.60, "Aedes aegypti": 0.20, "Culex pipiens": 0.20 })],
    // Same contradiction, but the leading genus is too thin to be claimed even
    // after the species is withdrawn.
    "undecided.jpg": [view({ "Culex pipiens": 0.70, "Culex torrentium": 0.15, "Aedes aegypti": 0.10, "Culex quinquefasciatus": 0.05 }),
                      view({ "Aedes aegypti": 0.60, "Culex pipiens": 0.15, "Culex torrentium": 0.15, "Culex quinquefasciatus": 0.10 })],
    // The control: both views pick the same species.
    "agree.jpg": [view({ "Aedes aegypti": 0.90, "Aedes albopictus": 0.05, "Culex pipiens": 0.05 }),
                  view({ "Aedes aegypti": 0.85, "Aedes albopictus": 0.08, "Culex pipiens": 0.07 })],
  };

  const arr = window.__mosqAsync.previews;
  arr.length = 0;
  const report = [];
  for (const [name, views] of Object.entries(CASES)) {
    const fused = fuseViews(views);          // the app's own fusion and gate
    const p = { name, pending: false, error: null, rev: 0, fullCanvas: null,
                contextCanvas: null, cropBox: null, fingerprint: name };
    commitScores(p, fused);
    p.agreement = fused.agreement;
    arr.push(p);
    report.push({ name, agree: fused.agreement.agree,
                  topSpeciesP: fused.verdict.topSpeciesP, topGenusP: fused.verdict.topGenusP,
                  state: fused.verdict.state, species: fused.verdict.species });
  }
  document.getElementById("gallery-section").style.display = "block";
  return report;
});
console.log("fused verdicts from fuseViews():");
console.table(built);

const read = async (i) => {
  await page.evaluate((i) => window.__mosqAsync.selectPhoto(i), i);
  return page.evaluate(() => {
    const v = document.getElementById("score-uncertain");
    const rows = Array.from(document.querySelectorAll("#score-list .score-item"))
      .slice(0, 2)
      .map((el) => el.textContent.replace(/\s+/g, " ").trim());
    return { verdict: v.textContent.trim(), shown: v.classList.contains("shown"), top2: rows };
  });
};

const shown = {};
for (let i = 0; i < built.length; i++) shown[built[i].name] = await read(i);
console.log("\nwhat the page shows:");
for (const [name, v] of Object.entries(shown)) console.log(` ${name}: ${JSON.stringify(v)}`);

const fail = [];
const want = {
  "flip.jpg": { notSpecies: true, has: /Definitely Aedes/ },
  "undecided.jpg": { notSpecies: true, has: /^Not confident enough to name a genus$/ },
  "agree.jpg": { notSpecies: false, has: /^$/ },
};
for (const [name, w] of Object.entries(want)) {
  const got = shown[name].verdict;
  const state = built.find((b) => b.name === name).state;
  if (w.notSpecies && state === "species") fail.push(`${name}: still names a species (${state})`);
  if (!w.notSpecies && state !== "species") fail.push(`${name}: agreeing views did not name a species (${state})`);
  if (!w.has.test(got)) fail.push(`${name}: verdict line ${JSON.stringify(got)} does not match ${w.has}`);
  if (!w.notSpecies && shown[name].top2.length && !/Aedes aegypti/.test(shown[name].top2[0])) {
    fail.push(`${name}: ranking does not lead with its species, got ${JSON.stringify(shown[name].top2[0])}`);
  }
}
if (bytes < 1) fail.push("no model request was aborted - the harness did not block the download");

console.log(fail.length ? "FAIL\n" + fail.join("\n") : "PASS");
await browser.close();
process.exit(fail.length ? 1 : 0);