/**
 * Differential test: the pooling logic as it was INLINE in updatePooling(),
 * against the module it now calls.
 *
 * The old implementations are copied verbatim from main.js at the commit that
 * moved them (36c992b). They are here so the move can be PROVEN behaviour-
 * preserving rather than asserted to be: 400 randomised cases over photo counts,
 * verdicts, pooling methods, correlation factors, duplicate fingerprints and
 * pending/errored photos, comparing all five outputs to 1e-9.
 *
 * This is a test with a delete-by date. Once the refactor has settled and the
 * inline copies are no longer load-bearing history, delete this file and the
 * modules it guards speak for themselves.
 */
// @ts-nocheck -- the old implementations below are copied VERBATIM from main.js
// at 36c9922, and strict-mode annotations would be edits to the thing whose
// exact behaviour this file exists to measure. The comparison itself is numeric.
import { describe, it, expect } from "vitest";
import { realHead } from "./fixtures";
import { splitPoolable, poolingWeights, aggregateLogits, pooledCandidates, pooledPosterior }
  from "../src/confidence/pooling";
import { genusOf } from "../src/confidence/genus";

const head = realHead();
// ---- the OLD inline implementations, copied verbatim from main.js -------------
function oldSplit(checked: any[]) {
  const abstained = checked.filter(p => !p.pending && !p.error && p.verdict?.state === "unsure");
  const included = checked.filter(p => !p.pending && !p.error &&
    (p.verdict?.state === "species" || p.verdict?.state === "genus"));
  return { included, abstained };
}
function oldWeights(included: any[], selectedMethod: string, r: number) {
  const N = included.length; const weights: number[] = [];
  const leads = included.map((p: any) => { const s = Object.values(p.scores) as number[]; s.sort((a,b)=>b-a); return (s[0]||0)-(s[1]||0); });
  if (selectedMethod === "Equal weight") { for (let i=0;i<N;i++) weights.push(1/N); }
  else if (selectedMethod === "Weight by lead") { const t = leads.reduce((a,b)=>a+b,0)||1e-6; for (let i=0;i<N;i++) weights.push(leads[i]/t); }
  else if (selectedMethod === "Accumulate evidence") { for (let i=0;i<N;i++) weights.push(1); }
  else { const seen=new Set(); const eff:number[]=[]; included.forEach(p=>{ if(seen.has(p.fingerprint)) eff.push(0); else {seen.add(p.fingerprint); eff.push(1);} });
         const d=1+(seen.size-1)*r; for(let i=0;i<N;i++) weights.push(eff[i]/d); }
  return weights;
}
function oldAgg(included: any[], weights: number[]) {
  const agg: Record<string,number> = {}; head.species.forEach(sp => { agg[sp]=0; });
  included.forEach((p,i)=>{ const w=weights[i]; if (w>0 && p.logits) head.species.forEach(sp=>{ agg[sp] += (p.logits[sp]||0)*w; }); });
  return agg;
}
function oldCandidates(agg: Record<string,number>) {
  const maxLogit = Math.max(...Object.values(agg));
  return head.species.map(sp => ({ name: sp, genus: genusOf(sp), relScore: agg[sp]-maxLogit }))
    .sort((a,b)=>b.relScore-a.relScore);
}
function oldPooled(agg: Record<string,number>) {
  const vals = head.species.map(sp=>agg[sp]);
  if (!vals.length || vals.some(v=>!Number.isFinite(v))) return null;
  const max=Math.max(...vals); const ex=vals.map(v=>Math.exp(v-max)); const t=ex.reduce((a,b)=>a+b,0);
  if (!(t>0)||!Number.isFinite(t)) return null; return ex.map(e=>e/t);
}

// ---- randomized comparison ---------------------------------------------------
let seed = 12345;
const rnd = () => { seed = (seed*1103515245+12345) & 0x7fffffff; return seed/0x7fffffff; };
describe("updatePooling's arithmetic is unchanged by moving it into a module", () => {
  it("matches the old inline implementation on 400 randomised cases", () => {
let n = 0;
for (let trial=0; trial<400; trial++) {
  const count = 2 + Math.floor(rnd()*5);
  const photos = Array.from({length: count}, (_,i) => {
    const scores: Record<string,number> = {};
    head.species.forEach(s => { scores[s] = rnd()*2 - 1; });
    const logits: Record<string,number> = {};
    head.species.forEach(s => { logits[s] = rnd()*40 - 20; });
    const st = rnd() < 0.2 ? "unsure" : rnd() < 0.5 ? "genus" : "species";
    return { name:`p${i}`, fingerprint: rnd()<0.3 ? "dup" : `f${i}`, scores, logits,
             verdict: { state: st } as any,
             pending: rnd()<0.1, error: rnd()<0.05 ? "x" : null };
  });
  const a = oldSplit(photos); const b = splitPoolable(photos);
  if (a.included.length !== b.included.length) throw new Error(`split included ${a.included.length} vs ${b.included.length}`);
  const method = ["Equal weight","Weight by lead","Accumulate evidence","Dependent evidence"][trial%4];
  const r = [0, 0.25, 0.5, 0.75, 1][trial%5];
  const wa = oldWeights(a.included, method, r);
  const wb = poolingWeights(b.included as any, method as any, r);
  if (wa.length !== wb.length) throw new Error("weights length");
  wa.forEach((v,i)=>{ if (Math.abs(v-wb[i]!) > 1e-12) throw new Error(`weight ${method} r=${r}: ${v} vs ${wb[i]}`); });
  const aa = oldAgg(a.included, wa); const ab = aggregateLogits(head, b.included as any, wb);
  head.species.forEach(s => { if (Math.abs(aa[s]-ab[s]) > 1e-9) throw new Error(`agg ${s}: ${aa[s]} vs ${ab[s]}`); });
  const ca = oldCandidates(aa); const cb = pooledCandidates(head, ab);
  if (ca.length !== cb.length) throw new Error("cand length");
  ca.forEach((c,i)=>{ if (c.name!==cb[i]!.name || Math.abs(c.relScore-cb[i]!.relScore)>1e-9 || c.genus!==cb[i]!.genus)
    throw new Error(`cand ${i}: ${c.name}/${c.relScore} vs ${cb[i]!.name}/${cb[i]!.relScore}`); });
  const pa = oldPooled(aa); const pb = pooledPosterior(head, ab);
  if ((pa===null)!==(pb===null)) throw new Error("pooled nullness differs");
  if (pa && pb) pa.forEach((v,i)=>{ if (Math.abs(v-pb[i]!)>1e-12) throw new Error(`pooled ${i}: ${v} vs ${pb[i]}`); });
  n++;
}
expect(n).toBe(400);
  });
});
