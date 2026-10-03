import type { SpeciesMeta } from "./types";

/**
 * What is known about each species, outside the classifier.
 *
 * A record keyed by binomial, read only for its `common`, `wiki` and
 * `vectors` fields. A species the classifier can score but this has no entry
 * for renders as a bare name with no guide link - the lookups below are
 * deliberately optional-chained rather than assumed present, because the label
 * set and this table are edited separately and a new species must be able to
 * arrive in one before the other.
 */
export const SPECIES_META: Record<string, SpeciesMeta> = {
  "Aedes albopictus": {
    common: "Asian tiger mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_albopictus",
    vectors: "Dengue, Chikungunya, Zika",
    range: "Originally East Asia; now globally invasive in tropical and temperate regions",
    activity: "Aggressive daytime biter, peak at dawn and dusk",
    hosts: "Primarily humans, also birds and other mammals",
    notes: "Black-and-white striped legs. Key invasive species spreading through global trade."
  },
  "Aedes aegypti": {
    common: "Yellow fever mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_aegypti",
    vectors: "Dengue, Zika, Yellow fever, Chikungunya",
    range: "Tropical and subtropical regions worldwide, originated in Africa",
    activity: "Daytime biter, breeds in small artificial containers",
    hosts: "Strongly anthropophilic (prefers humans)",
    notes: "Lyre-shaped white markings on thorax. Primary vector for urban dengue and Zika."
  },
  "Aedes japonicus": {
    common: "Asian bush mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_japonicus",
    vectors: "West Nile virus, Japanese encephalitis (potential)",
    range: "Native to East Asia; invasive in Europe and North America",
    activity: "Daytime biter, breeds in rock pools and artificial containers",
    hosts: "Mammals and birds",
    notes: "Large dark mosquito with golden-brown scaling. Tolerates cooler climates than most Aedes."
  },
  "Aedes koreicus": {
    common: "Korean mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_koreicus",
    vectors: "Japanese encephalitis, Dirofilaria (potential)",
    range: "Native to Korea/Japan; invasive in parts of Europe",
    activity: "Daytime biter, similar ecology to Ae. japonicus",
    hosts: "Mammals",
    notes: "Very similar to Ae. japonicus — reliably distinguished only by molecular methods."
  },
  "Aedes vexans": {
    common: "Inland floodwater mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_vexans",
    vectors: "Rift Valley fever, encephalitides (minor)",
    range: "Cosmopolitan — one of the most widespread mosquitoes globally",
    activity: "Aggressive crepuscular and nocturnal biter after flooding",
    hosts: "Mammals including humans, cattle, horses",
    notes: "Eggs survive desiccation for years. Mass emergence after floods or heavy rain."
  },
  "Aedes geniculatus": {
    common: "Tree-hole mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_geniculatus",
    vectors: "Potential Zika and Chikungunya vector (lab competence)",
    range: "Europe and parts of western Asia, forest-dwelling",
    activity: "Daytime biter in shaded woodland areas",
    hosts: "Mammals in forested habitats",
    notes: "Breeds in tree holes and natural containers. Large, dark species with banded legs."
  },
  "Aedes cinereus": {
    common: "Woodland mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_cinereus",
    vectors: "Tularemia, arboviruses (minor)",
    range: "Northern Europe, Asia, and North America",
    activity: "Crepuscular biter in marshy woodland areas",
    hosts: "Mammals and birds",
    notes: "Common in northern latitudes. Breeds in temporary woodland pools in spring."
  },
  "Culex pipiens": {
    common: "Northern house mosquito", wiki: "https://en.wikipedia.org/wiki/Culex_pipiens",
    vectors: "West Nile virus, Usutu virus, lymphatic filariasis",
    range: "Temperate regions worldwide, highly urban-adapted",
    activity: "Nocturnal biter, overwinters as mated females",
    hosts: "Primarily birds (bridge vector to humans for West Nile virus)",
    notes: "Most common mosquito in temperate urban areas. Key bridge vector for West Nile virus."
  },
  "Culex torrentium": {
    common: "Woodland Culex", wiki: "https://en.wikipedia.org/wiki/Culex_torrentium",
    vectors: "West Nile virus, Sindbis virus",
    range: "Europe and parts of Asia",
    activity: "Nocturnal, similar ecology to Cx. pipiens",
    hosts: "Primarily birds",
    notes: "Nearly identical to Cx. pipiens — reliably distinguished only by molecular methods."
  },
  "Culex quinquefasciatus": {
    common: "Southern house mosquito", wiki: "https://en.wikipedia.org/wiki/Culex_quinquefasciatus",
    vectors: "West Nile virus, St. Louis encephalitis, lymphatic filariasis",
    range: "Tropical and subtropical regions worldwide",
    activity: "Nocturnal biter, breeds in polluted water",
    hosts: "Birds and mammals including humans",
    notes: "Major nuisance mosquito in the tropics. Tolerates highly polluted water."
  },
  "Culiseta annulata": {
    common: "Banded mosquito", wiki: "https://en.wikipedia.org/wiki/Culiseta_annulata",
    vectors: "Minor vector for avian malaria",
    range: "Europe, North Africa, western Asia",
    activity: "Year-round in mild climates, bites at dusk/dawn",
    hosts: "Birds and mammals including humans (painful bite)",
    notes: "One of the largest European mosquitoes. Distinctive banded legs and spotted wings."
  },
  "Culiseta morsitans": {
    common: "Northern Culiseta", wiki: "https://en.wikipedia.org/wiki/Culiseta_morsitans",
    vectors: "Eastern equine encephalitis virus (in North America)",
    range: "Northern Europe and North America",
    activity: "Crepuscular, breeds in semi-permanent woodland pools",
    hosts: "Primarily birds and larger mammals",
    notes: "Large mosquito in forested and rural habitats. Early-season species."
  },
  "Culiseta longiareolata": {
    common: "Mediterranean Culiseta", wiki: "https://en.wikipedia.org/wiki/Culiseta_longiareolata",
    vectors: "Not a significant disease vector",
    range: "Mediterranean region, Africa, Middle East, South Asia",
    activity: "Breeds in containers, rarely bites humans",
    hosts: "Primarily birds; very rarely bites mammals",
    notes: "Very common in Mediterranean countries. Often found in neglected swimming pools."
  },
  "Anopheles maculipennis": {
    common: "European malaria mosquito", wiki: "https://en.wikipedia.org/wiki/Anopheles_maculipennis",
    vectors: "Malaria (historical primary vector in Europe)",
    range: "Europe and western Asia",
    activity: "Nocturnal biter, breeds in clean sunlit water",
    hosts: "Mammals including humans and cattle",
    notes: "Species complex of ~11 siblings. Historically responsible for European malaria."
  },
  "Anopheles claviger": {
    common: "European Anopheles", wiki: "https://en.wikipedia.org/wiki/Anopheles_claviger",
    vectors: "Malaria (potential, minor historical role)",
    range: "Europe and western Asia",
    activity: "Nocturnal, breeds in shaded vegetated water",
    hosts: "Mammals",
    notes: "Prefers cooler, shaded habitats unlike An. maculipennis."
  },
  "Anopheles plumbeus": {
    common: "Tree-hole Anopheles", wiki: "https://en.wikipedia.org/wiki/Anopheles_plumbeus",
    vectors: "Malaria (confirmed autochthonous cases in Germany, Netherlands)",
    range: "Europe, from UK to Mediterranean",
    activity: "Aggressive day and night biter near forests",
    hosts: "Mammals including humans",
    notes: "Breeds exclusively in tree holes. Responsible for rare autochthonous malaria in Europe."
  }
};
