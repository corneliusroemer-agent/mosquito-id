// The shapes the confidence subsystem passes between itself.
//
// EMB (called `head` here, because "the classifier's label set and embeddings"
// is what it is and `EMB` was only ever a variable name) is the loaded
// text_embeds.json. It is a PARAMETER of every function below rather than a
// module-level global, which is the point of the extraction: a test can build a
// head out of the real label list and synthetic embeddings, or out of a
// three-species fixture, without a 660 KB file or a 1.26 GB model.
export interface Head {
  /** Species labels, in the order `species_emb` is laid out in. */
  species: string[];
  /** Length of one embedding. Every embedding in the head is this long. */
  dim: number;
  /**
   * The cosine-to-logit scale. Raw logits run to hundreds, so this is what
   * keeps `exp()` finite; it is also what makes two views poolable, because
   * log p = scale * cos - logZ only holds at a known scale.
   */
  logit_scale: number;
  /** Adjacent (confusable non-mosquito) classes. Absent on older embeds files. */
  adjacent?: string[];
  /** Plain-language name per adjacent class, index-aligned with `adjacent`. */
  adjacent_common?: string[];
  /** Nuisance ("not an insect") classes. Pooled as mass only, never by name. */
  nuisance?: string[];
  species_emb?: Float32Array | number[];
  adjacent_emb?: Float32Array | number[];
  nuisance_emb?: Float32Array | number[];
}

/** One view's contribution to a fusion: its species posterior, nuisance mass, and the scale it was scored at. */
export interface ViewResult {
  /** Species posterior for this view. Length = species.length. */
  spP: number[];
  /** Combined posterior of every nuisance class for this view. */
  nuTotal: number;
  /** Per-class adjacent posteriors, or absent if this view scored none. */
  adP?: number[];
  /**
   * The logit scale this view was scored at. Carried on the view rather than
   * read from the current engine at fuse time, because the engine can be
   * switched while a photo's second view is still in flight.
   */
  scale: number;
}

/** What viewAgreement() reports about the views that produced a fused posterior. */
export interface Agreement {
  agree: boolean;
  topSpecies: string;
  /** Species named by a view other than the fused winner. */
  runnersUp: string[];
  fusedTop: number;
}

/** A named runner-up species and its posterior, as verdictFrom() reports it. */
export interface RunnerUp {
  name: string;
  p: number;
}

export type VerdictState = "species" | "genus" | "non-mosquito" | "unsure";

/**
 * What the app will claim about one photo. Coarser states leave the finer
 * fields null rather than carrying a name they do not support, so a consumer
 * cannot read a species off a genus verdict by forgetting to check `state`.
 */
export interface Verdict {
  state: VerdictState;
  genus: string | null;
  species: string | null;
  topGenusP: number;
  topSpeciesP: number;
  /** Siblings of `genus`, descending. Empty whenever no genus is named. */
  runnersUp: RunnerUp[];
  /**
   * The most likely species within `genus`, set whenever a genus is named -
   * including when `species` is null.
   *
   * `species` is the CLAIM: it is null in the genus state because no species
   * cleared its floor. `topSpecies` is the LEADER, and the genus sentence needs
   * it: `runnersUp` holds every sibling except the winner, so a sentence built
   * from `runnersUp` names the second and third place and never the most likely
   * species, which reads as though the top three were a tie.
   */
  topSpecies?: string;
  /**
   * The leading species overall, descending, in the UNSURE state only.
   *
   * `runnersUp` is scoped to the leading genus, which is the wrong set when no
   * genus is named: an undecided photo can be torn between Anopheles and Culex,
   * and naming Anopheles' siblings would report a tie the posterior does not
   * show. This is the set across genera that the abstention actually has.
   */
  candidates?: RunnerUp[];
  /** Adjacent class name, in the non-mosquito state only. */
  adjacent?: string;
  /** Plain-language adjacent name, in the non-mosquito state only. */
  adjacentCommon?: string;
  /**
   * The winning nuisance class, in the non-mosquito state only and only when the
   * nuisance block is what tripped the gate.
   *
   * Mutually exclusive with `adjacent`. A nuisance row says there is nothing
   * mosquito-like in the picture - a wall, a hand, a plant - so there is no insect
   * family to name, and naming one would be a guess presented as a finding.
   */
  nuisance?: string;
  /** The winning class's own posterior, in the non-mosquito state only. */
  adjacentP?: number;
  /**
   * Which block tripped the gate. "adjacent" is a different insect and the verdict
   * names its family; "nuisance" is nothing mosquito-like and the verdict says so
   * without inventing one.
   */
  nonMosquitoKind?: "adjacent" | "nuisance";
  /**
   * The mass of the block that tripped the gate, not the sum of both: the two are
   * compared against different floors, so their totals are not on one axis and
   * adding them would be a third number that means neither.
   */
  nonMosquitoP?: number;
}

