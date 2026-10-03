import { activeGroupOf } from "./granularity";
import { SPECIES_META } from "./speciesMeta";

// One species label, used everywhere a species is named.
//
// This existed as two divergent copies: the per-photo score list rendered the
// guide link and the common name, the pooled card rendered a bare <strong> of
// the binomial - so the same species read differently depending on which panel
// it appeared in. Anything added to a species label from here on (a vector
// status, a thumbnail, a range note) has to be added once.
//
// The guide link is a hash route of this same document, so following it and
// coming back preserves the photo, the crop and the scores instead of re-running
// the model.
export function speciesLabelHtml(name: string): string {
  // A species the loaded head cannot tell apart from its group-mates is written
  // as the group, before anything else here runs. It is the one place every
  // rendered species name comes from - the per-photo ranking, the pooled
  // candidates and anything added here later - so the check sits here rather
  // than at each of those call sites, which is what let the two of them drift
  // apart in the first place. A head that separates every row never takes this
  // branch, and the label is byte-for-byte what it was.
  const group = activeGroupOf(name);
  if (group) return groupLabelHtml(group);
  const meta = SPECIES_META[name];
  const wikiLink = meta?.wiki
    ? `<a href="${meta.wiki}" target="_blank" rel="noopener" class="species-wiki" title="Wikipedia">\u{1F517}</a>`
    : "";
  const nameHtml = meta
    ? `<a class="species-kb-link" href="#/species/${encodeURIComponent(speciesSlug(name))}">${escapeHtml(name)}</a>`
    : `<span>${escapeHtml(name)}</span>`;
  const common = meta?.common ? ` <span class="species-common">(${escapeHtml(meta.common)})</span>` : "";
  return `${wikiLink}${nameHtml}${common}`;
}

export function speciesSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/**
 * One of a set of species the loaded head cannot separate.
 *
 * No guide link and no common name: this label stands for a class of species, so
 * linking it to one member's page would assert the identification the group
 * phrase exists to withhold. `genusLabelHtml` keeps the link - every member of a
 * group shares a genus, and the genus page is the honest destination - with the
 * set of unnameable epithets hung off it.
 */
export function groupLabelHtml(group: { genus: string; species: string[]; label: string }): string {
  const epithets = group.species
    .map((s) => s.trim().split(/\s+/).slice(1).join(" ") || s)
    .join(" / ");
  const meta = SPECIES_META[group.genus];
  const genusHtml = meta
    ? `<a class="species-kb-link" href="#/species/${encodeURIComponent(speciesSlug(group.genus))}">${escapeHtml(group.genus)}</a>`
    : `<span>${escapeHtml(group.genus)}</span>`;
  return `${genusHtml} <span class="species-unresolvable">(${escapeHtml(epithets)} not separable)</span>`;
}

export function escapeHtml(str: unknown): string {
  // Indexed by a `string` from the replace callback, so under
  // noUncheckedIndexedAccess every lookup is `string | undefined` - and an
  // undefined replacement would stringify to the literal "undefined" rather
  // than throw, so the fallback is load-bearing, not a type appeasement.
  const ENTITIES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  };
  return String(str).replace(/[&<>"']/g, s => ENTITIES[s] ?? s);
}
