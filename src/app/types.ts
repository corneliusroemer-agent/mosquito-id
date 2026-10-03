/**
 * The shapes that cross module boundaries in the app shell.
 *
 * Kept apart from the modules that use them so that a cycle cannot form: every
 * module here is a leaf, and anything that needs a type from this file depends
 * on this file alone.
 */

/**
 * One entry of the static species table (src/app/speciesMeta.ts).
 *
 * Every field is optional. The classifier's label set and that table are edited
 * separately, so an entry that carries only a common name has to be legal.
 */
export interface SpeciesMeta {
  common?: string;
  wiki?: string;
  vectors?: string;
  range?: string;
  activity?: string;
  hosts?: string;
  notes?: string;
}