/** Genus -> member indices into `spP`. */
export type GenusIndex = Map<string, number[]>;

/**
 * The thresholds, gathered so a test can move one without editing a function.
 *
 * The defaults are the shipped values. Keeping them as data rather than as
 * constants read out of the module scope is what makes "run this function in
 * isolation" possible: the arithmetic can be exercised at a floor it will never
 * ship at, which is how the boundary cases below were found.
 */
export interface Floors {
  /**
   * SPECIES_CONFIDENCE_FLOOR 0.373 - the 90%-coverage point, val-fitted on the
   * 659-row corpus and read once on test: 88% of test images answered at 96.6%
   * accuracy against the shipped argmax's 88.0% on the same rows.
   */
  species: number;
  /**
   * GENUS_CONFIDENCE_FLOOR 0.80 - a genus is easier to get right than a species,
   * so the floor is higher. Refit on the 6,264-image cache: the previous 0.54
   * was right on only 76% of the rows it answered, failures concentrated
   * (naming Anopheles on Culiseta photos, 1 of 13 correct). At 0.80, genus-only
   * answers are 93% correct and whole-set accuracy rises 86.10% -> 87.16% for
   * 5.3pp less coverage. The direction is solid; the value is not sharply
   * identified (a 95% bar gives 0.766).
   */
  genus: number;
  /**
   * NON_MOSQUITO_FLOOR 0.60 - the ADJACENT block only, and chosen for behaviour
   * rather than fitted. The adjacent classes share the one softmax with the
   * species, so their total is already on the species posterior's axis.
   *
   * Now measured on a negative set as well as the positives, which it was not
   * before: against 700 detector-verified in-domain background crops it costs
   * 15 of 6,264 true mosquitoes (0.239%) and catches 11 of the 700 (1.6%). So
   * the floor is expensive in the currency it was fitted in and weak in the one
   * it was not - which is why it is one number for one block rather than the
   * gate's single answer.
   */
  nonMosquito: number;
  /**
   * NUISANCE_FLOOR 0.05 - MEASURED, and deliberately an order of magnitude
   * below `nonMosquito` rather than equal to it.
   *
   * The two blocks cannot share a floor because their masses are on different
   * scales. Over the same 700 negatives and 6,264 mosquitoes, nuisance mass
   * reaches at most 0.498 and 0.204 respectively - so a 0.60 floor on this block
   * is a floor nothing ever reaches, and the whole "this photo is a wall" path
   * would be dead code that reads as working.
   *
   * 0.05 is the operating point where the block earns its place: it adds 69 of
   * the 700 negatives (11.4% caught in total) for 15 more lost mosquitoes
   * (0.479%), i.e. it quadruples what the gate rejects at the same false-positive
   * rate the adjacent block already cost. Raising it to 0.10 buys half that
   * (5.7%) for 17 lost; 0.02 buys 26.9% for 60 lost. 0.05 is the knee, not a
   * round number chosen for how it reads.
   */
  nuisance: number;
  /**
   * Whether two views naming different species cost the photo its species
   * claim. BOOLEAN because that is what the data identifies: on the 180-row
   * two-view cache, views agree -> genus correct 93.8% val / 95.2% test,
   * disagree -> 63.6% val / 65.2% test, and species claims made on disagreeing
   * rows are right 18.2% val / 33.3% test. A graded form (abstain only when the
   * disagreement is also narrow) is flat in margin across 1..30 points on val,
   * so a graded threshold would be a number the corpus does not contain.
   */
  viewDisagreementVetoesSpecies: boolean;
  /**
   * TEMPERATURE 2.5 - measured on the 112-image benchmark: as shipped (T=1) the
   * softmax reports 0.940 mean confidence against 0.848 true accuracy. T=2.5
   * cuts NLL by a third, roughly halves ECE, and leaves top-1 unchanged. Fitting
   * it by cross-validation at n=112 is actively harmful: each fold chose T~8.7
   * and held-out NLL got worse.
   */
  temperature: number;
}

export const DEFAULT_FLOORS: Floors = Object.freeze({
  species: 0.373,
  genus: 0.80,
  nonMosquito: 0.60,
  nuisance: 0.05,
  viewDisagreementVetoesSpecies: true,
  temperature: 2.5,
});

/**
 * The softmax scale a locally-scored view is at: the head's logit scale, with
 * the temperature applied by division. The server does not apply the
 * temperature, so its posteriors sit on a different scale and pooling one of
 * each would be arithmetic on incomparable numbers.
 */
export function localViewScale(head: Head, floors: Floors = DEFAULT_FLOORS): number {
  return head.logit_scale / floors.temperature;
}

export function serverViewScale(head: Head): number {
  return head.logit_scale;
}
