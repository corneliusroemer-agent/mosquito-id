import type { Head } from "./types";
import { genusOf } from "./genus";

export interface GenusScores {
  /** Genus -> summed species posterior. */
  labels: Record<string, number>;
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
 * This replaced a species-complex grouping, which reported the same number
 * twice whenever a complex held a single species - the common case, since most
 * of the label set is one species per complex - and offered no column that said
 * anything the species column did not.
 *
 * There is deliberately no low-confidence demotion here. One existed, keyed on
 * the cosine gap between the best species of the top two genera, and it was
 * decorative: on the labelled corpus it changed the genus of 0 of 69 species
 * errors, and every test passed with its threshold set to 99 - i.e. with the
 * demotion permanently on and no longer meaningful. The cosines it needed were
 * passed in from the fusion purely to feed it, and the recovered-cosine
 * derivation they required went with it. The genus floor in verdictFrom is the
 * one rule that decides whether a genus may be named, and it reads the
 * posterior, which is the quantity the corpus can actually falsify.
 */
export function genusScores(head: Head, spP: number[]): GenusScores {
  const comp: Record<string, number> = {};
  head.species.forEach((name, i) => {
    const k = genusOf(name);
    comp[k] = (comp[k] || 0) + (spP[i] || 0);
  });
  const labels: Record<string, number> = {};
  Object.entries(comp)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      labels[k] = v;
    });
  return { labels };
}
