const STOPWORDS = new Set(
  `a an the and or of to in on at for with is are was were be been being it its this that these those
   as by from not no when where which what how do does did can could should would will may might must if
   then than so but also any all more most into over under after before during there their they we you
   i me my our your he she his her has have had please need want get got`.split(/\s+/),
);

// Query-side lexical bridge. Deliberately small: enough to prove cross-language
// matching works, not a substitute for a real translation layer.
const SYNONYMS = {
  alarm: ['error', 'fault', 'code', 'fehler', 'stoerung', 'störung'],
  error: ['alarm', 'fault', 'fehler'],
  fault: ['alarm', 'error', 'fehler'],
  seal: ['sealing', 'seam', 'weld', 'siegel', 'siegelnaht'],
  seam: ['seal'],
  leak: ['leaking', 'undicht', 'tightness'],
  vacuum: ['vakuum', 'evacuation', 'mbar'],
  pressure: ['druck'],
  chain: ['kette', 'gripper'],
  film: ['folie'],
  temperature: ['temperatur', 'heat', 'heater'],
  part: ['ersatzteil', 'spare'],
  jam: ['stuck', 'blocked', 'klemmt'],
  replace: ['wechseln', 'tauschen', 'renew'],
  slow: ['sluggish', 'creeping'],
  hold: ['held', 'holding', 'maintain'],
  micron: ['thickness', 'gauge'],
};

function stem(word) {
  const forms = new Set([word]);
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) forms.add(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    forms.add(word.slice(0, -1));
  }
  if (word.length > 5 && word.endsWith('ing')) {
    forms.add(word.slice(0, -3));
    forms.add(`${word.slice(0, -3)}e`);
  }
  if (word.length > 4 && word.endsWith('ed')) {
    forms.add(word.slice(0, -1));
    forms.add(word.slice(0, -2));
  }
  return [...forms];
}

/**
 * Expansions are bidirectional within each synonym group, so a German word in the
 * question reaches the English word in the manual, not only the other way round.
 */
const EXPANSIONS = (() => {
  const map = new Map();
  for (const [key, values] of Object.entries(SYNONYMS)) {
    const group = [key, ...values];
    for (const word of group) {
      const set = map.get(word) ?? new Set();
      for (const other of group) if (other !== word) set.add(other);
      map.set(word, set);
    }
  }
  return map;
})();

/** Normalises units so a question written in words matches a manual written in symbols. */
function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[µμ]m\b/g, ' micron ')
    .replace(/°/g, ' ');
}

export function terms(text) {
  const out = [];
  for (const raw of normalise(text).split(/[^a-z0-9äöüß]+/)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    for (const form of stem(raw)) out.push(form);
  }
  return out;
}

/**
 * Each word in the question becomes one "concept group". A word and its
 * synonyms or translations are alternatives for the same group, so coverage is
 * measured in concepts rather than surface tokens. The returned array carries a
 * `groupCount` property used by termCoverage.
 */
export function buildQuery(text) {
  const weighted = new Map();
  let groupCount = 0;

  const add = (term, weight, group) => {
    const entry = weighted.get(term) ?? { weight: 0, groups: new Set() };
    entry.weight = Math.max(entry.weight, weight);
    entry.groups.add(group);
    weighted.set(term, entry);
  };

  for (const raw of normalise(text).split(/[^a-z0-9äöüß]+/)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    const group = groupCount++;
    for (const form of stem(raw)) add(form, 1, group);
    for (const synonym of EXPANSIONS.get(raw) ?? []) {
      for (const form of stem(synonym)) add(form, 0.6, group);
    }
  }

  const terms = [...weighted.entries()].map(([term, entry]) => ({
    term,
    weight: entry.weight,
    groups: [...entry.groups],
  }));
  terms.groupCount = groupCount;
  return terms;
}

const K1 = 1.5;
// Sections vary a lot in length (a one-line warning vs. a full procedure), so the
// usual 0.75 length penalty buries the long procedural sections that matter most.
const B = 0.5;

export function buildIndex(chunks) {
  const documents = chunks.map((chunk) => {
    const tokens = terms(`${chunk.section} ${chunk.text}`);
    const frequencies = new Map();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    return { chunk, frequencies, length: tokens.length, termSet: new Set(frequencies.keys()) };
  });

  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of document.termSet) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const totalLength = documents.reduce((sum, d) => sum + d.length, 0);
  return {
    documents,
    documentFrequency,
    averageLength: documents.length ? totalLength / documents.length : 0,
    total: documents.length,
  };
}

function idf(index, term) {
  const df = index.documentFrequency.get(term) ?? 0;
  return Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
}

/**
 * Term rarity scaled to 0..1. Used to decide whether two sentences are really
 * about the same component: sharing "seal" or "gas" means little, sharing
 * "PTFE" or "vane" means a lot.
 */
export function distinctiveness(index) {
  const scores = new Map();
  let max = 0;
  for (const term of index.documentFrequency.keys()) {
    const value = idf(index, term);
    scores.set(term, value);
    if (value > max) max = value;
  }
  if (max > 0) for (const [term, value] of scores) scores.set(term, value / max);
  return scores;
}

/**
 * BM25 with metadata boosts. Machine mismatch is penalised rather than excluded,
 * so a generic error-code document still surfaces for a machine-specific question.
 */
export function search(index, query, { machine = null, type = null, alarm = null, limit = 10 } = {}) {
  const results = [];
  for (const document of index.documents) {
    if (type && document.chunk.type !== type) continue;

    let score = 0;
    for (const { term, weight } of query) {
      const frequency = document.frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const denominator =
        frequency + K1 * (1 - B + (B * document.length) / (index.averageLength || 1));
      score += weight * idf(index, term) * ((frequency * (K1 + 1)) / denominator);
    }
    if (score === 0) continue;

    if (machine) {
      if (document.chunk.machine === machine) score *= 1.9;
      else if (document.chunk.machine === 'all') score *= 1.05;
      else score *= 0.55;
    }

    // An explicitly named alarm code is an identifier, not a word: the chunk that
    // documents that exact code is the one the technician needs.
    if (alarm !== null && new RegExp(`\\b${alarm}\\b`).test(document.chunk.text)) score *= 1.6;

    results.push({ chunk: document.chunk, score, termSet: document.termSet });
  }

  results.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return results.slice(0, limit);
}

/**
 * Fraction of the question's terms that the retrieved context actually covers.
 * Synonym and translation expansions count, so a German question scores fairly
 * against an English manual.
 */
export function termCoverage(query, results) {
  if (!query.groupCount) return 0;
  const byTerm = new Map(query.map((q) => [q.term, q]));
  const covered = new Set();
  for (const result of results.slice(0, 3)) {
    for (const term of result.termSet) {
      const match = byTerm.get(term);
      if (match) for (const group of match.groups) covered.add(group);
    }
  }
  return covered.size / query.groupCount;
}
