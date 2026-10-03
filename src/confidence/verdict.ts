import type { Agreement, Floors, Head, Verdict } from "./types";
import { DEFAULT_FLOORS } from "./types";
import { adjacentNames } from "./softmax";
import { speciesGenusIndex } from "./genus";

/**
 * What the classifier will claim about one photo, from a single posterior.
 *
 * `spP` is the FUSED species posterior - never a single view's. Gating per view
 * would abstain far more often than the photo deserves, because fusion is what
 * turns two undecided views into a decided one, and it would make the two views
 * disagree about the same photo's verdict.
 *
 * `agreement` is viewAgreement()'s object for those same views, or null where
 * there are no two views to disagree (a pool of photos is one claim, not a
 * photo). It carries no posterior of its own: it only says whether the views
 * that produced `spP` named the same species. The gate reading a fused
 * posterior alone cannot see that the average it is reading is an average of a
 * contradiction.
 *
 * The genus posterior is its species' posteriors summed, so it is larger than
 * any single species posterior by construction: that is why it clears a higher
 * floor rather than the same one.
 *
 * Returns the unsure state rather than throwing on an empty or non-finite
 * posterior, so a malformed score array degrades to "not confident" instead of
 * taking the page down.
 */
export function verdictFrom(
  head: Head,
  spP: number[],
  agreement: Agreement | null = null,
  adP: number[] = [],
  floors: Floors = DEFAULT_FLOORS,
): Verdict {
  if (!spP || !spP.length || spP.some((p) => !Number.isFinite(p))) {
    return { state: "unsure", genus: null, species: null, topGenusP: 0, topSpeciesP: 0, runnersUp: [] };
  }
  const { idx } = { idx: speciesGenusIndex(head) };
  const genP: [string, number][] = [];
  for (const [g, members] of idx) {
    genP.push([g, members.reduce((a, i) => a + (spP[i] || 0), 0)]);
  }
  genP.sort((a, b) => b[1] - a[1]);
  const [topGenus, topGenusP] = genP[0]!;

  let topSpecies = 0;
  for (let i = 1; i < spP.length; i++) if (spP[i]! > spP[topSpecies]!) topSpecies = i;
  const topSpeciesP = spP[topSpecies] || 0;
  const speciesName = head.species[topSpecies]!;

  // The species it leaned toward, inside the genus being named: the claim is
  // "one of these", so the runners-up have to be siblings or the sentence would
  // name a species from another genus.
  const runnersUp = (idx.get(topGenus) || [])
    .filter((i) => i !== topSpecies)
    .sort((a, b) => (spP[b] || 0) - (spP[a] || 0))
    .map((i) => ({ name: head.species[i]!, p: spP[i] || 0 }));

  // "This is not a mosquito", which is a claim about the photograph and so has
  // to outrank every species claim rather than sit beside one.
  //
  // It is checked FIRST, on the non-mosquito mass alone. Measured on the
  // 6,264-row in-domain cache this costs 0.67% of true mosquitoes, which is why
  // the mass has to clear a floor rather than merely beat the best species - the
  // in-domain negative benchmark that would settle a lower floor did not exist
  // when this was written. Neither number here is fitted.
  if (adP && adP.length) {
    const nonMosquito = adP.reduce((a, b) => a + b, 0);
    if (nonMosquito >= floors.nonMosquito) {
      let top = 0;
      for (let i = 1; i < adP.length; i++) if (adP[i]! > adP[top]!) top = i;
      const names = adjacentNames(head);
      return {
        state: "non-mosquito",
        genus: null,
        species: null,
        topGenusP,
        topSpeciesP,
        runnersUp: [],
        adjacent: names[top],
        adjacentCommon: (head.adjacent_common || [])[top] || names[top],
        adjacentP: adP[top],
        nonMosquitoP: nonMosquito,
      };
    }
  }

  // A species claim needs the photo's views to have agreed as well as the fused
  // posterior to be high. The veto demotes into the genus branch below rather
  // than past it, so whether the photo gets a genus or nothing is still the
  // genus floor's call and not this one's.
  const vetoed = Boolean(
    agreement && !agreement.agree && floors.viewDisagreementVetoesSpecies,
  );
  if (!vetoed && topSpeciesP >= floors.species) {
    return { state: "species", genus: topGenus, species: speciesName, topGenusP, topSpeciesP, runnersUp };
  }
  if (topGenusP >= floors.genus) {
    return { state: "genus", genus: topGenus, species: null, topGenusP, topSpeciesP, runnersUp };
  }
  return { state: "unsure", genus: null, species: null, topGenusP, topSpeciesP, runnersUp };
}

/**
 * The sentence the score panel leads with. It is a claim about the photograph,
 * never about our machinery: there is deliberately no "analysing" state here.
 */
export function verdictSentence(v: Verdict | null | undefined): string {
  if (!v) return "";
  if (v.state === "species") return "";
  // The one state that names what it saw instead of what it did not: the ranking
  // below it is a list of mosquitoes this photo was not, so the sentence has to
  // come first and has to be about the subject.
  if (v.state === "non-mosquito") {
    const what = v.adjacentCommon || v.adjacent;
    const pct = Math.round((v.nonMosquitoP || 0) * 100);
    return `This does not look like a mosquito - it looks like ${what} (${pct}% of the match).`;
  }
  if (v.state === "genus") {
    // "Definitely Aedes - maybe aegypti or albopictus". Two runners-up is enough
    // to say which way it is torn; more is noise, and the ranking below already
    // carries every one of them.
    const names = [v.runnersUp[0], v.runnersUp[1]].filter(Boolean).map((r) => {
      const parts = r!.name.trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(" ") : r!.name;
    });
    if (!names.length) return `Definitely ${v.genus}`;
    if (names.length === 1) return `Definitely ${v.genus} - maybe ${names[0]}`;
    return `Definitely ${v.genus} - maybe ${names[0]} or ${names[1]}`;
  }
  return "Not confident enough to name a genus";
}
