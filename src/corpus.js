import fs from 'node:fs';
import path from 'node:path';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function splitFrontMatter(raw) {
  const match = raw.match(FRONT_MATTER);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/**
 * Loads the pilot corpus: markdown documents chunked by `##` heading, plus
 * structured service tickets and the parts catalogue.
 */
export function loadCorpus(root = 'data') {
  const corpusDir = path.join(root, 'corpus');
  const chunks = [];

  for (const file of fs.readdirSync(corpusDir).filter((f) => f.endsWith('.md')).sort()) {
    const raw = fs.readFileSync(path.join(corpusDir, file), 'utf8');
    const { meta, body } = splitFrontMatter(raw);
    const docId = meta.id ?? path.basename(file, '.md');
    const title = meta.title ?? docId;
    const machine = meta.machine ?? 'all';
    const type = meta.type ?? 'manual';

    const sections = body.split(/^## /m);
    const intro = sections.shift()?.trim();
    if (intro) {
      chunks.push({ id: `${docId}#intro`, docId, title, section: 'Introduction', machine, type, text: intro });
    }
    for (const section of sections) {
      const newline = section.indexOf('\n');
      const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
      const text = newline === -1 ? '' : section.slice(newline + 1).trim();
      if (!text) continue;
      chunks.push({
        id: `${docId}#${slug(heading)}`,
        docId,
        title,
        section: heading,
        machine,
        type,
        text,
      });
    }
  }

  const ticketsPath = path.join(root, 'tickets.jsonl');
  const tickets = fs.existsSync(ticketsPath)
    ? fs
        .readFileSync(ticketsPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];

  for (const ticket of tickets) {
    chunks.push({
      id: `ticket:${ticket.id}`,
      docId: `ticket:${ticket.id}`,
      title: `Service ticket ${ticket.id} (${ticket.date})`,
      section: `${ticket.machine}, alarm ${ticket.alarm}`,
      machine: ticket.machine,
      type: 'ticket',
      ticket,
      text: `${ticket.symptom}. Cause: ${ticket.resolution_cause}. Action: ${ticket.resolution_action}.`,
    });
  }

  const partsPath = path.join(root, 'parts.json');
  const parts = fs.existsSync(partsPath) ? JSON.parse(fs.readFileSync(partsPath, 'utf8')) : [];

  return { chunks, tickets, parts };
}

export function machineList(corpus) {
  const machines = new Set();
  for (const chunk of corpus.chunks) {
    if (chunk.machine && chunk.machine !== 'all') machines.add(chunk.machine);
  }
  return [...machines].sort();
}

/** Finds the machine model named in a free-text question, if any. */
export function detectMachine(query, machines) {
  for (const machine of machines) {
    const pattern = machine
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s-]?');
    if (new RegExp(`\\b${pattern}\\b`, 'i').test(query)) return machine;
  }
  return null;
}

export function detectAlarm(query) {
  const explicit = query.match(/\b(?:alarm|alarms|error|fehler|code|fault)\s*#?\s*(\d{1,3})\b/i);
  if (explicit) return Number(explicit[1]);
  const bare = query.match(/\b(2\d|3\d|4\d|5\d|6\d|7\d)\b/);
  return bare ? Number(bare[1]) : null;
}
