/**
 * How a checked photo reaches the pooled sum.
 *
 * The rule under test: a checked photo is never silently discarded. A photo the
 * gate named is pooled at full weight, one it could not name is pooled at a
 * weight derived from its own posterior, and one the gate says is not a mosquito
 * is not pooled at all - because "not a mosquito" is evidence against every
 * species, so no small enough weight carries the same meaning.
 *
 * The arithmetic is pinned against hand-computed values rather than against
 * itself: every expectation here is a number the reader can check, so a change
 * to the formula fails a test that says what it became.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { realHead, post } from "./fixtures";
import type { Head } from "../src/confidence/types";
import { DEFAULT_FLOORS } from "../src/confidence/types";
import { verdictFrom } from "../src/confidence/verdict";
import {
  splitPoolable,
  unsurePoolWeight,
  poolingWeights,
  aggregateLogits,
  pooledPosterior,
  pooledVerdict,
  UNSURE_POOL_WEIGHT_CAP,
  type PoolablePhoto,
} from "../src/confidence/pooling";

let head: Head;
beforeAll(() => {
  head = realHead();
});

/** logits = log p + logZ, which is the axis `aggregateLogits` sums. */
function logitsFor(spP: number[], logZ = 5): Record<string, number> {
  const out: Record<string, number> = {};
  head.species.forEach((name, i) => {
    out[name] = Math.log(Math.max(spP[i]!, 1e-12)) + logZ;
  });
  return out;
}

/**
 * A photo whose best species holds `top` and the other 15 share the rest, which
 * is the shape a real classification has. A posterior that is exactly 0
 * everywhere else would drive the pool's winner to 1.0 and saturate every
 * comparison made against it.
 */
function peaked(species: string, top: number): Record<string, number> {
  const rest = (1 - top) / (head.species.length - 1);
  return Object.fromEntries(head.species.map((s) => [s, s === species ? top : rest]));
}

/** A photo carrying `over` as its posterior, with the verdict the app's own gate gives it. */
function photo(name: string, over: Record<string, number>, extra: Partial<PoolablePhoto> = {}): PoolablePhoto {
  const spP = post(head, over);
  return {
    name,
    fingerprint: name,
    scores: Object.fromEntries(head.species.map((s, i) => [s, spP[i]!])),
    logits: logitsFor(spP),
    verdict: verdictFrom(head, spP, null, []),
    ...extra,
  };
}

/** Species, genus and unsure photos the shipped floors actually produce. */
const NAMED = (name: string, species: string) => photo(name, peaked(species, 0.72));
const UNSURE = (name: string, species: string, top: number) => photo(name, peaked(species, top));

