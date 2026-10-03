/**
 * Types for the species guide page.
 *
 * speciesPage.js is still plain JavaScript. Only `render` is called from
 * TypeScript, so only it is described here - a full conversion of that file is
 * its own change, and declaring the whole surface would be inventing types for
 * code nobody has asked to type.
 */

/**
 * Render one species into `container`, or the index when `slug` is empty.
 *
 * The data is fetched once and the promise cached, so repeated navigations cost
 * nothing beyond the render.
 */
export function render(slug: string, container: HTMLElement | null): void;
