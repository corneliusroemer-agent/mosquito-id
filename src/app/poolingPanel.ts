/**
 * The pooled card: what a set of photos of one mosquito adds up to.
 *
 * Reads the photos and which of them are included, and draws two things - the
 * pooled ranking with its headline, and a contribution table saying what each
 * photo brought and which were left out. The arithmetic itself is not here: it
 * is in src/confidence/pooling.ts, and this module supplies it with the head and
 * the photos and renders what comes back.
 *
 * The rule that decides which photos are in the sum, and at what weight, belongs
 * to the confidence module, not here. What belongs here is the reason it is
 * visible: a photo that is counted below full weight says so, and one that is
 * excluded is listed with the reason rather than silently contributing nothing.
 */

// pooledVerdict is imported under a distinct name: updatePooling has a local
// variable of the same name holding its RESULT.
import { aggregateAdjacent, aggregateLogits, aggregateNuisance, pooledCandidates,
         pooledVerdict as pooledVerdictOf, poolingWeights, splitPoolable } from "../confidence/pooling";
import type { PoolablePhoto, PoolingMethod } from "../confidence/pooling";
import type { Head } from "../confidence/types";
import { escapeHtml, speciesLabelHtml } from "./speciesLabels";
import { inclusionSummary } from "./thumbnailStrip";
import { claimSentence } from "./granularity";

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
  // A photo the classifier is not confident about - neither a species nor a
  // genus - IS pooled, at a fraction of a named photo's weight: see
  // unsurePoolWeight. It used to be dropped, which meant a user could tick a box
  // beside a photo and watch it contribute nothing. It can now corroborate a
  // pool that already agrees and cannot overrule one, and because
  // pooledVerdict() requires every pooled photo to have claimed a species, its
  // presence in the pool caps the pooled claim at a genus.
  // A photo the gate called NOT a mosquito is excluded outright: its evidence is
  // about a different subject, and it is evidence against every species rather
  // than weakly for one, so there is no small enough weight to fold it in at.
  const { included, excluded } = splitPoolable(checked);

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
  // The nuisance block too - walls, hands, empty background. The adjacent rows
  // say a specific other insect; these say nothing mosquito-like is here, which
  // is the claim a pool of blank backgrounds needs to be able to make.
  const aggNuLogits = aggregateNuisance(head, included, weights);

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
  // An `unsure` photo is in `included` and so in this aggregate, down-weighted.
  // The pooled headline still cannot name a species while one is present: the
  // gate below reads the photos, not just the sharpened posterior.
  //
  // `included` is passed so the pool can also gate its SPECIES claim on the
  // photos rather than on its own sharpened posterior: see pooledVerdict().
  const pooledVerdict = pooledVerdictOf(head, aggLogits, included, aggAdjLogits, aggNuLogits);
  // claimSentence, not verdictSentence: the rows below already go through
  // speciesLabelHtml and so already refuse to name a species the head cannot
  // separate, and the headline must agree with them rather than print a binomial
  // the ranking is deliberately not showing.
  const pooledLine = pooledVerdict ? claimSentence(pooledVerdict) : "";

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
    // A photo in the sum says what it brought and, if it was counted below full
    // weight, by how much - so the share column is never a bare number whose
    // meaning the reader has to guess.
    const note = p.verdict?.state === "genus"
      ? `<br><span class="contrib-note">genus only: ${escapeHtml(p.verdict.genus)}</span>`
      : p.verdict?.state === "unsure"
        ? `<br><span class="contrib-note">not confident enough to name a genus: counted at ${(p.poolWeight * 100).toFixed(0)}% of a named photo</span>`
        : "";
    tr.innerHTML = `<td>${escapeHtml(p.name)}${note}</td><td style="text-align:right">${share}%</td>`;
    contribTable.appendChild(tr);
  });
  // Photos left out of the sum are listed too, with the reason. A checked photo
  // that silently contributes nothing reads as a bug in the app; one that is
  // listed as excluded reads as what it is.
  excluded.forEach((p) => {
    const tr = document.createElement("tr");
    tr.className = "row-excluded";
    const why = p.excludedBecause === "non-mosquito"
      ? "excluded - the classifier says this is not a mosquito, which is evidence against every species rather than weak evidence for one"
      : "excluded - no verdict matches these pixels yet";
    tr.innerHTML = `<td>${escapeHtml(p.name)}<br><span class="contrib-note">${why}</span></td><td style="text-align:right">-</td>`;
    contribTable.appendChild(tr);
  });
}
