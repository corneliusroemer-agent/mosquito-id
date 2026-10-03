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
