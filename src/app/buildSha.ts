/**
 * The deployed build's commit SHA, written into the page URL.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, so the SHA in the bundle
 * is the SHA the artefact was built from and not whatever is checked out when
 * the page is served. It is put in the URL rather than in the DOM because the
 * address bar is where someone reading a bug report already is, and because a
 * link carrying ?build=<sha> is self-describing when it is shared.
 *
 * The same SHA is shown in the footer as a link to the commit, so the deployment
 * can be identified from the page itself and not only from a URL someone pasted.
 */

export const BUILD_PARAM = "build";

/** The injected SHA, or undefined when the build had no git checkout to read. */
export const COMMIT_SHA: string | undefined = import.meta.env.VITE_COMMIT_SHA;

/**
 * The URL the page should run at, or null when it is already right.
 *
 * An existing ?build= wins over the injected one: a shared link keeps naming the
 * build it was shared from, so reloading it does not silently repoint it at a
 * newer deploy. An injected SHA that is empty or all whitespace is no SHA at all
 * and is dropped rather than written as `?build=`.
 */
export function buildUrl(href: string, sha: string | undefined = COMMIT_SHA): string | null {
  const url = new URL(href, "http://localhost");
  if (url.searchParams.has(BUILD_PARAM)) return null;
  const trimmed = sha?.trim();
  if (!trimmed) return null;
  url.searchParams.set(BUILD_PARAM, trimmed);
  // Relative to the document: the site is served from /mosquito-id/ under
  // `base: "./"`, and a bare absolute path would break there.
  return `${url.pathname}${url.search}${url.hash}`;
}

const COMMIT_URL_BASE = "https://github.com/corneliusroemer-agent/mosquito-id/commit/";

/** A git object name: what VITE_COMMIT_SHA is, and nothing else may become a URL. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * What the footer shows and links to, or null when the build carries no SHA.
 *
 * Same source as the URL stamp and the same rejection of a blank SHA, so the
 * footer and the address bar can never name different builds. The SHA is
 * pattern-checked before it goes into the URL: it is the one string here that
 * comes from the build environment rather than from the page.
 */
export function buildLink(
  sha: string | undefined = COMMIT_SHA,
  shortLength = 7,
): { text: string; href: string } | null {
  const trimmed = sha?.trim();
  if (!trimmed || !SHA_PATTERN.test(trimmed)) return null;
  return { text: trimmed.slice(0, shortLength), href: `${COMMIT_URL_BASE}${trimmed}` };
}

/** The footer slot. `unknown` rather than Node so a plain stub stands in for it. */
type ParentLike = {
  replaceChildren(...nodes: unknown[]): void;
};

/**
 * Put the commit link in the footer's slot, or leave the slot empty.
 *
 * `replaceChildren` rather than append, so a re-run cannot stack a second link
 * and the absent case leaves nothing behind rather than an orphaned divider.
 */
export function renderBuildLink(
  slot: ParentLike | null,
  doc: Document | null,
  sha: string | undefined = COMMIT_SHA,
): boolean {
  if (!slot || !doc) return false;
  const link = buildLink(sha);
  if (!link) {
    slot.replaceChildren();
    return false;
  }
  const anchor = doc.createElement("a");
  anchor.className = "build-link";
  anchor.href = link.href;
  // The commit page is on another origin and opens in a new tab; noopener keeps
  // it from reaching back through window.opener.
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = `build ${link.text}`;
  const divider = doc.createElement("span");
  divider.className = "divider";
  divider.textContent = "·";
  slot.replaceChildren(divider, anchor);
  return true;
}

type HistoryLike = {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | null): void;
};

/**
 * Stamp the SHA onto the current URL with replaceState, so it does not become a
 * history entry and the back button still leaves the page.
 */
export function stampBuildSha(
  sha: string | undefined = COMMIT_SHA,
  loc: Location = location,
  hist: HistoryLike = history,
): boolean {
  const next = buildUrl(loc.href, sha);
  if (next === null) return false;
  hist.replaceState(hist.state, "", next);
  return true;
}