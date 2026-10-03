/**
 * What the loaded head can actually tell apart, and what the app may therefore
 * name.
 *
 * A head gives each species one weight row. Where two rows are byte-identical
 * the model has no way to separate the two species: for any photo the two logits
 * are the same number, so the two posteriors are the same number, and the tie
 * breaks on list order - which is why one species of each group came to win
 * essentially every tie it was in. The app was printing that winner as an
 * identification.
 *
 * The grouping is derived from the head rather than listed here because a refit
 * is planned and a hardcoded list would outlive it: it would keep the app
 * withholding a species the refitted head can support, which is the same defect
 * as the one this fixes, pointing the other way.
 *
 * Spec: docs/REPORT-GRANULARITY-SPEC.md.
 */
import type { Head } from "../confidence/types";
import type { Verdict } from "../confidence/types";
import { verdictSentence } from "../confidence/verdict";

/**
 * Species the head cannot tell apart, and how the app writes them.
 *
 * Only groups of MORE THAN ONE species are returned. A species whose row is
 * unique is not a group and is not a limitation; listing it here would make
 * `resolvableGroups` describe the label set rather than the head.
 */
export interface SpeciesGroup {
  genus: string;
  /** Every member, in head order. Length >= 2. */
  species: string[];
  /** How this group is written everywhere it appears. */
  label: string;
}

/**
 * Every equivalence class in a head, singletons included, cached per head.
 *
 * WeakMap, not a Map: a head is replaced on an engine switch, and the cache has
 * to die with the head it describes rather than pin a 1.26 GB-adjacent object
 * for the life of the page. The grouping is pure in the head, so one computation
 * per loaded head serves every photo.
 */
const ALL_GROUPS = new WeakMap<Head, SpeciesGroup[]>();
const UNRESOLVABLE = new WeakMap<Head, SpeciesGroup[]>();

/** The binomial without its genus, which is how a species is written inside one. */
function epithet(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : name;
}

function genusOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/**
 * The phrase the whole app writes for a group. One format, in the sentence box,
 * the score list, the table and the CSV, so a reader meets the same words in
 * every place a species would have been named.
 */
export function groupLabel(group: Pick<SpeciesGroup, "genus" | "species">): string {
  return `${group.genus} (${group.species.map(epithet).join(" / ")} not separable)`;
}

/**
 * Key one weight row by its exact bytes.
 *
 * String comparison of the 32-bit patterns, not arithmetic equality on the
 * values: two rows that differ are two rows the model can separate, however
 * little they differ, and an approximate test would suppress a name the model
 * does support. Exact equality fails the safe way instead - a head with merely
 * similar rows yields no groups at all, every species is its own group, and the
 * app reports species everywhere. The rows in the shipped culico head are
 * bit-identical, so this is the test that fits it and the one that will fit the
 * refit.
 */
