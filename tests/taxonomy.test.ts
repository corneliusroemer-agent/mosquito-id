import { describe, it, expect } from "vitest";
import {
  RANKS,
  allRankedScores,
  assertPartition,
  effectiveGenusIndex,
  rankGroups,
  rankedScores,
  taxonomyEnabled,
} from "../src/confidence/taxonomy";
import { speciesGenusIndex } from "../src/confidence/genus";
import type { Head, TaxonomyEntry } from "../src/confidence/types";

/**
 * Ranks above species, and the invariant the whole 16 → N design rests on.
 *
 * The property that matters is stated once here and checked everywhere below:
 * **every rank partitions the species.** A genus row collects the mass of all
 * its species and only the species rows multiply, so a rare species cannot
 * split its genus across rows — and a violation of that is invisible, because
 * the numbers still sum to 1. That is why `assertPartition` exists and why it
 * runs at load.
 */

/** A head over `labels`, with an optional taxonomy parallel to them. */
function head(labels: string[], taxonomy?: TaxonomyEntry[]): Head {
  const h = { species: labels, dim: 4, logit_scale: 1 } as unknown as Head;
  if (taxonomy) (h as { taxonomy?: TaxonomyEntry[] }).taxonomy = taxonomy;
  return h;
}

/** Uniform posterior, so every assertion is about grouping and not about values. */
function uniform(n: number): number[] {
  return new Array(n).fill(1 / n);
}

describe("a head that ships no taxonomy behaves exactly as it always has", () => {
  const h = head(["Aedes albopictus", "Aedes aegypti", "Culex pipiens", "Culiseta annulata"]);

  it("groups genus by the first word of the label", () => {
    expect(rankGroups(h, "genus").map((g) => g.name)).toEqual([
      "Aedes",
      "Culex",
      "Culiseta",
    ]);
  });

  it("files every species under its own species row, whatever the rank machinery", () => {
    const groups = rankGroups(h, "species");
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
  });

  it("marks the ranks it cannot know, rather than inventing a family from a binomial", () => {
    // "Aedes" is not a subfamily and cannot be guessed from the label. Filing it
    // under the species name would read as if the species were its own family.
    const fams = rankGroups(h, "family").map((g) => g.name);
    expect(fams.every((n) => n.startsWith("unclassified ("))).toBe(true);
  });

  it("passes the partition check without a taxonomy, because the fallback partitions", () => {
    expect(() => assertPartition(h)).not.toThrow();
  });

  it("uses the first-word genus index when there is no taxonomy", () => {
    expect([...effectiveGenusIndex(h).entries()].map(([k, v]) => [k, v.length])).toEqual([
      ["Aedes", 2],
      ["Culex", 1],
      ["Culiseta", 1],
    ]);
  });
});

