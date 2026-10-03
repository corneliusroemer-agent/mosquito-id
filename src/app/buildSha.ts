/**
 * The deployed build's commit SHA, written into the page URL.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, so the SHA in the bundle
 * is the SHA the artefact was built from and not whatever is checked out when
 * the page is served. It is put in the URL rather than in the DOM because the
 * address bar is where someone reading a bug report already is, and because a
 * link carrying ?build=<sha> is self-describing when it is shared.
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