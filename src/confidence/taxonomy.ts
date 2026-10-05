/**
 * Ranks above species, read from the head rather than guessed from the label.
 *
 * **Why a taxonomy ships with the head.** Genus has always been derived by
 * taking the first word of a species label, and for binomial names that is
 * exactly right. It stops being right the moment a head carries anything else,
 * and a head for a broad classifier will:
 *
 * - `"Other Diptera"` has genus `Other`, which is not a genus;
 * - `"not identifiable"` has genus `not`;
 * - a subspecies (`Aedes aegypti aegypti`) is fine by luck, and a
 *   subgenus-split name (`Aedes (Stegomyia) aegypti`) is not.
 *
 * None of those are hypothetical for the 16 → N work: a head with lookalike
 * families and a "no organism" class has to carry them. So the head may ship a
 * `taxonomy` array, parallel to `species`, giving each label's genus, subfamily
 * and family. A head that does not is still fully supported — the first-word
 * rule is kept as the fallback — so this is additive and nothing regresses.
 *
 * **The invariant that makes the roll-up safe.** Every rank is a *partition* of
 * the species: each species belongs to exactly one genus, one subfamily, one
 * family. Grouping therefore never splits one genus across two rows, and a rare
 * species cannot have its genus diluted by a common one — the genus row
 * collects the mass of all its species and only the species rows multiply.
 * `assertPartition` checks that at load rather than trusting the file.
 */

import { genusOf, speciesGenusIndex } from "./genus";
import type { GenusIndex, Head, TaxonomyEntry } from "./types";

/** The ranks the app rolls up to, coarsest last. `species` is the identity. */
export const RANKS = ["species", "genus", "subfamily", "family"] as const;
export type Rank = (typeof RANKS)[number];

/** One group's posterior at a rank: the name and the rows that summed into it. */
export interface RankGroup {
  name: string;
  /** Indices into `head.species`. Non-empty for every rank, including species. */
  members: number[];
  /** The group's total posterior. Always the sum of its members' posteriors. */
  p: number;
}

function rankOfEntry(entry: TaxonomyEntry | undefined, rank: Rank, label: string): string {
  if (rank === "species") return label;
  const fromHead = entry?.[rank];
  if (typeof fromHead === "string" && fromHead.trim()) return fromHead.trim();
  // A head that ships a taxonomy for some labels and not others is half-migrated,
  // which is worse than not shipping one: the same genus would appear under two
  // names in the same list. The fallback is the first word, which is what the app
  // did before, so a partial file is no worse than no file.
  if (rank === "genus") return genusOf(label);
  // Above genus there is nothing sensible to invent from a binomial, so an
  // unlabelled species files under a visible marker rather than silently under
  // the species name, which would read as if it were its own family.
  return "";
}

const partitionCache = new WeakMap<Head, Map<Rank, RankGroup[]>>();

/**
 * The species rows grouped at `rank`, in first-appearance order.
 *
 * Cached on the head, so repeated calls at three ranks are one pass. The group
 * `p` is left at 0: it depends on the posterior, and the cached structure must
 * not be a function of the last photo scored.
 */
export function rankGroups(head: Head, rank: Rank): RankGroup[] {
  let byRank = partitionCache.get(head);
  if (!byRank) {
    byRank = new Map();
    partitionCache.set(head, byRank);
  }
  const hit = byRank.get(rank);
  if (hit) return hit;

  const labels = head.species;
  const taxonomy = head.taxonomy;
  const order: string[] = [];
  const members = new Map<string, number[]>();
  labels.forEach((label, i) => {
    const name = rankOfEntry(taxonomy?.[i], rank, label);
    const key = name || `unclassified (${label})`;
    if (!members.has(key)) {
      members.set(key, []);
      order.push(key);
    }
    members.get(key)!.push(i);
  });
  const groups = order.map((name) => ({ name, members: members.get(name)!, p: 0 }));
  byRank.set(rank, groups);
  return groups;
}

/**
 * The groups at `rank` with their posteriors filled in, ordered by posterior.
 *
 * This is the sum the whole 16 → N design rests on: `p` is the total mass of the
 * species in the group, so a genus row is exactly as confident as the evidence
 * for its species put together, and a three-species genus is never split by
 * which of its species happened to be in the photo.
 *
 * Ties are broken by the group's first species index, so the order is stable
 * across renders — a list that reshuffles equal-probability rows on every
 * repaint is unreadable and makes the screenshot tests flaky.
 */