describe("a head that ships a taxonomy is read through it", () => {
  const labels = [
    "Aedes albopictus",
    "Aedes aegypti",
    "Culex pipiens",
    "Culex quinquefasciatus",
    "Culiseta annulata",
    "Other Diptera",
  ];
  const taxonomy: TaxonomyEntry[] = [
    { genus: "Aedes", subfamily: "Culicinae", family: "Culicidae" },
    { genus: "Aedes", subfamily: "Culicinae", family: "Culicidae" },
    { genus: "Culex", subfamily: "Culicinae", family: "Culicidae" },
    { genus: "Culex", subfamily: "Culicinae", family: "Culicidae" },
    { genus: "Culiseta", subfamily: "Culicinae", family: "Culicidae" },
    // The case the first-word rule gets wrong: genus "Other" is not a genus.
    { genus: "Diptera", subfamily: "Diptera", family: "Diptera" },
  ];
  const h = head(labels, taxonomy);

  it("reads genus from the taxonomy, so a label like 'Other Diptera' files correctly", () => {
    const genera = rankGroups(h, "genus");
    expect(genera.map((g) => g.name)).toEqual(["Aedes", "Culex", "Culiseta", "Diptera"]);
    // The bug this exists for: first-word parsing files this under "Other".
    expect(speciesGenusIndex(h).get("Other")).toEqual([5]);
    expect(effectiveGenusIndex(h).get("Diptera")).toEqual([5]);
  });

  it("groups subfamily and family, which the first-word rule cannot produce at all", () => {
    expect(rankGroups(h, "subfamily").map((g) => g.name).sort()).toEqual(["Culicinae", "Diptera"]);
    expect(rankGroups(h, "family").map((g) => g.name).sort()).toEqual(["Culicidae", "Diptera"]);
  });

  it("SUMs the member species, so a genus is as confident as its species together", () => {
    const spP = [0.10, 0.30, 0.20, 0.20, 0.10, 0.10];
    const byGenus = Object.fromEntries(rankedScores(h, spP, "genus").map((g) => [g.name, g.p]));
    expect(byGenus.Aedes).toBeCloseTo(0.40, 10);
    expect(byGenus.Culex).toBeCloseTo(0.40, 10);
    expect(byGenus.Culiseta).toBeCloseTo(0.10, 10);
    expect(byGenus.Diptera).toBeCloseTo(0.10, 10);
  });

  it("conserves mass at every rank: the groups still sum to the species total", () => {
    const spP = [0.05, 0.15, 0.25, 0.25, 0.20, 0.10];
    for (const rank of RANKS) {
      const total = rankedScores(h, spP, rank).reduce((n, g) => n + g.p, 0);
      expect(total).toBeCloseTo(spP.reduce((a, b) => a + b, 0), 10);
    }
  });

  it("keeps a rare species from splitting its genus", () => {
    // One Culex at 1 %, one at 39 %. The genus row is 40 % either way: it is a
    // sum, not a mean, so the rare species cannot pull its genus down.
    const spP = [0, 0, 0.01, 0.39, 0.30, 0.30];
    const culex = rankedScores(h, spP, "genus").find((g) => g.name === "Culex")!;
    expect(culex.p).toBeCloseTo(0.40, 10);
    expect(culex.members).toEqual([2, 3]);
  });

  it("orders by posterior, breaking ties on the group's first species", () => {
    // Stable order matters: a list that reshuffles equal rows on every repaint
    // is unreadable and makes the screenshot specs flaky.
    const flat = uniform(6);
    const first = rankedScores(h, flat, "genus").map((g) => g.name);
    const second = rankedScores(h, flat, "genus").map((g) => g.name);
    expect(second).toEqual(first);
    // Every group ties at 1/6 or 1/3, so the order is the first-appearance one.
    expect(first).toEqual(["Aedes", "Culex", "Culiseta", "Diptera"]);
  });

  it("returns every rank at once, leaves included, for a caller rendering columns", () => {
    const all = allRankedScores(h, uniform(6));
    expect(Object.keys(all)).toEqual([...RANKS]);
    expect(all.species).toHaveLength(6);
    expect(all.family.length).toBeLessThan(all.species.length);
  });
});

describe("the partition check catches a taxonomy that does not partition", () => {
  const good = head(
    ["Aedes albopictus", "Culex pipiens"],
    [
      { genus: "Aedes", subfamily: "Culicinae", family: "Culicidae" },
      { genus: "Culex", subfamily: "Culicinae", family: "Culicidae" },
    ],
  );

  it("passes a well-formed taxonomy", () => {
    expect(() => assertPartition(good)).not.toThrow();
  });

  it("rejects a taxonomy whose length does not match the species", () => {
    const bad = head(["Aedes albopictus", "Culex pipiens"], [{ genus: "Aedes" }]);
    expect(() => assertPartition(bad)).toThrow(/2 entries for 2 species|1 entries for 2 species/);
  });

  it("rejects an entry that names a different species than the row it sits on", () => {
    // The failure this catches is invisible downstream: the arrays are read in
    // parallel, so a swap files two species under each other's genus.
    const bad = head(
      ["Aedes albopictus", "Culex pipiens"],
      [
        { species: "Culex pipiens", genus: "Aedes" },
        { species: "Aedes albopictus", genus: "Culex" },
      ],
    );
    expect(() => assertPartition(bad)).toThrow(/names "Culex pipiens" but head\.species\[0\]/);
  });

  it("does not crash on a taxonomy that drops a species, and says so at the ranks it cannot guess", () => {
    // Dropping is not splitting: the fallback files it, so the count still adds
    // up and the check passes. There is no exception, because a half-migrated
    // head should degrade rather than refuse to boot.
    const partial = head(
      ["Aedes albopictus", "Culex pipiens"],
      [{ genus: "Aedes", subfamily: "Culicinae", family: "Culicidae" }, {}],
    );
    expect(() => assertPartition(partial)).not.toThrow();
    // At genus there IS something sensible to fall back to — the first word of a
    // binomial is its genus — so this entry is simply "Culex", not a visible hole.
    expect(rankGroups(partial, "genus").map((g) => g.name)).toEqual(["Aedes", "Culex"]);
    // Above genus there is nothing to invent, so the gap is visible in the list
    // rather than silent.
    expect(rankGroups(partial, "family").map((g) => g.name)).toContain("unclassified (Culex pipiens)");
  });
});

