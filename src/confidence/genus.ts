import type { GenusIndex, Head } from "./types";

/**
 * The genus is the first word of the species name, and nothing else.
 *
 * It comes from the label set rather than a hardcoded list so that adding a
 * species cannot leave the gate reasoning about a genus that no longer exists.
 * Splitting on whitespace first and only then keeping the remainder handles
 * compound epithets: "Culiseta annulata/morsitans" and "Anopheles maculipennis
 * complex" both stay inside their genus, with the slash and the word "complex"
 * untouched.
 */
export function genusOf(name: string): string {
  const parts = String(name).trim().split(/\s+/);
  // A one-word label is its own genus. Returning "" there would file every bare
  // name under a single empty genus, which is worse than saying the name is the
  // genus it is.
  return parts[0] || "";
}

// Rebuilt whenever the label list changes. Keyed on the array itself, so a head
// that has not been swapped keeps its index and a head that has cannot read a
// stale one - which was the whole reason the original cached this against EMB.
const cache = new WeakMap<readonly string[], GenusIndex>();

export function speciesGenusIndex(head: Head): GenusIndex {
  const names = head.species;
  const hit = cache.get(names);
  if (hit) return hit;
  const idx: GenusIndex = new Map();
  names.forEach((name, i) => {
    const g = genusOf(name);
    if (!idx.has(g)) idx.set(g, []);
    idx.get(g)!.push(i);
  });
  cache.set(names, idx);
  return idx;
}
