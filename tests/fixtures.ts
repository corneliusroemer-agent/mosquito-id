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
export const NU = (head: Head): number => (head.nuisance ?? []).length;

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

/** A nuisance posterior from a {index: p} map; every other class is 0. */
export function nuPost(head: Head, over: Record<number, number>): number[] {
  const p = new Array<number>(NU(head)).fill(0);
  for (const [i, v] of Object.entries(over)) p[Number(i)] = v;
  return p;
}

/**
 * A head whose nuisance and adjacent rows are unit vectors along one axis each,
 * so an embedding can be handed in and land on a chosen block with a chosen
 * cosine and nothing else. `softmaxJoint` is then the only arithmetic in play,
 * which is what makes "high on nuisance, low on adjacent" a reproducible input
 * rather than a hand-written posterior that the gate happens to agree with.
 *
 * `logit_scale` is a parameter because the resulting posterior is a function of
 * it: at 10 the winning row takes ~0.95 of the mass, and at 1 it takes ~0.33.
 * The real data sits in neither regime - nuisance mass peaks at 0.498 over 700
 * true negatives and 0.204 over 6,264 true mosquitoes - which is exactly why
 * the gate needs its own floor.
 */
export function splitHead(
  species: string[],
  nuisance: string[],
  adjacent: string[],
  logit_scale = 10,
): Head {
  const D = species.length + nuisance.length + adjacent.length;
  let k = 0;
  // Flat, in row-major order, because that is how `softmaxJoint` indexes them.
  const emb: number[] = [];
  const put = (rows: number) => {
    for (let r = 0; r < rows; r++) {
      const v = new Array<number>(D).fill(0);
      v[k++] = 1;
      emb.push(...v);
    }
  };
  put(species.length);
  put(nuisance.length);
  put(adjacent.length);
  return {
    species,
    nuisance,
    adjacent,
    dim: D,
    logit_scale,
    species_emb: emb.slice(0, species.length * D),
    nuisance_emb: emb.slice(species.length * D, (species.length + nuisance.length) * D),
    adjacent_emb: emb.slice((species.length + nuisance.length) * D),
  };
}

/**
 * The unit vector for block `row` of a `splitHead`. Feeding it to `softmaxJoint`
 * scores that one row at cosine 1 and every other at 0, so the nuisance/adjacent
 * split is the only thing that varies between calls.
 */
export function splitEmb(head: Head, kind: "species" | "nuisance" | "adjacent", i: number): number[] {
  const base =
    kind === "species" ? 0 : kind === "nuisance" ? S(head) : S(head) + NU(head);
  const v = new Array<number>(head.dim).fill(0);
  v[base + i] = 1;
  return v;
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

/**
 * A head whose species share weight rows in the given groups; a name in no group
 * gets its own row.
 *
 * This is the shape culico's head had before the 2026-10-04 refit and the only
 * shape the group machinery exists for. It is built rather than read from a
 * file because no shipped head has it any more: after the refit all sixteen
 * culico rows are distinct, `resolvableGroups` on any shipped file is empty,
 * and a test that wants a group would otherwise have nothing to ask. The
 * grouping falls out of the weights, so the tests that use this are still
 * testing the derivation rather than a list.
 */
export function groupedHead(
  species: readonly string[],
  groups: readonly (readonly string[])[],
  dim = 8,
): Head {
  const head: Head = {
    species: [...species],
    adjacent: [],
    adjacent_common: [],
    nuisance: [],
    dim,
    logit_scale: 100,
  };
  const emb = new Float32Array(species.length * dim);
  const rowOf = new Map<string, number>();
  groups.forEach((g, i) => { for (const s of g) rowOf.set(s, i + 1); });
  species.forEach((sp, i) => {
    // Deterministic on the ROW index, so every member of a group writes the same
    // bytes - which is the only thing `equivalenceGroups` looks at.
    const g = rowOf.get(sp) ?? -(i + 1);
    for (let j = 0; j < dim; j++) emb[i * dim + j] = Math.sin(g * 7 + j);
  });
  head.species_emb = emb;
  return head;
}

/**
 * The groups culico's 16-row head collapsed into before the refit: four sets of
 * three, named by the genus they sit in.
 */
export const CULICO_PRE_REFIT_GROUPS: readonly (readonly string[])[] = [
  ["Aedes albopictus"],
  ["Aedes aegypti"],
  ["Aedes japonicus"],
  ["Aedes koreicus"],
  ["Aedes vexans", "Aedes geniculatus", "Aedes cinereus"],
  ["Culex pipiens", "Culex torrentium", "Culex quinquefasciatus"],
  ["Culiseta annulata", "Culiseta morsitans", "Culiseta longiareolata"],
  ["Anopheles maculipennis", "Anopheles claviger", "Anopheles plumbeus"],
];

/** culico's pre-refit head, rebuilt: same sixteen labels, four collapsed groups. */
export function culicoPreRefitHead(species: readonly string[], dim = 8): Head {
  return groupedHead(species, CULICO_PRE_REFIT_GROUPS, dim);
}
