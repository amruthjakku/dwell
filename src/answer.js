import { loadCorpus, machineList, detectMachine, detectAlarm } from './corpus.js';
import { buildIndex, buildQuery, search, termCoverage, terms, distinctiveness } from './bm25.js';

const MIN_CONFIDENCE = 0.55;
const MIN_COVERAGE = 0.4;

// A cause is only shown if it is at least this close to the best-matching ticket,
// so unrelated history does not pad the answer with noise.
const CAUSE_SCORE_RATIO = 0.25;

// How many retrieved sections sentence selection may draw from. Citations still
// point at the section, so this buys sentence-level precision without
// fragmenting the reference.
const CONTEXT_DEPTH = 8;

const PROCEDURAL =
  /^(check|inspect|test|confirm|measure|verify|replace|fit|adjust|clean|clear|calibrate|reset|run|re-?place|re-?set|do not|never)\b/i;

const PRIMARY_VERB = /^(check|inspect|test|confirm|measure|verify)\b/i;

// Sentences that explain rather than merely mention are worth more than a
// passing keyword overlap.
const DIAGNOSTIC =
  /root cause|usually|most common|typically|points to|caused by|distribution|indicates|if the/i;

// This is a diagnostic tool. When the question is a specification or maintenance
// lookup rather than a fault, history must not be used to infer a cause.
const FAULT_CUE =
  /\b(alarm|error|fault|failing|fails|not holding|won'?t|leak|leaking|jam|jammed|drift|stuck|blocked|slow|hiss|deviation|weak|poor|stops|stopping|hot|overheat|bridging|webbing|wrinkl\w*|delaminat\w*)\b/i;

function looksLikeFault(question, alarm) {
  return alarm !== null || FAULT_CUE.test(question);
}

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);
}

function partRefs(text) {
  return [...text.matchAll(/\[P:(\d+)\]/g)].map((m) => m[1]);
}

function sentenceScore(sentence, queryByTerm, alarm, causeTerms = new Set(), rarity = new Map()) {
  let score = 0;
  const tokens = new Set(terms(sentence));
  for (const token of tokens) {
    const match = queryByTerm.get(token);
    if (match) score += match.weight;
  }
  if (alarm !== null && new RegExp(`\\b${alarm}\\b`).test(sentence)) score += 1.2;
  if (partRefs(sentence).length) score += 0.5;
  if (DIAGNOSTIC.test(sentence)) score += 0.6;
  if (causeTerms.size) {
    let overlap = 0;
    for (const token of tokens) {
      if (causeTerms.has(token)) overlap += rarity.get(token) ?? 0.3;
    }
    if (overlap) score += 1.8 * overlap;
  }
  // Long sentences collect more term hits purely by being long, so damp the
  // advantage above ~60 characters. Without this, a dense list-like line beats a
  // specific instruction every time.
  return score / (1 + 0.3 * Math.log(Math.max(1, sentence.length / 60)));
}

/**
 * Groups matching tickets by normalised cause. Tickets carry free text in
 * `resolution_cause`; `cause_class` is the taxonomy field that makes counting
 * possible at all.
 */
function aggregateCauses(ticketResults, alarm) {
  let pool = ticketResults;
  if (alarm !== null) {
    const sameAlarm = pool.filter((r) => String(r.chunk.ticket.alarm) === String(alarm));
    if (sameAlarm.length) pool = sameAlarm;
  }
  if (!pool.length) return [];

  const best = pool[0].score;
  const relevant = pool.filter((r) => r.score >= CAUSE_SCORE_RATIO * best && r.score > 0);
  if (!relevant.length) return [];

  const grouped = new Map();
  for (const result of relevant) {
    const ticket = result.chunk.ticket;
    const key = ticket.cause_class ?? ticket.resolution_cause;
    const entry = grouped.get(key) ?? {
      cause_class: key,
      detail: ticket.resolution_cause,
      action: ticket.resolution_action,
      tickets: [],
      parts: [],
      score: 0,
    };
    entry.tickets.push(ticket.id);
    entry.score = Math.max(entry.score, result.score);
    for (const part of ticket.parts ?? []) if (!entry.parts.includes(part)) entry.parts.push(part);
    grouped.set(key, entry);
  }

  return [...grouped.values()]
    .map((entry) => ({ ...entry, count: entry.tickets.length, of: relevant.length }))
    .sort((a, b) => b.count - a.count || b.score - a.score)
    .slice(0, 3);
}

