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
  agreement: Agreement | null,
  // REQUIRED, and passing `[]` is not the same as omitting it by accident.
  //
  // The pooled card called this with one argument, so `adP` arrived `undefined`,
  // the non-mosquito branch never ran, and three photos each reading 97% biting
  // midge were announced as a species - because pooledPosterior softmaxes over
  // the 16 species alone, so the adjacent mass was in neither the numerator nor
  // the denominator and the species posteriors summed to 1 as if nothing else
  // existed. That was invisible: `undefined` is exactly what an omitted optional
  // argument looks like, and it did the same thing as the deliberate `[]` the
  // single-view path passes.
  //
  // Required so a caller cannot reach this by forgetting an argument again. A
  // caller with genuinely no adjacent evidence - the pooled card, for now -
  // passes `[]` in full view, which is a decision someone can see and grep for
  // rather than an omission that reads as intent.
  adP: number[],
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
    return {
      state: "species",
      genus: topGenus,
      species: speciesName,
      topSpecies: speciesName,
      topGenusP,
      topSpeciesP,
      runnersUp,
    };
  }
  if (topGenusP >= floors.genus) {
    // `species` stays null here because the verdict does not CLAIM a species: it is
    // under the species floor, or the views disagreed and the veto demoted it. But
    // the winner is still the most likely species, and the sentence needs it in
    // order to rank the genus's members - `runnersUp` excludes it by construction,
    // so dropping it left the sentence naming only the second and third place.
    return {
      state: "genus",
      genus: topGenus,
      species: null,
      topSpecies: speciesName,
      topGenusP,
      topSpeciesP,
      runnersUp,
    };
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
    // The winner is `v.species`, not the head of `runnersUp`: `runnersUp` is
    // every sibling EXCEPT it, so leading with the runners-up named the second
    // and third place and dropped the most likely species entirely. The ranking
    // below the sentence already carries every probability; this line has to
    // rank them in words, or it reads as though the top three were a tie.
    const short = (n: string) => {
      const parts = n.trim().split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(" ") : n;
    };
    // No winner recorded: the genus is still the claim, so fall back to the
    // runners-up rather than dropping them. This happens when every species in
    // the genus sits under the species floor while the genus total clears the
    // genus floor, which is the ordinary genus-only outcome.
    const lead = v.topSpecies;
    if (!lead) {
      if (!names.length) return `Definitely ${v.genus}`;
      if (names.length === 1) return `Definitely ${v.genus} - maybe ${names[0]}`;
      return `Definitely ${v.genus} - maybe ${names[0]} or ${names[1]}`;
    }
    if (!names.length) return `Definitely ${v.genus} - most likely ${short(lead)}`;
    return `Definitely ${v.genus} - most likely ${short(lead)}, possibly ${names[0]} or ${names[1]}`;
  }
  return "Not confident enough to name a genus";
}
