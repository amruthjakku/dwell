#!/usr/bin/env node
import fs from 'node:fs';
import { createEngine } from '../src/answer.js';

const MIN_RETRIEVAL = 0.8;
const MIN_ABSTAIN = 1.0;

const golden = JSON.parse(fs.readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
const engine = createEngine();

const rows = [];
for (const item of golden) {
  const result = engine.ask(item.question);
  const cited = result.sources.map((s) => s.docId);
  const answerDocs = [...new Set(result.answer.map((a) => a.docId))];
  const answered = result.status === 'answered';
  const hit = item.kind === 'answer' ? cited.some((doc) => item.expect.includes(doc)) : null;
  // Precision is measured on the documents the answer text actually relies on,
  // not the wider evidence trail listed under SOURCES.
  const precision =
    item.kind === 'answer' && answerDocs.length
      ? answerDocs.filter((doc) => item.expect.includes(doc)).length / answerDocs.length
      : null;
  const correct = item.kind === 'answer' ? Boolean(hit) : !answered;

  rows.push({ item, result, cited, answered, hit, precision, correct });
}

const answerCases = rows.filter((r) => r.item.kind === 'answer');
const abstainCases = rows.filter((r) => r.item.kind === 'abstain');
const retrievalRate = answerCases.filter((r) => r.hit).length / answerCases.length;
const abstainRate = abstainCases.filter((r) => r.correct).length / abstainCases.length;
const meanPrecision =
  answerCases.reduce((sum, r) => sum + (r.precision ?? 0), 0) / answerCases.length;

console.log('case  kind     status    conf   cov   hit  prec  question');
console.log('-'.repeat(110));
for (const row of rows) {
  console.log(
    [
      row.item.id.padEnd(5),
      row.item.kind.padEnd(8),
      row.result.status.padEnd(9),
      String(row.result.confidence).padEnd(6),
      String(row.result.coverage).padEnd(5),
      (row.hit === null ? '-' : row.hit ? 'yes' : 'NO').padEnd(4),
      (row.precision === null ? '-' : row.precision.toFixed(2)).padEnd(5),
      row.item.question.slice(0, 60),
    ].join(' '),
  );
}

console.log('');
console.log(`retrieval hit rate   ${(retrievalRate * 100).toFixed(0)}%  (${answerCases.filter((r) => r.hit).length}/${answerCases.length})`);
console.log(`citation precision   ${(meanPrecision * 100).toFixed(0)}%`);
console.log(`abstention accuracy  ${(abstainRate * 100).toFixed(0)}%  (${abstainCases.filter((r) => r.correct).length}/${abstainCases.length})`);

const failures = rows.filter((r) => !r.correct);
if (failures.length) {
  console.log('');
  console.log('FAILURES');
  for (const failure of failures) {
    console.log(`  ${failure.item.id} [${failure.item.kind}] ${failure.item.note}`);
    console.log(`    question: ${failure.item.question}`);
    if (failure.item.kind === 'answer') {
      console.log(`    expected: ${failure.item.expect.join(', ')}`);
      console.log(`    cited:    ${failure.cited.join(', ') || '(none)'}`);
    } else {
      console.log(`    answered instead, citing: ${failure.cited.join(', ') || '(none)'}`);
    }
  }
}

const ok = retrievalRate >= MIN_RETRIEVAL && abstainRate >= MIN_ABSTAIN;
console.log('');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