function rowKey(emb: ArrayLike<number>, offset: number, dim: number): string {
  // Rounded through float32 first: that is the precision the model computes in,
  // so two rows the JSON spells differently but the weights cannot tell apart
  // are the same row to the thing that has to separate them.
  const f32 = new Float32Array(dim);
  for (let i = 0; i < dim; i++) f32[i] = emb[offset + i]!;
  const bytes = new Uint8Array(f32.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * Every set of species sharing one weight row, singletons included, in the head's
 * own order.
 */
export function equivalenceGroups(head: Head | null | undefined): SpeciesGroup[] {
  if (!head || !head.species?.length || !head.species_emb) return [];
  const cached = ALL_GROUPS.get(head);
  if (cached) return cached;

  const { species, dim } = head;
  const emb = head.species_emb;
  const byRow = new Map<string, string[]>();
  for (let i = 0; i < species.length; i++) {
    const key = rowKey(emb, i * dim, dim);
    const members = byRow.get(key);
    if (members) members.push(species[i]!);
    else byRow.set(key, [species[i]!]);
  }
  const groups: SpeciesGroup[] = [];
  for (const members of byRow.values()) {
    groups.push({ genus: genusOf(members[0]!), species: members, label: groupLabel({ genus: genusOf(members[0]!), species: members }) });
  }
  ALL_GROUPS.set(head, groups);
  return groups;
}

/**
 * The groups of more than one species - the ones the head cannot resolve.
 *
 * The name is "resolvable" because it is the groups that decide what is
 * *un*resolvable; a group of one is an ordinary species and is absent here.
 */
export function resolvableGroups(head: Head | null | undefined): SpeciesGroup[] {
  if (!head) return [];
  const cached = UNRESOLVABLE.get(head);
  if (cached) return cached;
  const out = equivalenceGroups(head).filter((g) => g.species.length > 1);
  UNRESOLVABLE.set(head, out);
  return out;
}

/** Index from species name to the group it belongs to. Singletons are absent. */
const GROUP_OF = new WeakMap<Head, Map<string, SpeciesGroup>>();

/**
 * The group a species belongs to, or null when it is namable.
 *
 * Null is the common case and the safe one: no group means the head separates
 * this species from every other, so the app may name it.
 */
export function groupOf(head: Head | null | undefined, species: string | null | undefined): SpeciesGroup | null {
  if (!head || !species) return null;
  let idx = GROUP_OF.get(head);
  if (!idx) {
    idx = new Map();
    for (const g of resolvableGroups(head)) for (const s of g.species) idx.set(s, g);
    GROUP_OF.set(head, idx);
  }
  return idx.get(species) ?? null;
}

/** What the head supports: a species, or only a genus. */
export type Capability = "species" | "genus";

/**
 * The capability DERIVED from the head, which is what reporting uses.
 *
 * A head that cannot separate any pair of species names species. Anything else
 * is a genus head, whatever its `ModelConfig` entry says - the dropdown label is
 * a preview of an engine the user has not loaded, and this is the loaded truth.
 */
export function capabilityOf(head: Head | null | undefined): Capability {
  return resolvableGroups(head).length ? "genus" : "species";
}

// ---- The active head, for the render path ----
//
// The label helpers are called from the score list, the results table and the
// pooled card without a head in hand, because threading it through every call
// site is what put two divergent copies of a species label in the app once
// already. It is bound when the head is assigned, which happens in exactly one
// place in `main.js`, so it cannot go stale behind the engine switch.

let active: SpeciesGroup[] = [];

/** Bind the groups to the label helpers. Called when the head is assigned. */
export function setActiveHead(head: Head | null | undefined): void {
  active = resolvableGroups(head);
}

/** The groups of the head currently loaded. Empty before any head loads. */
export function activeGroups(): readonly SpeciesGroup[] {
  return active;
}

/** What the loaded head can name, for the same call sites. */
export function activeCapability(): Capability {
  return active.length ? "genus" : "species";
}

/** The phrase for a species the head cannot separate, or null if it can. */
export function activeGroupOf(species: string | null | undefined): SpeciesGroup | null {
  if (!species) return null;
  for (const g of active) if (g.species.includes(species)) return g;
  return null;
}

/** The phrase for a species, or the species itself if the head separates it. */
export function activeName(species: string | null | undefined): string | null {
  if (!species) return null;
  const g = activeGroupOf(species);
  return g ? g.label : species;
}

// ---- Verdict to text ----

/**
 * The sentence the score panel leads with, at the granularity the head supports.
 *
 * `verdictSentence` decides the SHAPE of the sentence from the verdict, and it
 * does not know which species a head can separate - it was written before this
 * question existed. So it is used for the shape and this function decides
 * whether the sentence may name a species at all.
 *
 * Two cases leave `verdictSentence` alone (the unsure and non-mosquito states
 * name no species) and two override it:
 *
 * - the verdict's top species is in a multi-member group. Whatever state the
 *   verdict is in, the app cannot name that species, so it prints the class and
 *   says why. This is the case the whole module exists for.
 * - the verdict is a genus claim whose leader IS namable, but whose runner-ups
 *   are not. The verdict is copied with those runners-up removed and handed
 *   back, so "possibly vexans or geniculatus" - two names for one classifier
 *   output - cannot be printed.
 */
export function claimSentence(
  v: Verdict | null | undefined,
  groups: readonly SpeciesGroup[] = active,
): string {
  if (!v) return "";
  const groupOfName = (n: string | null | undefined): SpeciesGroup | null => {
    if (!n) return null;
    for (const g of groups) if (g.species.includes(n)) return g;
    return null;
  };

  // The leader is `species` in the species state and `topSpecies` in the genus
  // state; the genus state sets `species: null` by construction, so `species`
  // alone would find no leader there.
  const leader = v.state === "species" ? (v.species ?? v.topSpecies) : v.topSpecies;
  const leaderGroup = groupOfName(leader);
  if (leaderGroup) return leaderGroup.label;

  if (v.state === "genus" && v.runnersUp.some((r) => groupOfName(r.name))) {
    return verdictSentence({ ...v, runnersUp: v.runnersUp.filter((r) => !groupOfName(r.name)) });
  }
  return verdictSentence(v);
}

/**
 * Merge the score list a head cannot separate.
 *
 * Each member of a multi-member group becomes one entry carrying the class
 * phrase and the class's score - the largest among its members, which they share
 * by construction: identical weight rows, and the per-genus cosine offset is
 * keyed by genus, so members of one group cannot be pulled apart by calibration
 * either.
 *
 * Order is by score, descending, so the rows the head genuinely separates keep
 * the relative order they had.
 */
export function mergeUnresolvable<T>(
  entries: readonly T[],
  scoreOf: (e: T) => number,
  nameOf: (e: T) => string,
  groups: readonly SpeciesGroup[] = active,
): Array<{ name: string; score: number; source: T[] }> {
  const merged: Array<{ name: string; score: number; source: T[] }> = [];
  const byGroup = new Map<string, number>();
  for (const e of entries) {
    const name = nameOf(e);
    const score = scoreOf(e);
    const g = groups.find((x) => x.species.includes(name));
    if (!g) {
      merged.push({ name, score, source: [e] });
      continue;
    }
    const at = byGroup.get(g.label);
    if (at === undefined) {
      byGroup.set(g.label, merged.length);
      merged.push({ name: g.label, score, source: [e] });
    } else {
      const row = merged[at]!;
      row.score = Math.max(row.score, score);
      row.source.push(e);
    }
  }
  return merged.sort((a, b) => b.score - a.score);
}