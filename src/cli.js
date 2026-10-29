#!/usr/bin/env node
import { createEngine, render } from './answer.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const verbose = args.includes('--debug');
const question = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();

if (!question) {
  console.error('Usage: npm run ask "<symptom, machine and alarm>" [--json] [--debug]');
  process.exit(1);
}

const engine = createEngine();
const result = engine.ask(question);

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(render(result));
  if (verbose) {
    console.log('');
    console.log('DEBUG');
    console.log(`  corpus: ${engine.corpus.chunks.length} chunks, ${engine.corpus.tickets.length} tickets`);
    console.log(`  candidate score: ${result.topScore}`);
  }
}

process.exit(result.status === 'answered' ? 0 : 2);