export function rankedScores(head: Head, spP: readonly number[], rank: Rank): RankGroup[] {
  const groups = rankGroups(head, rank).map((g) => ({
    ...g,
    p: g.members.reduce((sum, i) => sum + (spP[i] ?? 0), 0),
  }));
  const firstIndex = new Map(rankGroups(head, rank).map((g, i) => [g, g.members[0] ?? 0]));
  return groups.sort((a, b) => (firstIndex.get(b) ?? 0) - (firstIndex.get(a) ?? 0) || b.p - a.p);
}

/**
 * Every rank at once, for a caller that renders the columns side by side.
 *
 * Species is included so a caller cannot accidentally show a coarser level
 * without the leaves it summarises.
 */
export function allRankedScores(head: Head, spP: readonly number[]): Record<Rank, RankGroup[]> {
  return {
    species: rankedScores(head, spP, "species"),
    genus: rankedScores(head, spP, "genus"),
    subfamily: rankedScores(head, spP, "subfamily"),
    family: rankedScores(head, spP, "family"),
  };
}

/**
 * Throw if the head's taxonomy does not partition its species.
 *
 * Called at load rather than trusted, because the failure it catches is
 * invisible: a species in two genera does not crash anything, it just makes the
 * same genus appear twice in one list with a fraction of the mass in each, and
 * the numbers still sum to 1.
 */
export function assertPartition(head: Head): void {
  const taxonomy = head.taxonomy;
  if (!taxonomy) return; // The first-word fallback partitions by construction.
  if (taxonomy.length !== head.species.length) {
    throw new Error(
      `Head taxonomy has ${taxonomy.length} entries for ${head.species.length} species; ` +
        `the two arrays are read in parallel and must be the same length.`,
    );
  }
  head.species.forEach((label, i) => {
    if (taxonomy[i]?.species && taxonomy[i]!.species !== label) {
      throw new Error(
        `Head taxonomy entry ${i} names "${taxonomy[i]!.species}" but head.species[${i}] is ` +
          `"${label}". The two arrays are read in parallel and must agree.`,
      );
    }
  });
  for (const rank of ["genus", "subfamily", "family"] as const) {
    const groups = rankGroups(head, rank);
    const seen = new Set<number>();
    for (const g of groups) {
      for (const m of g.members) {
        if (seen.has(m)) {
          throw new Error(
            `Head taxonomy puts species ${m} ("${head.species[m]}") in more than one ${rank} ` +
              `group; a rank must partition the species.`,
          );
        }
        seen.add(m);
      }
    }
    if (seen.size !== head.species.length) {
      throw new Error(
        `Head taxonomy drops ${head.species.length - seen.size} species at rank "${rank}".`,
      );
    }
  }
}

/**
 * Whether this head should be read through its shipped taxonomy.
 *
 * Behind a flag, because a taxonomy file that disagrees with the labels is a
 * worse state than the first-word rule, and the shipped 16-species heads do not
 * ship one. `?taxonomy=off` forces the fallback for A/B measurement, and the
 * default is "use the taxonomy when the head has one" — a head that ships a
 * taxonomy has already decided it wants it.
 */
export function taxonomyEnabled(head: Head, search = typeof location === "undefined" ? "" : location.search): boolean {
  const override = /(?:^|[?&])taxonomy=(on|off|1|0)(?:&|$)/.exec(search)?.[1];
  if (override === "off" || override === "0") return false;
  if (override === "on" || override === "1") return true;
  return Array.isArray(head.taxonomy) && head.taxonomy.length === head.species.length;
}

/**
 * The genus index a caller should use: the head's taxonomy when it ships one,
 * otherwise the first-word rule.
 *
 * `speciesGenusIndex` is re-exported through here so callers have one import and
 * cannot end up reading the head directly and missing the flag.
 */
export function effectiveGenusIndex(head: Head): GenusIndex {
  if (!taxonomyEnabled(head)) return speciesGenusIndex(head);
  const groups = rankGroups(head, "genus");
  const idx: GenusIndex = new Map();
  for (const g of groups) idx.set(g.name, [...g.members]);
  return idx;
}