describe("a checked photo is never silently discarded", () => {
  it("an unsure photo is IN the pool, where it used to be dropped", () => {
    const unsure = UNSURE("blur.jpg", "Aedes albopictus", 0.12);
    expect(unsure.verdict!.state).toBe("unsure");
    const { included, excluded, pending } = splitPoolable([unsure]);
    // Before the change this photo was in `abstained`: not in the sum at all.
    expect(included.map((p) => p.name)).toEqual(["blur.jpg"]);
    expect(included[0]!.poolWeight).toBeGreaterThan(0);
    expect(excluded).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("a non-mosquito photo stays EXCLUDED from the species sum", () => {
    const AD = (head.adjacent ?? []).length;
    const spP = post(head, { "Aedes aegypti": 0.2, "Culex pipiens": 0.1 });
    const adP = new Array<number>(AD).fill(0);
    adP[0] = 0.9;
    const midge: PoolablePhoto = {
      name: "midge.jpg",
      fingerprint: "midge",
      scores: Object.fromEntries(head.species.map((s, i) => [s, spP[i]!])),
      logits: logitsFor(spP),
      verdict: verdictFrom(head, spP, null, adP),
    };
    expect(midge.verdict!.state).toBe("non-mosquito");
    const { included, excluded } = splitPoolable([midge]);
    expect(included).toEqual([]);
    expect(excluded.map((p) => p.excludedBecause)).toEqual(["non-mosquito"]);
    // And it contributes nothing even when forced into the aggregate.
    const agg = aggregateLogits(head, included, poolingWeights(included, "Dependent evidence", 0.5));
    expect(agg[head.species[0]!]).toBe(0);
  });

  it("a photo with no verdict is excluded as no-verdict, not silently dropped", () => {
    const { included, excluded, pending } = splitPoolable([{ name: "never-ran.jpg" }]);
    expect(included).toEqual([]);
    expect(excluded.map((p) => p.excludedBecause)).toEqual(["no-verdict"]);
    expect(pending).toEqual([]);
  });

  it("a pending or failed photo is pending, not excluded", () => {
    const { included, excluded, pending } = splitPoolable([
      { name: "a.jpg", pending: true },
      { name: "b.jpg", error: "boom" },
    ]);
    expect(included).toEqual([]);
    expect(excluded).toEqual([]);
    expect(pending.map((p) => p.name)).toEqual(["a.jpg", "b.jpg"]);
  });
});

describe("the down-weight formula, pinned", () => {
  it("is the photo's own top species posterior, capped at the species floor", () => {
    // Hand-computed: top posterior 0.12, cap 0.373 -> 0.12.
    expect(unsurePoolWeight(UNSURE("a.jpg", "Aedes albopictus", 0.12))).toBeCloseTo(0.12, 12);
    // 0.30 -> 0.30: below the cap, taken whole.
    expect(unsurePoolWeight(UNSURE("b.jpg", "Culex pipiens", 0.3))).toBeCloseTo(0.3, 12);
    // The cap is the species floor, not a constant of its own.
    expect(UNSURE_POOL_WEIGHT_CAP).toBe(DEFAULT_FLOORS.species);
    expect(unsurePoolWeight(UNSURE("c.jpg", "Aedes aegypti", 0.95))).toBeCloseTo(0.373, 12);
    // A degenerate posterior contributes nothing rather than NaN.
    expect(unsurePoolWeight({ name: "d.jpg", verdict: { state: "unsure" } as never })).toBe(0);
  });

  it("a photo the gate named carries full weight", () => {
    const { included } = splitPoolable([NAMED("a.jpg", "Aedes aegypti")]);
    expect(included[0]!.poolWeight).toBe(1);
  });

  it("three named photos and one unsure one: the unsure share is 0.12/3.12", () => {
    // Dependent evidence on four distinct photos at r=0.5 gives each 1/2.5 =
    // 0.4, total 1.6. Scaling by poolWeight gives [0.4, 0.4, 0.4, 0.048]; the
    // total is then restored to the 1.6 the method asked for, which scales every
    // weight by the same factor and so leaves the shares alone. The unsure
    // photo's share is therefore 0.048 / 1.248 = 0.12 / 3.12: its weight over the
    // total of the weights it shares with.
    const { included } = splitPoolable([
      NAMED("a.jpg", "Aedes aegypti"),
      NAMED("b.jpg", "Aedes aegypti"),
      NAMED("c.jpg", "Aedes aegypti"),
      UNSURE("d.jpg", "Aedes albopictus", 0.12),
    ]);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const total = w.reduce((x, y) => x + y, 0);
    expect(w[3]! / total).toBeCloseTo(0.12 / 3.12, 12);
    expect(total).toBeCloseTo(1.6, 12);
  });

  it("every pooling method keeps the same ratio between a named and an unsure photo", () => {
    // The four methods disagree about what a photo is worth - "Weight by lead"
    // already discounts a flat posterior, "Dependent evidence" discounts a
    // duplicate - so the down-weight cannot be an absolute number. It composes
    // with the method multiplicatively: an unsure photo takes exactly its
    // `poolWeight` fraction of whatever the method gave it. That is checkable
    // without knowing the method's own number, by weighting the same photos
    // with the unsure one promoted to a named photo and taking the ratio.
    for (const method of ["Equal weight", "Weight by lead", "Accumulate evidence", "Dependent evidence"] as const) {
      const down = splitPoolable([
        NAMED("a.jpg", "Aedes aegypti"),
        NAMED("b.jpg", "Aedes aegypti"),
        UNSURE("c.jpg", "Aedes albopictus", 0.24),
      ]).included;
      const up = down.map((p) => ({ ...p, poolWeight: 1 }));
      const wd = poolingWeights(down, method, 0.5);
      const wu = poolingWeights(up, method, 0.5);
      const share = (w: number[]) => w.map((v) => v / w.reduce((x, y) => x + y, 0));
      const sd = share(wd);
      const su = share(wu);
      // The method's own judgement of the two photos, before the down-weight.
      const methodRatio = su[2]! / su[0]!;
      // After it: exactly 0.24 of that. The down-weight scales this photo only,
      // and the total is unchanged so the named photos keep their relative order.
      expect(sd[2]! / sd[0]!, `${method} must apply the 0.24 down-weight`).toBeCloseTo(0.24 * methodRatio, 12);
      expect(sd[1]! / sd[0]!, `${method} must leave the named photos equal`).toBeCloseTo(1, 12);
      // The down-weight moves weight between photos, it does not add or remove it.
      expect(wd.reduce((x, y) => x + y, 0), `${method} must keep the total`).toBeCloseTo(
        wu.reduce((x, y) => x + y, 0), 12,
      );
    }
  });

  it("no unsure photos leaves every method's weights bit-for-bit unchanged", () => {
    const photos = [NAMED("a.jpg", "Aedes aegypti"), NAMED("b.jpg", "Aedes aegypti")];
    const { included } = splitPoolable(photos);
    // Equal weight: 1/2 each, exactly.
    expect(poolingWeights(included, "Equal weight", 0.5)).toEqual([0.5, 0.5]);
    expect(poolingWeights(included, "Accumulate evidence", 0.5)).toEqual([1, 1]);
    // Two distinct photos: the correlation factor discounts them to 1/1.5 each.
    expect(poolingWeights(included, "Dependent evidence", 0.5)).toEqual([2 / 3, 2 / 3]);
  });
});

describe("an unsure photo corroborates but cannot overrule", () => {
  /** Three photos naming one species plus one unsure naming another. */
  function pool(withUnsure: boolean) {
    const list: PoolablePhoto[] = [
      NAMED("a.jpg", "Aedes aegypti"),
      NAMED("b.jpg", "Aedes aegypti"),
      NAMED("c.jpg", "Aedes aegypti"),
    ];
    if (withUnsure) list.push(UNSURE("blur.jpg", "Aedes albopictus", 0.30));
    const { included } = splitPoolable(list);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    return { agg: aggregateLogits(head, included, w), spP: pooledPosterior(head, aggregateLogits(head, included, w))!, included };
  }

  it("the confident species wins", () => {
    const { spP } = pool(true);
    const best = head.species[spP.indexOf(Math.max(...spP))];
    expect(best).toBe("Aedes aegypti");
  });

  it("the unsure photo counts for less than the confident photos it sits beside", () => {
    // The guarantee a down-weight has to give, stated on the numbers: swapping
    // the unsure photo for a fourth confident photo of the same species always
    // raises the winner's posterior, at every down-weight the cap allows. So
    // the unsure photo can neither overturn the pool nor stand in for evidence
    // the pool does not have.
    //
    // Note the direction: because this unsure photo names the OTHER species, it
    // necessarily REDUCES the winner's lead. Removing it makes the margin
    // LARGER. A test asserting the opposite would be asserting that a photo
    // disagreeing with the pool helps the pool.
    const pWinner = (extra: PoolablePhoto) => {
      const { included } = splitPoolable([
        NAMED("a.jpg", "Aedes aegypti"),
        NAMED("b.jpg", "Aedes aegypti"),
        NAMED("c.jpg", "Aedes aegypti"),
        extra,
      ]);
      const agg = aggregateLogits(head, included, poolingWeights(included, "Dependent evidence", 0.5));
      return pooledPosterior(head, agg)![head.species.indexOf("Aedes aegypti")]!;
    };
    for (const top of [0.12, 0.24, 0.3, 0.37]) {
      const unsure = UNSURE("u.jpg", "Aedes albopictus", top);
      expect(pWinner(unsure), `top=${top}`).toBeLessThan(pWinner(NAMED("d.jpg", "Aedes aegypti")));
    }
  });

  it("and the pool may not name a species while it holds one", () => {
    const { agg, included } = pool(true);
    const v = pooledVerdict(head, agg, included);
    expect(v!.state).not.toBe("species");
    // Without it, the three named photos do name one.
    const named = pool(false);
    expect(pooledVerdict(head, named.agg, named.included)!.state).toBe("species");
  });

  it("one unsure photo cannot swing a pool of named photos", () => {
    // The same three named photos, but the unsure photo is maximally unsure and
    // maximally wrong about another species. The margin must stay positive.
    const { included } = splitPoolable([
      NAMED("a.jpg", "Aedes aegypti"),
      NAMED("b.jpg", "Aedes aegypti"),
      NAMED("c.jpg", "Aedes aegypti"),
      UNSURE("d.jpg", "Culex pipiens", 0.37),
    ]);
    const agg = aggregateLogits(head, included, poolingWeights(included, "Dependent evidence", 0.5));
    const spP = pooledPosterior(head, agg)!;
    expect(head.species[spP.indexOf(Math.max(...spP))]).toBe("Aedes aegypti");
  });
});
