import type { Agreement, Floors, Head, RunnerUp, Verdict } from "./types";
import { DEFAULT_FLOORS } from "./types";
import { adjacentNames, informativeRows } from "./softmax";
import { speciesGenusIndex } from "./genus";

/** What tripped the non-mosquito gate, and what it is called. */
export interface GateHit {
  /**
   * "adjacent" - a different insect family, which the app can name and the user
   * can act on. "nuisance" - nothing mosquito-like in the picture, where there is
   * no family to name and saying one would be a guess dressed as a finding.
   */
  kind: "adjacent" | "nuisance";
  /** The winning class's label, from the block named by `kind`. */
  name: string;
  /** The plain-language name, for the adjacent block, where the head carries one. */
  common: string;
  /** The winning class's own posterior - not its block's total. */
  p: number;
  /** The block's total mass, which is what the floor was compared against. */
  mass: number;
}

/**
 * Has this photo been shown to contain no mosquito? Returns the winning block, or
 * null if it has not.
 *
 * The gate exists because "this is not a mosquito" is a claim about the
 * PHOTOGRAPH, and so has to outrank every species claim rather than sit beside one.
 * It is checked before the species and genus floors, so a photo the classifier is
 * confident about AND that is not an insect is answered as the latter.
 *
 * Two blocks, two floors, and the reason they are not one is arithmetic rather
 * than taste: `softmaxJoint` puts species, nuisance and adjacent in ONE softmax,
 * and the nuisance mass over the measured negatives tops out at 0.498 against a
 * species floor of 0.373. A shared 0.60 would leave the nuisance path unreachable,
 * which is the defect this function exists to fix. A shared LOW floor would let
 * adjacent mass - which is an order of magnitude larger on true mosquitoes - reject
 * healthy photos.
 *
 * It used to read the adjacent block alone, which is why a photograph of a wall
 * could be named a species: the eight nuisance rows are literally photographs of
 * walls, hands, plants and empty backgrounds, and the gate never saw them.
 *
 * When both blocks clear, the one whose winning class is more certain wins: that
 * is the claim the photo is actually making, and mixing the two into one message
 * would name a family on the strength of a wall.
 *
 * Only rows that can tell photographs apart are read (see informativeRows). The
 * shipped BioCLIP heads have no rows that cannot, so this changes nothing there;
 * culico's head does, and on it the nuisance block is entirely such rows, which is
 * why that block never fires on culico and why it used to fire on 58% of the
 * in-domain mosquitoes instead.
 */
export function nonMosquitoGate(
  head: Head,
  adP: number[] | undefined | null,
  nuP: number[] | undefined | null,
  floors: Floors = DEFAULT_FLOORS,
): GateHit | null {
  // Only rows that can tell one photograph from another count. A block with no
  // such rows is not a weak detector, it is no detector, and a floor over its
  // constant mass is a floor the gate can clear by being unsure - so it is not
  // read at all. See informativeRows.
  const keep = (
    base: Float32Array | number[] | undefined,
    n: number,
  ): boolean[] => informativeRows(head, base, n);

  const block = (
    p: number[] | undefined | null,
    informative: boolean[],
  ): { i: number; p: number; mass: number } => {
    let i = -1;
    let top = 0;
    let mass = 0;
    for (let k = 0; k < (p?.length ?? 0); k++) {
      if (!informative[k]) continue;
      const v = p![k]!;
      if (!Number.isFinite(v)) continue;
      mass += v;
      if (v > top) {
        top = v;
        i = k;
      }
    }
    return { i, p: top, mass };
  };

  const ad = block(adP, keep(head.adjacent_emb, adjacentNames(head).length));
  const nu = block(nuP, keep(head.nuisance_emb, head.nuisance?.length ?? 0));
  const adjNames = adjacentNames(head);

  const adjHit =
    ad.i >= 0 && ad.mass >= floors.nonMosquito
      ? { kind: "adjacent" as const, name: adjNames[ad.i] ?? "", common: (head.adjacent_common || [])[ad.i] || adjNames[ad.i] || "", p: ad.p, mass: ad.mass }
      : null;
  const nuHit =
    nu.i >= 0 && nu.mass >= floors.nuisance
      ? { kind: "nuisance" as const, name: (head.nuisance || [])[nu.i] ?? "", common: (head.nuisance || [])[nu.i] ?? "", p: nu.p, mass: nu.mass }
      : null;

  if (adjHit && nuHit) return adjHit.p >= nuHit.p ? adjHit : nuHit;
  return adjHit || nuHit;
}

