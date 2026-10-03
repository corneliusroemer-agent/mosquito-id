// The pooled card builds a posterior and calls verdictFrom on it, but it never
// passes the adjacent posterior, so the non-mosquito branch cannot run. This is
// the production failure from the 2026-10-03 screenshot: three blank wall photos,
// pooled, and the card names a species.
//
// Run: node --test tests/pooled-gate.test.mjs
// Reproduce the pooled card's call site against the real verdictFrom, using the
// repo's own harness approach: pull the functions out of main.js and run them.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const EMBS = JSON.parse(readFileSync(new URL('../text_embeds.json', import.meta.url), 'utf8'));
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
};
const num = (n) => parseFloat(src.match(new RegExp(`^const ${n} = ([\\d.]+);$`, 'm'))[1]);
globalThis.__EMB = EMBS;
const harness = `
const EMB = globalThis.__EMB;
let genusIndexCache = null;
${grab('genusOf')}
${grab('speciesGenusIndex')}
${grab('adjacentNames')}
const ADJACENT_DEFAULT = [];
const SPECIES_CONFIDENCE_FLOOR = ${num('SPECIES_CONFIDENCE_FLOOR')};
const GENUS_CONFIDENCE_FLOOR = ${num('GENUS_CONFIDENCE_FLOOR')};
const VIEW_DISAGREEMENT_VETOES_SPECIES = true;
const NON_MOSQUITO_FLOOR = ${num('NON_MOSQUITO_FLOOR')};
${grab('verdictFrom')}
globalThis.__vf = verdictFrom;
`;
(0, eval)(harness);
const verdictFrom = globalThis.__vf;
const S = EMBS.species.length, A = EMBS.adjacent.length;

// A pool whose non-mosquito evidence is overwhelming: 8% of mass on mosquitoes,
// 92% on Ceratopogonidae. This is exactly what fuseViews would produce for three
// photos that all land on a biting midge, if the caller passed adP along.
const spP = new Array(S).fill(0.08 / S);
const adP = new Array(A).fill(0);
adP[0] = 0.92;


import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the pooled call site cannot return non-mosquito, however lopsided the pool', () => {
  const spP = new Array(S).fill(0.08 / S);
  const adP = new Array(A).fill(0);
  adP[0] = 0.92;                       // 92% of the pool on Ceratopogonidae
  assert.equal(verdictFrom(spP, undefined, adP).state, 'non-mosquito');
  // This is what updatePooling does: verdictFrom(pooledSpP). `adP` is undefined,
  // so `if (adP && adP.length)` is false and the whole branch is skipped.
  assert.equal(verdictFrom(spP).state, 'unsure');
  assert.equal(verdictFrom(spP, { agree: true }).state, 'unsure');
});

test('so the pooled card falls through to the species floor on a blank wall', () => {
  const spP = new Array(S).fill(0);
  spP[0] = 0.97;                       // what a species-only softmax produces here
  assert.equal(verdictFrom(spP).state, 'species');
});
