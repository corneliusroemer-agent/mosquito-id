import type { Floors, Head } from "./types";
import { DEFAULT_FLOORS } from "./types";
import { genusOf } from "./genus";

export interface GenusScores {
  /** Genus -> summed species posterior. A demoted genus is keyed "<Genus> - low confidence". */
  labels: Record<string, number>;
  /** True when the top two genera are within GENUS_MARGIN of each other in cosine. */
  demoted: boolean;
}

/**
 * Group the species posteriors by genus - the first whitespace-delimited word of
 * the label - and report the summed posterior per genus.
 *
 * The split is on whitespace, not on the second word, because the label set
 * carries compound names ("Culiseta annulata/morsitans", "Aedes
 * japonicus/koreicus") where the slash joins two epithets inside one genus.
 * Splitting anywhere else would put half of Culiseta under Culiseta and half
 * under "annulata/morsitans".
 *
 * The demotion compares the best cosine inside each of the top two genera, not
 * their summed posterior: two genera can have equal mass and be separated by a
 * clear margin, and only the cosine says whether the classifier actually pulled
 * them apart.
 *
 * This replaced a species-complex grouping, which reported the same number
 * twice whenever a complex held a single species - the common case, since most
 * of the label set is one species per complex - and offered no column that said
 * anything the species column did not.
 */
export function genusScores(
  head: Head,
  spP: number[],
  spCos: number[],
  floors: Floors = DEFAULT_FLOORS,
): GenusScores {
  const comp: Record<string, number> = {};
  head.species.forEach((name, i) => {
    const k = genusOf(name);
    comp[k] = (comp[k] || 0) + (spP[i] || 0);
  });
  const ranked = Object.entries(comp).sort((a, b) => b[1] - a[1]);

  const topGenus = ranked[0]![0];
  const secondGenus = ranked.length > 1 ? ranked[1]![0] : null;
  let topCos = -Infinity;
  let secCos = -Infinity;
  head.species.forEach((name, i) => {
    const k = genusOf(name);
    if (k === topGenus && spCos[i]! > topCos) topCos = spCos[i]!;
    else if (k === secondGenus && spCos[i]! > secCos) secCos = spCos[i]!;
  });

  const demoted = secondGenus !== null && topCos - secCos < floors.genusMargin;
  const labels: Record<string, number> = {};
  ranked.forEach(([k, v]) => {
    labels[k] = v;
  });
  if (demoted) {
    const winner = ranked[0]![0];
    // The reported label is already a genus, so the hedge is a plain confidence
    // note rather than a drop to genus level.
    const demotedLabel = winner + " - low confidence";
    const val = labels[winner]!;
    delete labels[winner];
    return { labels: { [demotedLabel]: val, ...labels }, demoted: true };
  }
  return { labels, demoted: false };
}