/**
 * The one class the non-mosquito verdict names, with the mass the gate compared
 * its floor against.
 *
 * The score panel used to promote the highest-scoring ADJACENT class whatever the
 * verdict had said, which put an adjacent family on top of a nuisance verdict -
 * and, on a head whose adjacent rows are placeholders that all tie, put whichever
 * one came first in the file on top of every refusal. The panel now shows the
 * class the verdict actually named, or nothing when the verdict named none.
 */
export function nonMosquitoLabel(
  v: Verdict | null | undefined,
): { name: string; p: number } | null {
  if (!v || v.state !== "non-mosquito") return null;
  const name =
    v.nonMosquitoKind === "nuisance"
      ? v.nuisance
      : v.adjacentCommon || v.adjacent;
  if (!name) return null;
  return { name, p: v.nonMosquitoP || 0 };
}

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
  // The nuisance posteriors, index-aligned with `head.nuisance`. OPTIONAL, unlike
  // `adP`: a caller that has none says so by omitting it, and the gate reads the
  // adjacent block alone exactly as it did before. Every path that has them passes
  // them - `fuseViews` does, and `fuseViews` is what every fused photo goes
  // through - so nothing reaches this in production without them.
  nuP: number[] = [],
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

  const hit = nonMosquitoGate(head, adP, nuP, floors);
  if (hit) {
    return {
      state: "non-mosquito",
      genus: null,
      species: null,
      topGenusP,
      topSpeciesP,
      runnersUp: [],
      // Exactly one of these two is set. A photo of a wall gets `nuisance` and no
      // family; a midge gets `adjacent` and its family. Carrying both would let a
      // consumer name a family on a photo of bare background.
      ...(hit.kind === "adjacent"
        ? { adjacent: hit.name, adjacentCommon: hit.common }
        : { nuisance: hit.name }),
      nonMosquitoKind: hit.kind,
      adjacentP: hit.p,
      nonMosquitoP: hit.mass,
    };
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
  // Abstaining. `candidates` is the leading species ACROSS genera, which is not
  // `runnersUp`: with no genus named, the photo may be torn between two of them,
  // and their siblings are not the tie being reported.
  const candidates: RunnerUp[] = spP
    .map((p, i) => ({ name: head.species[i]!, p: p || 0 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 3);
  return {
    state: "unsure",
    genus: null,
    species: null,
    topGenusP,
    topSpeciesP,
    topSpecies: speciesName,
    runnersUp,
    candidates,
  };
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
    const pct = Math.round((v.nonMosquitoP || 0) * 100);
    // The two blocks are two different answers and are worded as such. A midge is
    // a finding, so it is named. A wall is an absence, so it is reported as one
    // rather than dressed up with a family that was never in the picture.
    if (v.nonMosquitoKind === "nuisance") {
      return `There is no mosquito in this photo - it looks like ${v.nuisance} (${pct}% of the match).`;
    }
    const what = v.adjacentCommon || v.adjacent;
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
  // Abstaining. "Not confident enough to name a genus" alone is true of every
  // unconfident photo and so says nothing about this one; the sentence names what
  // it is torn between, which is the only thing a reader can act on. Two
  // candidates is enough to show which way it leans - the ranking underneath
  // carries every probability, and naming four would be noise over that.
  const short = (n: string) => {
    const parts = n.trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : n;
  };
  const cands = (v.candidates || []).slice(0, 3).map((c) => short(c.name));
  if (cands.length === 0) return "Not confident enough to name a genus";
  if (cands.length === 1) return `Not confident enough to name a genus - most likely ${cands[0]}`;
  if (cands.length === 2) return `Not confident enough to name a genus - between ${cands[0]} and ${cands[1]}`;
  return `Not confident enough to name a genus - between ${cands[0]}, ${cands[1]} and ${cands[2]}`;
}