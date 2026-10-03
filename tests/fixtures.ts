import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Head } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** The shipped text embeddings. 660 KB; read once per test file. */
export function realEmbeds(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "public", "text_embeds.json"), "utf8"));
}

/**
 * The REAL 16-species label set and the REAL adjacent classes, so genus
 * derivation and the non-mosquito state are exercised on the names that
 * actually ship rather than on a convenient fixture.
 *
 * `logit_scale` is the shipped value from the file; the tests that need a known
 * scale read it from here rather than hardcoding 100, so a change to the shipped
 * scale shows up as a changed number in the failure message instead of a
 * mysteriously different pooled posterior.
 */
export function realHead(): Head {
  const e = realEmbeds();
  return {
    species: e.species as string[],
    adjacent: e.adjacent as string[],
    adjacent_common: e.adjacent_common as string[],
    nuisance: e.nuisance as string[],
    dim: e.dim as number,
    logit_scale: e.logit_scale as number,
    species_emb: e.species_emb as number[],
    adjacent_emb: e.adjacent_emb as number[],
    nuisance_emb: e.nuisance_emb as number[],
  };
}

export const S = (head: Head): number => head.species.length;
export const AD = (head: Head): number => (head.adjacent ?? []).length;

/** A species posterior from a {name: p} map; every other species is 0. */
export function post(head: Head, over: Record<string, number>): number[] {
  const p = new Array<number>(S(head)).fill(0);
  for (const [name, v] of Object.entries(over)) {
    const i = head.species.indexOf(name);
    if (i < 0) throw new Error(`fixture names a species the head does not carry: ${name}`);
    p[i] = v;
  }
  return p;
}

/** An adjacent posterior from a {index: p} map; every other class is 0. */
export function adjPost(head: Head, over: Record<number, number>): number[] {
  const p = new Array<number>(AD(head)).fill(0);
  for (const [i, v] of Object.entries(over)) p[Number(i)] = v;
  return p;
}

/**
 * A head built from explicit labels, for the cases where the real 16-species
 * label set is the wrong shape: a three-species head makes "two views naming
 * different species" say what it means without the other fourteen getting
 * swallowed by the floor.
 */
export function fixtureHead(species: string[], opts: Partial<Head> = {}): Head {
  return {
    species,
    dim: 4,
    logit_scale: 100,
    nuisance: [],
    ...opts,
  };
}
