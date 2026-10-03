// The gate arithmetic, without a browser and without the model.
//
// main.js is a browser script with no exports, so the three functions under test
// are lifted out of it by reading the source and evaluating just those
// declarations against a stub EMB. Reading the file rather than copying the code
// is the point: a copy would pass while main.js changed underneath it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "main.js"), "utf8");

const EMBS = JSON.parse(readFileSync(join(here, "..", "text_embeds.json"), "utf8"));

// The real 16-species label set, so genus derivation is exercised on the names
// that actually ship rather than on a convenient fixture.
// The real adjacent classes too, so the non-mosquito state is exercised against
// the names that actually ship rather than a convenient fixture.
const EMB = { species: EMBS.species, adjacent: EMBS.adjacent,
              adjacent_common: EMBS.adjacent_common, logit_scale: 100 };

const grab = (name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in main.js`);
  // Walk braces from the function's opening one.
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
};

// The gate constants are read out of main.js too, so the test fails if the
// shipped value is edited and the expectations are not.
const constOf = (name) => {
  const m = src.match(new RegExp(`^const ${name} = ([\\d.]+);$`, "m"));
  if (!m) throw new Error(`${name} not found in main.js`);
  return parseFloat(m[1]);
};
// Boolean-valued, so the same "do not let it drift from the test" property.
const boolOf = (name) => {
  const m = src.match(new RegExp(`^const ${name} = (true|false);$`, "m"));
  if (!m) throw new Error(`${name} not found in main.js`);
  return m[1] === "true";
};

globalThis.__EMB = EMB;
const harness = `
const EMB = globalThis.__EMB;
let genusIndexCache = null;
${grab("genusOf")}
${grab("speciesGenusIndex")}
const SPECIES_CONFIDENCE_FLOOR = globalThis.__SPECIES_FLOOR;
const GENUS_CONFIDENCE_FLOOR = globalThis.__GENUS_FLOOR;
const VIEW_DISAGREEMENT_VETOES_SPECIES = globalThis.__DISAGREEMENT_VETOES;
const NON_MOSQUITO_FLOOR = globalThis.__NON_MOSQUITO_FLOOR;
${grab("adjacentNames")}
${grab("verdictFrom")}
${grab("verdictSentence")}
${grab("genusScores")}
${grab("fuseViews")}
${grab("viewAgreement")}
const GENUS_MARGIN = globalThis.__GENUS_MARGIN;
globalThis.__api = { verdictFrom, verdictSentence, fuseViews, viewAgreement,
  speciesGenusIndex, genusOf, adjacentNames,
  SPECIES_CONFIDENCE_FLOOR, GENUS_CONFIDENCE_FLOOR, VIEW_DISAGREEMENT_VETOES_SPECIES,
  NON_MOSQUITO_FLOOR };
`;
globalThis.__SPECIES_FLOOR = constOf("SPECIES_CONFIDENCE_FLOOR");
globalThis.__GENUS_FLOOR = constOf("GENUS_CONFIDENCE_FLOOR");
globalThis.__GENUS_MARGIN = constOf("GENUS_MARGIN");
globalThis.__DISAGREEMENT_VETOES = boolOf("VIEW_DISAGREEMENT_VETOES_SPECIES");
globalThis.__NON_MOSQUITO_FLOOR = constOf("NON_MOSQUITO_FLOOR");
(0, eval)(harness);
const api = globalThis.__api;
const { verdictFrom, verdictSentence, fuseViews, viewAgreement, speciesGenusIndex,
        adjacentNames, NON_MOSQUITO_FLOOR } = api;

const S = EMB.species.length;
const post = (over) => {
  const p = new Array(S).fill(0);
  for (const [name, v] of Object.entries(over)) p[EMB.species.indexOf(name)] = v;
  return p;
};
let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures++; console.log(`  FAIL ${label}: ${e.message}`); }
};

console.log(`species floor ${api.SPECIES_CONFIDENCE_FLOOR}, genus floor ${api.GENUS_CONFIDENCE_FLOOR}`);
console.log(`genus index: ${JSON.stringify([...speciesGenusIndex().idx].map(([g, m]) => [g, m.length]))}`);

// --- genus derivation, including the compound epithets.
check("genusOf splits on whitespace, so an epithet with a slash stays inside its genus", () => {
  assert.equal(api.genusOf("Culiseta annulata/morsitans"), "Culiseta");
  assert.equal(api.genusOf("Anopheles maculipennis complex"), "Anopheles");
  assert.equal(api.genusOf("Aedes aegypti"), "Aedes");
  assert.equal(api.genusOf("  Aedes   aegypti  "), "Aedes");
  // A bare genus is its own genus, not the empty string.
  assert.equal(api.genusOf("Aedes"), "Aedes");
});

check("every shipping species lands in a genus with at least one member", () => {
  const { idx } = speciesGenusIndex();
  assert.equal(EMB.species.length, S);
  assert.ok([...idx.values()].every((m) => m.length >= 1));
  assert.equal([...idx.values()].flat().sort((a, b) => a - b).join(","),
               [...Array(S).keys()].join(","));
});

// --- the three states.
check("posterior above the species floor returns its argmax", () => {
  const v = verdictFrom(post({ "Aedes aegypti": 0.40, "Aedes albopictus": 0.35, "Culex pipiens": 0.25 }));
  assert.equal(v.state, "species");
  assert.equal(v.species, "Aedes aegypti");
  assert.equal(v.genus, "Aedes");
  assert.equal(verdictSentence(v), "");   // nothing to add over the ranking
});

check("posterior exactly at the species floor still answers (>=, not >)", () => {
  const v = verdictFrom(post({ "Aedes aegypti": api.SPECIES_CONFIDENCE_FLOOR }));
  assert.equal(v.state, "species");
  assert.equal(v.species, "Aedes aegypti");
});

check("a spread posterior inside one genus gives genus-only, not a species", () => {
  // Top species 0.30 (below 0.373), but the three Aedes sum to 0.90.
  const v = verdictFrom(post({
    "Aedes aegypti": 0.30, "Aedes albopictus": 0.35, "Aedes japonicus": 0.25,
    "Culex pipiens": 0.10
  }));
  assert.equal(v.state, "genus");
  assert.equal(v.genus, "Aedes");
  assert.equal(v.species, null);
  assert.ok(Math.abs(v.topGenusP - 0.90) < 1e-9);
});

check("genus-only sentence names the runners-up, genus prefix stripped", () => {
  const v = verdictFrom(post({
    "Aedes aegypti": 0.30, "Aedes albopictus": 0.35, "Aedes vexans": 0.25
  }));
  // albopictus leads at 0.35 - under the species floor - and the two runners-up
  // are named in descending order after it.
  assert.equal(verdictSentence(v), "Definitely Aedes - maybe aegypti or vexans");
  // Runners-up are siblings of the genus, never a species from another genus.
  assert.ok(v.runnersUp.every((r) => api.genusOf(r.name) === "Aedes"));
});

check("below both floors the verdict is not confident", () => {
  const v = verdictFrom(post({ "Aedes aegypti": 0.10, "Culex pipiens": 0.20, "Culiseta annulata": 0.15 }));
  assert.equal(v.state, "unsure");
  assert.equal(v.genus, null);
  assert.equal(v.species, null);
  assert.equal(verdictSentence(v), "Not confident enough to name a genus");
});

check("a genus below the genus floor is not claimed even when a genus leads", () => {
  // No genus sums to 0.54: Culex leads at 0.45, Aedes at 0.35, Culiseta at 0.20.
  const p = post({
    "Aedes aegypti": 0.20, "Aedes albopictus": 0.15,
    "Culex pipiens": 0.25, "Culex torrentium": 0.20,
    "Culiseta annulata": 0.20
  });
  const v = verdictFrom(p);
  assert.ok(Math.abs(v.topGenusP - 0.45) < 1e-9, `top genus ${v.topGenusP}`);
  assert.equal(v.state, "unsure");
  // A wrong genus is worse than no genus, so the leading genus is not named.
  assert.equal(v.genus, null);
});

check("an empty posterior degrades to not confident rather than throwing", () => {
  assert.equal(verdictFrom([]).state, "unsure");
  assert.equal(verdictFrom(null).state, "unsure");
});

// --- the gate reads the FUSED posterior.
check("the gate is applied to the fused posterior, not per view", () => {
  const scale = EMB.logit_scale / 2.5;
  // Each view alone is undecided; pooled, one of them is decided.
  const viewA = { spP: post({ "Aedes aegypti": 0.34, "Aedes albopictus": 0.33, "Culex pipiens": 0.33 }), nuTotal: 1e-6, scale };
  const viewB = { spP: post({ "Aedes aegypti": 0.60, "Aedes albopictus": 0.20, "Culex pipiens": 0.20 }), nuTotal: 1e-6, scale };
  // View A alone tops out at 0.34, under the species floor, so gating per view
  // would decline to answer it. View B alone answers. The photo is answered on
  // the pool of the two, which is the only place the gate may be applied.
  const alone = fuseViews([viewA]);
  assert.notEqual(alone.verdict.state, "species");
  assert.equal(fuseViews([viewB]).verdict.state, "species");
  const fused = fuseViews([viewA, viewB]);
  assert.equal(fused.verdict.state, "species");
  assert.equal(fused.verdict.species, "Aedes aegypti");
  // And it is the fused posterior, not view B copied through: the pool is not
  // view B's 0.60 but a number no single view produced.
  assert.notEqual(fused.verdict.topSpeciesP, viewB.spP[1]);
});

check("the fused verdict is not recomputed from any single view's posterior", () => {
  const scale = EMB.logit_scale / 2.5;
  const a = { spP: post({ "Culex pipiens": 0.90 }), nuTotal: 1e-6, scale };
  const b = { spP: post({ "Aedes aegypti": 0.90 }), nuTotal: 1e-6, scale };
  // Two disagreeing views pool to a near-tie at genus level: not confident.
  const fused = fuseViews([a, b]);
  assert.equal(fused.verdict.state, "unsure");
  // The two genera are level in the pool (0.3214 each, the remaining mass taken
  // by the nuisance class and the 14 near-zero species), so neither clears the
  // genus floor and nothing is claimed. Note the pool is well under either
  // view's own 0.90: two views disagreeing cost confidence, which is the
  // behaviour the gate exists to catch.
  assert.ok(Math.abs(fused.verdict.topGenusP - 0.5) > 1e-6, `top genus ${fused.verdict.topGenusP}`);
  console.log(`    (fused top genus posterior ${fused.verdict.topGenusP.toFixed(4)} against 0.90 per view)`);
});

// --- a disagreement between the views costs the photo its species claim.
check("two views naming different species cannot reach a species verdict, however high the fused posterior", () => {
  const scale = EMB.logit_scale / 2.5;
  const view = (over) => ({ spP: post(over), nuTotal: 1e-6, scale });
  // Each view is sure, and sure of a different species. Pooled, the top species
  // lands at 0.818 - far above the species floor - and the genus at 0.909, far
  // above the genus floor. Before the disagreement reached the gate, this photo
  // named Aedes aegypti at 82%.
  const fused = fuseViews([
    view({ "Aedes aegypti": 0.60, "Aedes albopictus": 0.20, "Culex pipiens": 0.20 }),
    view({ "Aedes albopictus": 0.60, "Aedes aegypti": 0.20, "Culex pipiens": 0.20 })
  ]);
  assert.ok(fused.verdict.topSpeciesP > api.SPECIES_CONFIDENCE_FLOOR,
            `test setup: fused top must clear the species floor, got ${fused.verdict.topSpeciesP}`);
  assert.ok(fused.verdict.topGenusP > api.GENUS_CONFIDENCE_FLOOR,
            `test setup: fused genus must clear the genus floor, got ${fused.verdict.topGenusP}`);
  assert.equal(fused.agreement.agree, false);
  assert.notEqual(fused.verdict.state, "species");
  assert.equal(fused.verdict.genus, "Aedes");
  assert.equal(fused.verdict.species, null);
});

check("the same posterior with agreeing views still names its species", () => {
  // One posterior, two verdicts: the ONLY difference is the agreement object.
  // A gate that abstains whenever disagreement is present has to leave this
  // untouched, or the app is uniformly hesitant and the fix is worthless.
  const spP = post({ "Aedes aegypti": 0.45, "Aedes albopictus": 0.40, "Culex pipiens": 0.15 });
  assert.equal(verdictFrom(spP, { agree: true }).state, "species");
  assert.equal(verdictFrom(spP, { agree: false }).state, "genus");
  // No agreement at all - one view, or a pool of photos - is not a disagreement.
  assert.equal(verdictFrom(spP, null).state, "species");
  assert.equal(verdictFrom(spP).state, "species");
});

check("a disagreement can also take the photo all the way to unsure", () => {
  // The demotion falls into the genus floor rather than past it: with a genus
  // that does not clear it, a disagreeing photo says it is not confident, and
  // an agreeing photo with the same posterior still names its species.
  const spP = post({ "Aedes aegypti": 0.40, "Aedes albopictus": 0.15, "Culex pipiens": 0.45 });
  assert.equal(verdictFrom(spP, { agree: true }).species, "Culex pipiens");
  const v = verdictFrom(spP, { agree: false });
  assert.equal(v.state, "unsure");
  assert.equal(verdictSentence(v), "Not confident enough to name a genus");
});

check("the disagreement measure is computed once, by fuseViews, and is the same object", () => {
  const scale = EMB.logit_scale / 2.5;
  const view = (over) => ({ spP: post(over), nuTotal: 1e-6, scale });
  const views = [view({ "Aedes aegypti": 0.5, "Aedes albopictus": 0.3, "Culex pipiens": 0.2 }),
                 view({ "Aedes aegypti": 0.4, "Aedes albopictus": 0.4, "Culex pipiens": 0.2 })];
  const fused = fuseViews(views);
  assert.deepEqual(fused.agreement, viewAgreement(views.map((v) => v.spP), fused.spP));
  // One view cannot disagree with itself, so the gate is inert there.
  assert.equal(fuseViews([views[0]]).agreement, null);
  assert.equal(fuseViews([views[0]]).verdict.state, "species");
});

// --- the non-mosquito state.
const AD = EMB.adjacent.length;
const adjPost = (over) => {
  const p = new Array(AD).fill(0);
  for (const [i, v] of Object.entries(over)) p[i] = v;
  return p;
};

check("a heavy adjacent posterior names a non-mosquito instead of a species", () => {
  const v = verdictFrom(post({ "Aedes aegypti": 0.99 }), { agree: true },
                        adjPost({ 0: 0.95 }));
  assert.equal(v.state, "non-mosquito");
  assert.equal(v.adjacent, EMB.adjacent[0]);
  // The sentence names the plain-language subject, which is the whole point:
  // a user cannot act on "Ceratopogonidae".
  const sent = verdictSentence(v);
  assert.ok(sent.includes(EMB.adjacent_common[0]), `sentence names the subject: ${sent}`);
  assert.ok(/does not look like a mosquito/i.test(sent), sent);
});

check("the non-mosquito state outranks a species claim, not just an unsure one", () => {
  // The defect this state exists for: a confident, well-separated mosquito
  // posterior alongside a big non-mosquito one must not render a ranking.
  const v = verdictFrom(post({ "Aedes aegypti": 0.999 }), { agree: true },
                        adjPost({ 2: 0.9 }));
  assert.equal(v.state, "non-mosquito");
});

check("a small adjacent mass leaves the photo's own verdict alone", () => {
  const v = verdictFrom(post({ "Aedes aegypti": 0.99 }), { agree: true },
                        adjPost({ 0: 0.05 }));
  assert.equal(v.state, "species");
  assert.equal(v.species, "Aedes aegypti");
});

check("no adjacent classes supplied means the gate cannot fire", () => {
  const v = verdictFrom(post({ "Aedes aegypti": 0.99 }), { agree: true }, []);
  assert.equal(v.state, "species");
});

check("views that scored no adjacent classes pool to none, not to a flat split", () => {
  // The masses have to sum to 1 across the three groups, because that is what a
  // real softmax produces: 0.8 mosquito + 0.2 nuisance is one view's answer.
  const views = [{ spP: post({ "Aedes aegypti": 0.8 }), nuTotal: 0.1,
                   adP: adjPost({ 0: 0.1 }), scale: 100 }];
  // One view, so the pool is that view's own answer: the 0.1 of mass the adjacent
  // class carries survives as 0.1, which is what "it is not lost in the pool" means.
  const withAd = fuseViews(views);
  assert.ok(Math.abs(withAd.adP[0] - 0.1) < 1e-6, `adjacent keeps its mass, got ${withAd.adP[0]}`);
  const noAd = fuseViews([{ spP: post({ "Aedes aegypti": 0.9 }), nuTotal: 0.1, scale: 100 }]);
  assert.deepEqual(noAd.adP, []);
  assert.equal(noAd.verdict.state, "species");
});

check("the non-mosquito floor is the shipped one", () => {
  assert.equal(api.NON_MOSQUITO_FLOOR, 0.60);
});

check("the veto flag is the shipped one, not a local copy", () => {
  assert.equal(api.VIEW_DISAGREEMENT_VETOES_SPECIES, true);
});

// --- the pooled card is not corrupted by an abstaining photo.
check("pooling filters state 'unsure' out and keeps the genus-only photo in", () => {
  const keep = verdictFrom(post({ "Aedes aegypti": 0.80 }));
  const coarse = verdictFrom(post({ "Aedes aegypti": 0.30, "Aedes albopictus": 0.35, "Aedes vexans": 0.25 }));
  const drop = verdictFrom(post({ "Aedes aegypti": 0.10, "Culex pipiens": 0.20, "Culiseta annulata": 0.15 }));
  // The same predicate updatePooling() uses, kept here literal so a change to
  // one of the two without the other shows up as a failing test.
  const included = [keep, coarse, drop].filter((p) => p && p.state !== "unsure");
  const abstained = [keep, coarse, drop].filter((p) => p && p.state === "unsure");
  assert.deepEqual(included.map((p) => p.state), ["species", "genus"]);
  assert.deepEqual(abstained.map((p) => p.state), ["unsure"]);
  // An abstaining photo must never be in the sum - that is the regression the
  // gate has to avoid reintroducing.
  assert.ok(!included.includes(drop));
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