function collectParts(chunks, causes, catalogue) {
  const ordered = [];
  const seen = new Set();

  const push = (number, fromHistory) => {
    if (seen.has(number)) return;
    seen.add(number);
    ordered.push({ number, fromHistory });
  };

  for (const cause of causes) for (const number of cause.parts) push(number, true);
  for (const chunk of chunks) for (const number of partRefs(chunk.text)) push(number, false);

  return ordered
    .slice(0, 5)
    .map(({ number, fromHistory }) => {
      const record = catalogue.find((p) => p.part_no === number);
      return record ? { ...record, from_history: fromHistory } : null;
    })
    .filter(Boolean);
}

/**
 * Picks the procedural sentence that addresses the most likely cause. A next step
 * that contradicts the ranked cause is worse than no next step at all.
 */
function pickNextStep(chunkTexts, queryByTerm, alarm, causeTerms, rarity) {
  const candidates = [];
  for (const text of chunkTexts) {
    for (const sentence of sentences(text)) {
      if (!PROCEDURAL.test(sentence)) continue;
      let score = sentenceScore(sentence, queryByTerm, alarm, causeTerms, rarity);
      if (PRIMARY_VERB.test(sentence)) score += 1;
      candidates.push({ sentence, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.sentence ?? null;
}

export function createEngine({ root = 'data' } = {}) {
  const corpus = loadCorpus(root);
  const index = buildIndex(corpus.chunks);
  const rarity = distinctiveness(index);
  const machines = machineList(corpus);

  function ask(question) {
    const query = buildQuery(question);
    const queryByTerm = new Map(query.map((q) => [q.term, q]));
    const machine = detectMachine(question, machines);
    const alarm = detectAlarm(question);

    const manualResults = search(index, query, {
      machine,
      type: 'manual',
      alarm,
      limit: CONTEXT_DEPTH,
    });
    const ticketResults = search(index, query, { machine, type: 'ticket', alarm, limit: 6 });

    const coverage = termCoverage(query, manualResults);
    const topScore = manualResults[0]?.score ?? 0;
    let confidence = 0.55 * (1 - Math.exp(-topScore / 12)) + 0.45 * coverage;

    const alarmSeen =
      alarm === null || manualResults.some((r) => new RegExp(`\\b${alarm}\\b`).test(r.chunk.text));
    if (alarm !== null && !alarmSeen) confidence *= 0.5;

    const grounded = confidence >= MIN_CONFIDENCE && coverage >= MIN_COVERAGE && alarmSeen;
    const primary = manualResults.slice(0, 3);

    const result = {
      status: grounded ? 'answered' : 'escalate',
      question,
      machine,
      alarm,
      confidence: Number(confidence.toFixed(3)),
      coverage: Number(coverage.toFixed(3)),
      topScore: Number(topScore.toFixed(2)),
      answer: [],
      causes: [],
      parts: [],
      nextStep: null,
      sources: [],
      closest: grounded
        ? []
        : manualResults.slice(0, 3).map((r) => ({
            docId: r.chunk.docId,
            section: r.chunk.section,
            score: Number(r.score.toFixed(2)),
          })),
    };

    if (!grounded) return result;

    // If the question did not name a machine, adopt the one the evidence points
    // at. Everything downstream then stays inside that family instead of mixing
    // parts and procedures from three different models.
    const effectiveMachine =
      machine ?? manualResults.find((r) => r.chunk.machine !== 'all')?.chunk.machine ?? null;
    const scoped = manualResults.filter(
      (r) => !effectiveMachine || r.chunk.machine === effectiveMachine || r.chunk.machine === 'all',
    );

    // History is ranked before prose is selected, so the answer explains the most
    // likely cause instead of the sentence that happens to share the most words.
    const diagnostic = looksLikeFault(question, alarm);
    result.causes = diagnostic ? aggregateCauses(ticketResults, alarm) : [];
    const topCause = result.causes[0] ?? null;
    // Only a dominant cause is allowed to steer the wording. When two causes tie,
    // history does not know more than the manual does, so it must not override it.
    const dominant =
      result.causes.length === 1 ||
      (result.causes.length > 1 && result.causes[0].count > result.causes[1].count);
    // Match on the component taxonomy, not the technician's free-text description:
    // "seam not gas tight" would otherwise pull in any sentence containing "gas".
    const causeTerms = new Set(topCause && dominant ? terms(topCause.cause_class) : []);

    const candidates = [];
    for (const entry of scoped) {
      // All-machines guidance is useful, but the technician's own manual is the
      // authority for his variant, so it wins ties.
      const machineBoost = effectiveMachine && entry.chunk.machine === effectiveMachine ? 1.2 : 1;
      const chunkWeight = machineBoost * (1 + 0.5 * (entry.score / (topScore || 1)));
      const parts = sentences(entry.chunk.text);
      parts.forEach((sentence, position) => {
        const score = sentenceScore(sentence, queryByTerm, alarm, causeTerms, rarity) * chunkWeight;
        if (score < 0.6) return;
        candidates.push({
          text: sentence,
          nextText: parts[position + 1] ?? null,
          score,
          docId: entry.chunk.docId,
          section: entry.chunk.section,
        });
      });
    }
    // Never mix codes: a question about alarm 49 must not be answered with the
    // definition of alarm 47 because both sit in the same taxonomy section.
    const usable =
      alarm === null
        ? candidates
        : candidates.filter((c) => {
            const defined = c.text.match(/\balarm\s+(\d{1,3})\b/i);
            return !defined || Number(defined[1]) === alarm;
          });
    usable.sort((a, b) => b.score - a.score);

    const answer = [];
    // An alarm code has a canonical definition, and that definition is the first
    // thing a technician needs. Find it structurally rather than hoping it wins
    // on term frequency.
    if (alarm !== null) {
      const definition = usable.find((c) =>
        new RegExp(`\\balarm\\s*${alarm}\\b`, 'i').test(c.text),
      );
      if (definition) answer.push(definition);
    }

    // Prefer a sentence that explains over one that merely mentions, but only as
    // a tiebreaker on relevance.
    const best = usable.find((c) => !answer.includes(c));
    const diagnosticLead = best
      ? usable.find(
          (c) => !answer.includes(c) && DIAGNOSTIC.test(c.text) && c.score >= 0.9 * best.score,
        )
      : undefined;
    const chosen = (diagnostic && diagnosticLead) || best;
    if (chosen) answer.push(chosen);

    // One supporting sentence only, and only when diagnosing. A specification or
    // maintenance question is answered by one precise sentence; adding "context"
    // to it is how tools start volunteering unrelated facts.
    if (diagnostic && answer.length < 2 && chosen) {
      const adjacent =
        chosen.nextText && chosen.nextText.length > 20
          ? { text: chosen.nextText, score: chosen.score, docId: chosen.docId, section: chosen.section }
          : null;
      // Staying inside the same manual reads more coherently, so same-document
      // alternatives are preferred when they are otherwise comparable.
      const alternates = usable
        .filter(
          (c) =>
            !answer.includes(c) &&
            c.section !== chosen.section &&
            DIAGNOSTIC.test(c.text) &&
            c.score >= 0.7 * chosen.score,
        )
        .sort(
          (a, b) =>
            Number(b.docId === chosen.docId) - Number(a.docId === chosen.docId) || b.score - a.score,
        );
      // A terse lead (typically a part reference) usually needs the sentence right
      // after it to answer the question. A full sentence does not, so if no
      // genuinely additive alternative exists, one sentence is the right answer.
      const support = chosen.text.length < 80 ? adjacent ?? alternates[0] : alternates[0];
      if (support) answer.push(support);
    }

    result.answer = answer.slice(0, 2).map(({ text, docId, section }) => ({ text, docId, section }));

    // Parts are only listed for the sections the answer cites, plus the parts used
    // in comparable tickets. Otherwise an answer about a gasket ends up quoting a
    // vacuum pump.
    const citedSections = new Set(result.answer.map((a) => a.section));
    const citedChunks = manualResults
      .filter((r) => citedSections.has(r.chunk.section))
      .map((r) => r.chunk);
    result.parts = collectParts(citedChunks, result.causes, corpus.parts);

    if (diagnostic) {
      // Second retrieval pass: once a cause is ranked, look up the procedure for
      // that component rather than continuing to match the original symptom. The
      // symptom "not holding vacuum" would otherwise never reach the seal-bar
      // procedure, because the two share almost no vocabulary.
      const causeContext = topCause
        ? search(index, buildQuery(`${topCause.detail} ${topCause.cause_class}`), {
            machine: effectiveMachine,
            type: 'manual',
            limit: 3,
          }).map((r) => r.chunk.text)
        : [];

      // The next step must come from evidence about the cause or the sections the
      // answer cites. Pulling it from anywhere in the context produces confident,
      // unrelated advice.
      const stepContext = [...causeContext, ...citedChunks.map((c) => c.text)];
      result.nextStep =
        (stepContext.length ? pickNextStep(stepContext, queryByTerm, alarm, causeTerms, rarity) : null) ??
        // No procedure in the corpus for this component: fall back to what
        // technicians actually did, which is verified by the ticket.
        (topCause ? `${topCause.action} (${topCause.tickets.join(', ')})` : null);
    }

    // Sources lead with the sections the answer actually cites, so the reference
    // list always explains the answer above it.
    const sourceList = [];
    for (const section of citedSections) {
      const match = manualResults.find((r) => r.chunk.section === section);
      if (match) sourceList.push(match);
    }
    for (const entry of scoped) {
      if (sourceList.length >= 3) break;
      if (!sourceList.includes(entry)) sourceList.push(entry);
    }
    for (const entry of primary) {
      if (sourceList.length >= 3) break;
      if (!sourceList.includes(entry)) sourceList.push(entry);
    }
    result.sources = sourceList.slice(0, 3).map((r, i) => ({
      ref: i + 1,
      docId: r.chunk.docId,
      title: r.chunk.title,
      section: r.chunk.section,
      score: Number(r.score.toFixed(2)),
    }));

    return result;
  }

  return { ask, corpus, machines };
}

export function render(result) {
  const lines = [];
  const header = [
    result.machine ?? 'machine not specified',
    result.alarm ? `alarm ${result.alarm}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  lines.push(`Q: ${result.question}`);
  lines.push(`   ${header} · confidence ${result.confidence} · coverage ${result.coverage}`);
  lines.push('');

  if (result.status === 'escalate') {
    lines.push('ESCALATE — not enough grounded evidence to answer safely');
    lines.push('');
    if (result.closest.length) {
      lines.push('Closest material found (below threshold, do not rely on it):');
      for (const c of result.closest) lines.push(`  - ${c.section} [${c.docId}] score ${c.score}`);
      lines.push('');
    }
    lines.push('Attach to the ticket:');
    lines.push('  - machine number and variant from the nameplate');
    lines.push('  - alarm log export for the last 24 h');
    lines.push('  - photo of the affected station');
    lines.push('  - film / tray specification currently running');
    return lines.join('\n');
  }

  lines.push('ANSWER');
  for (const sentence of result.answer) {
    lines.push(`  ${sentence.text} [${sentence.section}]`);
  }

  if (result.causes.length) {
    lines.push('');
    lines.push('LIKELY CAUSES (from service history)');
    for (const cause of result.causes) {
      lines.push(`  ${cause.count} of ${cause.of}: ${cause.detail}`);
      lines.push(`      tickets ${cause.tickets.join(', ')}`);
      lines.push(`      fix used: ${cause.action}`);
    }
  }

  if (result.parts.length) {
    lines.push('');
    lines.push('PARTS');
    for (const part of result.parts) {
      const stock = part.stock <= 2 ? `stock ${part.stock} — LOW` : `stock ${part.stock}`;
      lines.push(
        `  ${part.part_no}  ${part.description}  · ${stock} · €${part.price_eur.toFixed(2)}` +
          (part.from_history ? ' · seen in similar tickets' : ''),
      );
    }
  }

  if (result.nextStep) {
    lines.push('');
    lines.push('NEXT STEP');
    lines.push(`  ${result.nextStep}`);
  }

  lines.push('');
  lines.push('SOURCES');
  for (const source of result.sources) {
    lines.push(`  [${source.ref}] ${source.section} — ${source.title} (§${source.docId})`);
  }
  return lines.join('\n');
}