describe("the flag decides whether a head's taxonomy is read at all", () => {
  const withTax = head(
    ["Aedes albopictus", "Culex pipiens"],
    [
      { genus: "Aedes", subfamily: "Culicinae", family: "Culicidae" },
      { genus: "Culex", subfamily: "Culicinae", family: "Culicidae" },
    ],
  );
  const without = head(["Aedes albopictus", "Culex pipiens"]);

  it("reads the taxonomy when the head has one", () => {
    expect(taxonomyEnabled(withTax, "")).toBe(true);
  });

  it("falls back when the head has none", () => {
    expect(taxonomyEnabled(without, "")).toBe(false);
  });

  it("?taxonomy=off forces the fallback, for A/B measurement", () => {
    expect(taxonomyEnabled(withTax, "?taxonomy=off")).toBe(false);
    expect(taxonomyEnabled(withTax, "?a=1&taxonomy=off&b=2")).toBe(false);
    expect(taxonomyEnabled(withTax, "?taxonomy=0")).toBe(false);
  });

  it("?taxonomy=on forces it on, which is how a half-migrated head is tested", () => {
    expect(taxonomyEnabled(without, "?taxonomy=on")).toBe(true);
    expect(taxonomyEnabled(without, "?taxonomy=1")).toBe(true);
  });

  it("is not fooled by a parameter that merely contains the word", () => {
    expect(taxonomyEnabled(withTax, "?taxonomy=offline")).toBe(true);
    expect(taxonomyEnabled(withTax, "?notaxonomy=off")).toBe(true);
  });

  it("makes the genus index follow the flag", () => {
    // With the taxonomy on, "Aedes" and "Culex" come from the file. With it off
    // the index falls all the way back to the first-word rule, so a measurement
    // of "does the taxonomy help" is measuring the taxonomy and nothing else.
    // These two heads differ only in whether they ship one, which is what makes
    // the comparison mean anything.
    expect([...effectiveGenusIndex(withTax).keys()].sort()).toEqual(["Aedes", "Culex"]);
    expect([...effectiveGenusIndex(without).keys()].sort()).toEqual(["Aedes", "Culex"]);
    // A label whose first word is not its genus is where the two diverge.
    const odd = head(
      ["Aedes albopictus", "Other Diptera"],
      [{ genus: "Aedes" }, { genus: "Diptera", family: "Diptera" }],
    );
    expect([...effectiveGenusIndex(odd).keys()].sort()).toEqual(["Aedes", "Diptera"]);
    expect([...speciesGenusIndex(odd).keys()].sort()).toEqual(["Aedes", "Other"]);
  });
});

describe("the shipped 16-species heads are unaffected", () => {
  it("reads the real b/16 head with the first-word rule, since it ships no taxonomy", async () => {
    const raw = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("../public/text_embeds_b16.json", import.meta.url), "utf8"),
      ),
    ) as { species: string[] };
    const h = { species: raw.species, dim: 512, logit_scale: 2.5 } as unknown as Head;
    expect(taxonomyEnabled(h, "")).toBe(false);
    expect(() => assertPartition(h)).not.toThrow();
    // Sixteen labels across four genera, and the family level is honestly marked
    // unknown rather than guessed.
    expect(rankGroups(h, "genus").length).toBeLessThan(raw.species.length);
    expect(rankGroups(h, "family").every((g) => g.name.startsWith("unclassified ("))).toBe(true);
    const spP = uniform(raw.species.length);
    for (const rank of RANKS) {
      expect(rankedScores(h, spP, rank).reduce((n, g) => n + g.p, 0)).toBeCloseTo(1, 10);
    }
  });
});
