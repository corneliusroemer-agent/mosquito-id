/**
 * The pooled card: what a set of photos of one mosquito adds up to.
 *
 * Reads the photos and which of them are included, and draws two things - the
 * pooled ranking with its headline, and a contribution table saying what each
 * photo brought and which were left out. The arithmetic itself is not here: it
 * is in src/confidence/pooling.ts, and this module supplies it with the head and
 * the photos and renders what comes back.
 *
 * A photo whose verdict is not a species or a genus is left out of the sum
 * entirely. That rule belongs to the confidence module, not here; what belongs
 * here is the reason it is visible: an excluded photo is listed with its reason
 * rather than silently contributing nothing.
 */

// pooledVerdict is imported under a distinct name: updatePooling has a local
// variable of the same name holding its RESULT.
import { aggregateAdjacent, aggregateLogits, pooledCandidates, pooledVerdict as pooledVerdictOf,
         poolingWeights, splitPoolable } from "../confidence/pooling";
import type { PoolablePhoto, PoolingMethod } from "../confidence/pooling";
import type { Head } from "../confidence/types";
import { verdictSentence } from "../confidence/verdict";
import { escapeHtml, speciesLabelHtml } from "./speciesLabels";
import { inclusionSummary } from "./thumbnailStrip";

// ---- Pooling / Evidence Aggregation ----
export function updatePooling(head: Head, previews: PoolablePhoto[], includedIndices: Iterable<number>): void {
  const poolScores = document.getElementById("combined-scores");
  if (!poolScores) throw new Error("#combined-scores is missing from the page");
  const contribTable = document.getElementById("contribution-table")?.querySelector("tbody");
  if (!contribTable) throw new Error("#contribution-table has no tbody");
  const summary = document.getElementById("inclusion-summary");

  // An index the strip wrote that no longer names a photo is dropped here, and the
  // drop is counted rather than swallowed. The strip re-validates the set on every
  // render, so this is a backstop - but a backstop that reports itself is a
  // backstop; one that drops in silence is how three ticked boxes reached a card
  // counting one of them.
  const wanted = Array.from(includedIndices);
  const checked = wanted.map((i) => previews[i]).filter((p): p is PoolablePhoto => Boolean(p));
  const unresolved = wanted.length - checked.length;
  // A photo whose crop is being re-classified, or whose classification failed,
  // has no verdict that matches its pixels. Pooling it would fold the previous
  // crop's evidence into the combined result, so it is left out. Its own row in
  // the results table stays empty until it has a verdict, which is where the
  // card's header count and the table agree with each other.
  // A photo the classifier is not confident about at all - neither a species
  // nor a genus - is LEFT OUT of the pooled combination entirely. Its fused
  // logits are still a real posterior, and summing them in is what made the
  // earlier parked abstention work a regression: the pooled card would fold in
  // a species the app had just declined to name, which is worse than not
  // gating at all. A photo that reached only the genus state does still
  // contribute, because its evidence is sound and only its resolution is
  // coarser; it is marked as such below rather than dropped.
  // A photo the gate called NOT a mosquito is left out on the same grounds as one
  // it could not name: its evidence is about a different subject, so pooling it
  // would fold a midge's logits into a mosquito's posterior. Anything other than a
  // species or genus verdict is therefore excluded, which is what makes the
  // non-mosquito state safe to introduce without a second filter here.
  const { included, abstained } = splitPoolable(checked);

  // Both counts, always. A checked photo that does not enter the sum is
  // legitimate - it is listed in the contribution table with its reason - but
  // three ticked boxes beside a table listing one of them reads as a bug unless
  // the card says so itself.
  if (summary) {
    summary.textContent = inclusionSummary(checked.length, included.length);
    summary.title = unresolved
      ? `${unresolved} checked index${unresolved === 1 ? "" : "es"} no longer name${unresolved === 1 ? "s" : ""} a photo`
      : "";
  }

  if (included.length <= 1) {
    // The card is permanent, so the empty case is drawn rather than hidden:
    // hiding it resized the whole row above the gallery, and zooming re-pools,
    // so it flickered out whenever the transient selection changed.
    poolScores.innerHTML =
      '<p class="hint" style="margin:0;">Check two or more photos of the same mosquito to combine their results.</p>';
    contribTable.innerHTML = "";
    return;
  }

  // Both are the pooling controls in index.html: a radio and a range input.
  const rawMethod = (document.querySelector('input[name="pooling-method"]:checked') as HTMLInputElement | null)?.value;
  // The radios in index.html offer exactly these four; anything else (a stale
  // saved preference, a hand-edited DOM) falls back rather than pooling by a
  // method the arithmetic has no case for.
  const METHODS: readonly PoolingMethod[] = ["Equal weight", "Weight by lead", "Accumulate evidence", "Dependent evidence"];
  const selectedMethod: PoolingMethod = (METHODS as readonly string[]).includes(rawMethod ?? "")
    ? (rawMethod as PoolingMethod)
    : "Dependent evidence";
  const slider = document.getElementById("corr-slider") as HTMLInputElement | null;
  const r = parseFloat(slider?.value ?? "") || 0.5;

  const weights = poolingWeights(included, selectedMethod, r);

  const aggLogits = aggregateLogits(head, included, weights);

  // The same sum for the adjacent (non-mosquito) classes, so the pooled card can
  // say "this is not a mosquito" instead of being structurally unable to ask.
  const aggAdjLogits = aggregateAdjacent(head, included, weights);

  // Relative Log Scores (Axis: -20 to 0)
  const candidates = pooledCandidates(head, aggLogits);

  // The pooled genus headline. Derived from the POOLED posterior - the softmax of
  // the aggregated logits - and gated by the same verdictFrom/verdictSentence the
  // per-photo line uses, so "confident enough" means one thing in the app.
  //
  // Softmax of the aggregate, not a mean of per-photo verdicts: the logits already
  // are the per-photo log-probabilities up to a constant (a photo's logits are
  // scale*cos, and log p = scale*cos - logZ), so softmax(aggLogits) is the pooled
  // posterior exactly, and one pooled gate on it is the pooled claim. Averaging
  // per-photo verdicts instead would let two confident photos averaging to a
  // confident mean outvote a third that pooled with them says nobody knows.
  //
  // A per-photo `unsure` photo is already excluded from `included` above, so it
  // is absent from this aggregate as well - the pooled headline cannot name a
  // genus the pool itself refused to name.
  //
  // `included` is passed so the pool can also gate its SPECIES claim on the
  // photos rather than on its own sharpened posterior: see pooledVerdict().
  const pooledVerdict = pooledVerdictOf(head, aggLogits, included, aggAdjLogits);
  const pooledLine = pooledVerdict ? verdictSentence(pooledVerdict) : "";

  poolScores.innerHTML = "";
  // A species-state verdict renders an empty sentence on purpose: the ranking
  // below already leads with the binomial, and a headline that repeated it added
  // nothing. So the line appears only when the pooled gate has something coarser
  // to say, and is absent entirely when the pool is a confident species.
  if (pooledLine) {
    const headline = document.createElement("div");
    headline.className = "combined-genus-headline" + (pooledVerdict!.state === "genus" ? " is-genus" : "");
    // Full text in the tooltip; the box is one line tall whatever the genus is.
    headline.textContent = pooledLine;
    headline.title = pooledLine;
    poolScores.appendChild(headline);
  }
  candidates.slice(0, 10).forEach(c => {
    const row = document.createElement("div");
    row.className = "combined-candidate";
    // Same non-finite guard as the single-photo score list above.
    const relFinite = Number.isFinite(c.relScore);
    const widthPct = relFinite ? Math.max(0, Math.min(100, ((c.relScore + 20) / 20) * 100)) : 0;
    row.innerHTML = `
      <div class="combined-score-row">
        <span class="species-name-wrap">${speciesLabelHtml(c.name)}</span>
        <span>${relFinite ? c.relScore.toFixed(1) : ""}</span>
      </div>
      <div class="combined-bar-track">
        <div class="combined-bar" style="width: ${widthPct}%"></div>
      </div>
    `;
    poolScores.appendChild(row);
  });

  // Contribution Table
  contribTable.innerHTML = "";
  const sumW = weights.reduce((a, b) => a + b, 0) || 1e-6;
  included.forEach((p, idx) => {
    const tr = document.createElement("tr");
    const share = (((weights[idx] ?? 0) / sumW) * 100).toFixed(1);
    // A genus-state photo is in the sum, so it says which claim it brought.
    const note = p.verdict?.state === "genus"
      ? `<br><span class="contrib-note">genus only: ${escapeHtml(p.verdict.genus)}</span>` : "";
    tr.innerHTML = `<td>${escapeHtml(p.name)}${note}</td><td style="text-align:right">${share}%</td>`;
    contribTable.appendChild(tr);
  });
  // Photos left out of the sum are listed too, with the reason. A checked photo
  // that silently contributes nothing reads as a bug in the app; one that is
  // listed as excluded reads as what it is.
  abstained.forEach((p) => {
    const tr = document.createElement("tr");
    tr.className = "row-excluded";
    tr.innerHTML = `<td>${escapeHtml(p.name)}<br><span class="contrib-note">excluded - not confident enough to name a genus</span></td><td style="text-align:right">-</td>`;
    contribTable.appendChild(tr);
  });
}
