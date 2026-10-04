/**
 * Hash routing between the classifier and the species guide.
 *
 * The classifier's DOM is never rebuilt, only hidden: previews[], the selection,
 * the crop boxes, the rendered scores and the loaded sessions all keep living in
 * memory and in the document across a navigation, so nothing has to be
 * serialised or restored. That is the whole of the state preservation here.
 */

import { render as renderSpeciesPage } from "./speciesPage";

// ---- Router ----
//
// Hash routes, not history.pushState with clean paths. The site is deployed at
// /mosquito-id/ as plain static files on GitHub Pages, with no rewrite rules:
// a clean path such as /mosquito-id/species/aedes-albopictus is a 404 on
// refresh and for anyone the link is shared with, because Pages looks for a
// file of that name. Everything the router needs is after the '#', which the
// server never sees, so deep links and reloads work with no server config.
//
// The classifier's DOM is never rebuilt, only hidden. That is the whole of the
// state preservation: previews[], selectedIndex, the crop boxes, the rendered
// scores and the loaded ONNX sessions all keep living in memory and in the
// document across a navigation, so nothing has to be serialised or restored.

export type Route = { view: "classifier" } | { view: "species"; slug: string };

function parseRoute(): Route {
  const hash = location.hash.replace(/^#/, "");
  const m = hash.match(/^\/species(?:\/(.*))?$/);
  if (!m) return { view: "classifier" };
  return { view: "species", slug: m[1] ? decodeURIComponent(m[1]) : "" };
}

function showClassifier(classifierTitle: string): void {
  document.querySelector(".app-container")?.classList.remove("route-off");
  document.getElementById("kb-view")?.classList.add("route-off");
  document.title = classifierTitle;
}

function applyRoute(classifierTitle: string, onClassifier?: () => void): void {
  const route = parseRoute();
  if (route.view === "classifier") {
    showClassifier(classifierTitle);
    onClassifier?.();
    return;
  }
  document.querySelector(".app-container")?.classList.add("route-off");
  document.getElementById("kb-view")?.classList.remove("route-off");
  window.scrollTo(0, 0);
  // species.js fetches species-data.json once and caches the promise, so
  // repeated navigations cost nothing beyond the render.
  renderSpeciesPage(route.slug, document.getElementById("kb-body"));
}

/**
 * Start routing, and return the handler to bind to `hashchange`.
 *
 * The classifier's own document title is captured here rather than at module
 * scope, so that reading the page is this function's doing and not something
 * that happens merely because a module was imported. A module script is deferred,
 * so the document has been parsed either way and the value is the same.
 *
 * `onClassifier` is how the classifier shell tells its owner it is on screen: it
 * runs the first time a route resolves to the classifier, at boot if that is where
 * the page opened and otherwise at the navigation that brings it there. The
 * species guide is a route of this shell, so booting on `#/species/<slug>` is a
 * supported way in - and a tab that opens there must not fetch 1.2 GB of weights
 * and build an ONNX session for a classifier it will not run. The callback fires
 * once per page load; a later navigation to the species route does not undo it,
 * because the sessions are already built and the classifier keeps its state.
 */
export function initRouter(onClassifier?: () => void): () => void {
  const classifierTitle = document.title;
  let engineStarted = false;
  const onHashChange = (): void =>
    applyRoute(classifierTitle, () => {
      if (engineStarted) return;
      engineStarted = true;
      onClassifier?.();
    });
  return onHashChange;
}
