#!/usr/bin/env bun
/**
 * granola — query Granola meetings from the command line.
 *
 * Two query modes, because they cost very different things:
 *
 *   meetings  Select by title/date. Titles come back in the list response, so
 *             this needs no per-note fetches to filter — finding 10 matches
 *             among 300 meetings is ~10 requests, a few seconds.
 *
 *   search    Select by content. The API has no search endpoint, so summaries
 *             must be fetched per note and matched locally. A summary cache
 *             makes repeat searches instant; the first run over a wide window
 *             is slow.
 *
 * Transcripts are opt-in on both, since they run ~40k characters each and
 * dominate output size.
 */

import './env';
import { resolvePath } from './env';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  listNotes, getNotes, getNote,
  type Note, type NoteSummary,
} from './granola-api';
import { processTranscript } from './transcript-processor';

const CACHE_PATH = resolvePath(
  process.env.GRANOLA_CACHE_PATH || join(import.meta.dir, '.cache', 'summaries.json')
);

const easternDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const easternDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' });

// ---------- summary cache ----------
// Only summaries and metadata. Transcripts are deliberately excluded: they are
// ~10x larger and are only ever wanted for a handful of notes at a time.

interface CachedNote {
  id: string;
  title: string;
  created_at: string;
  attendees: string[];
  /** Distinct names Granola diarized in the transcript. Group calls routinely
   *  have a dozen speakers and only two or three calendar invitees, so this is
   *  the only usable record of who was actually in the room. */
  speakers: string[];
  summary: string;
}

// Bumped when CachedNote gains a field, so stale caches rebuild instead of
// silently answering with data they never indexed.
const CACHE_VERSION = 2;

async function loadCache(): Promise<Map<string, CachedNote>> {
  if (!existsSync(CACHE_PATH)) return new Map();
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
    if (raw.version !== CACHE_VERSION) return new Map();
    return new Map((raw.notes || []).map((n: CachedNote) => [n.id, n]));
  } catch {
    return new Map();
  }
}

async function saveCache(cache: Map<string, CachedNote>): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  const notes = [...cache.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  await writeFile(CACHE_PATH, JSON.stringify({ version: CACHE_VERSION, notes }, null, 0), 'utf-8');
}

function toCached(note: Note): CachedNote {
  const speakers = new Set<string>();
  for (const seg of note.transcript || []) {
    const name = seg.speaker?.name?.trim();
    if (name) speakers.add(name);
  }

  return {
    id: note.id,
    title: note.title || 'Untitled',
    created_at: note.created_at,
    attendees: (note.attendees || []).map(a => a.name || a.email).filter(Boolean),
    speakers: [...speakers],
    // Transcript text is deliberately not stored — it is ~10x the summary and
    // is only ever wanted for a handful of notes, fetched on demand.
    summary: (note.summary_markdown || note.summary_text || '').trim(),
  };
}

// ---------- output ----------

function renderNote(note: Note, opts: { transcript: boolean }): string {
  const out: string[] = [];
  const when = note.calendar_event?.scheduled_start_time || note.created_at;
  const attendees = (note.attendees || []).map(a => a.name || a.email).filter(Boolean);

  out.push(`## ${note.title || 'Untitled'}`);
  out.push(`- **When:** ${easternDateTime(when)} ET`);
  if (attendees.length) out.push(`- **Attendees:** ${attendees.join(', ')}`);
  if (note.web_url) out.push(`- **Link:** ${note.web_url}`);
  out.push(`- **Note ID:** \`${note.id}\``);
  out.push('');

  const summary = (note.summary_markdown || note.summary_text || '').trim();
  if (summary) {
    out.push('### Summary');
    out.push(summary);
    out.push('');
  }

  if (opts.transcript) {
    const body = processTranscript(note.transcript);
    if (body) {
      out.push('### Transcript');
      out.push(body);
      out.push('');
    } else {
      out.push('_No transcript available._');
      out.push('');
    }
  }

  return out.join('\n');
}

// ---------- commands ----------

function titleMatcher(patterns: string[]): (n: NoteSummary) => boolean {
  const needles = patterns.map(p => p.toLowerCase());
  return (n: NoteSummary) => {
    const t = (n.title || '').toLowerCase();
    return needles.every(p => t.includes(p));
  };
}

async function cmdMeetings(args: Args): Promise<void> {
  const title = args.values.title;
  const limit = Number(args.values.last ?? 10);

  const notes = await listNotes({
    limit,
    since: args.values.since,
    until: args.values.until,
    maxScan: Number(args.values['max-scan'] ?? 1000),
    filter: title ? titleMatcher([title]) : undefined,
    onProgress: (scanned, matched) =>
      process.stderr.write(`\r  scanning… ${scanned} examined, ${matched} matched`),
  });
  process.stderr.write('\n');

  if (notes.length === 0) {
    console.log(title ? `No meetings matched title "${title}".` : 'No meetings found.');
    return;
  }

  const wantTranscript = Boolean(args.values.transcripts);
  const full = await getNotes(
    notes.map(n => n.id),
    wantTranscript,
    (done, total) => process.stderr.write(`\r  fetching… ${done}/${total}`)
  );
  process.stderr.write('\n');

  emit(full, wantTranscript, args, {
    heading: title
      ? `${full.length} most recent meetings matching "${title}"`
      : `${full.length} most recent meetings`,
  });
}

async function cmdSearch(args: Args): Promise<void> {
  const term = args.positionals[0];
  if (!term) throw new Error('search requires a term: granola search "pricing"');

  const scan = Number(args.values.scan ?? 150);
  const needle = term.toLowerCase();

  const cache: Map<string, CachedNote> =
    args.values['no-cache'] ? new Map() : await loadCache();

  // Which of the most recent `scan` notes are missing from the cache?
  const recent = await listNotes({
    limit: scan,
    since: args.values.since,
    until: args.values.until,
    maxScan: scan,
  });
  const missing = recent.filter(n => !cache.has(n.id));

  if (missing.length) {
    process.stderr.write(`  ${missing.length} of ${recent.length} not cached, indexing…\n`);
    // Fetched with transcripts so speaker names can be indexed; the transcript
    // text itself is discarded by toCached rather than stored.
    const fetched = await getNotes(
      missing.map(n => n.id),
      true,
      (done, total) => process.stderr.write(`\r  indexing… ${done}/${total}`)
    );
    process.stderr.write('\n');
    for (const n of fetched) cache.set(n.id, toCached(n));
    if (!args.values['no-cache']) await saveCache(cache);
  }

  const inScope = new Set(recent.map(n => n.id));
  const hits = [...cache.values()]
    .filter(n => inScope.has(n.id))
    .filter(n =>
      n.title.toLowerCase().includes(needle) ||
      n.summary.toLowerCase().includes(needle) ||
      n.attendees.some(a => a.toLowerCase().includes(needle)) ||
      n.speakers.some(s => s.toLowerCase().includes(needle))
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (hits.length === 0) {
    console.log(`No matches for "${term}" in the last ${recent.length} meetings.`);
    return;
  }

  const limit = Number(args.values.last ?? hits.length);
  const selected = hits.slice(0, limit);

  // Stage two: only now pay for the expensive fetch, and only for matches.
  const wantTranscript = Boolean(args.values.transcripts);
  if (!wantTranscript) {
    const lines = [`# ${selected.length} meetings matching "${term}"`, ''];
    lines.push(`_Searched the last ${recent.length} meetings. ${hits.length} matched._`, '');
    for (const n of selected) {
      lines.push(`## ${n.title}`);
      lines.push(`- **When:** ${easternDate(n.created_at)}`);
      if (n.attendees.length) lines.push(`- **Attendees:** ${n.attendees.join(', ')}`);
      lines.push(`- **Note ID:** \`${n.id}\``);
      lines.push('');
      if (n.summary) { lines.push('### Summary', n.summary, ''); }
    }
    await output(lines.join('\n'), args);
    return;
  }

  const full = await getNotes(
    selected.map(n => n.id),
    true,
    (done, total) => process.stderr.write(`\r  fetching transcripts… ${done}/${total}`)
  );
  process.stderr.write('\n');

  emit(full, true, args, {
    heading: `${full.length} meetings matching "${term}"`,
    note: `Searched the last ${recent.length} meetings. ${hits.length} matched.`,
  });
}

async function cmdGet(args: Args): Promise<void> {
  const id = args.positionals[0];
  if (!id) throw new Error('get requires a note id: granola get not_xxx');
  const note = await getNote(id, args.values.transcripts !== false);
  emit([note], true, args, { heading: note.title || 'Untitled' });
}

async function cmdRefresh(args: Args): Promise<void> {
  const scan = Number(args.values.scan ?? 300);
  const cache = await loadCache();
  const recent = await listNotes({ limit: scan, maxScan: scan });
  const missing = recent.filter(n => !cache.has(n.id));

  if (!missing.length) {
    console.log(`Cache is current — all ${recent.length} recent meetings present (${cache.size} total).`);
    return;
  }

  const fetched = await getNotes(
    missing.map(n => n.id),
    true,
    (done, total) => process.stderr.write(`\r  indexing… ${done}/${total}`)
  );
  process.stderr.write('\n');
  for (const n of fetched) cache.set(n.id, toCached(n));
  await saveCache(cache);
  console.log(`Cached ${missing.length} new meetings. ${cache.size} total at ${CACHE_PATH}`);
}

// ---------- plumbing ----------

interface Args { values: Record<string, any>; positionals: string[]; }

function emit(
  notes: Note[],
  transcript: boolean,
  args: Args,
  meta: { heading: string; note?: string }
): Promise<void> {
  const lines = [`# ${meta.heading}`, ''];
  if (meta.note) lines.push(`_${meta.note}_`, '');
  for (const n of notes) lines.push(renderNote(n, { transcript }));
  return output(lines.join('\n'), args);
}

async function output(text: string, args: Args): Promise<void> {
  if (args.values.out) {
    await writeFile(resolvePath(args.values.out), text, 'utf-8');
    const kb = (text.length / 1024).toFixed(0);
    console.log(`Wrote ${kb}KB to ${args.values.out}`);
  } else {
    console.log(text);
  }
}

function parseArgs(argv: string[]): { command: string } & Args {
  const values: Record<string, any> = {};
  const positionals: string[] = [];
  const command = argv[0] || 'help';

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { values[key] = next; i++; }
      else values[key] = true;
    } else positionals.push(a);
  }
  return { command, values, positionals };
}

const HELP = `granola — query Granola meetings

  granola meetings [--title TEXT] [--last N] [--transcripts] [--since D] [--until D]
      Select meetings by title and date. Filtering happens on the list
      response, so this is fast even when scanning hundreds of meetings.

      granola meetings --title "Mindshift Team" --last 10 --transcripts

  granola search TERM [--scan N] [--last N] [--transcripts] [--no-cache]
      Search titles, attendees and summaries for TERM. Examines the last
      --scan meetings (default 150) and caches summaries so repeat searches
      are instant. Add --transcripts to pull full transcripts for matches.

      granola search "pricing"
      granola search "Rita Geraghty" --transcripts

  granola get NOTE_ID
      One meeting, with transcript.

  granola refresh [--scan N]
      Warm the summary cache (default 300 most recent).

Options
  --out PATH     write to a file instead of stdout
  --transcripts  include full transcripts (~40k chars per meeting)

Notes
  The API has no search endpoint. 'meetings' filters on data already in the
  list response and is cheap; 'search' must fetch each summary, which is why
  it caches. Transcripts are always opt-in.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'meetings': return cmdMeetings(args);
    case 'search':   return cmdSearch(args);
    case 'get':      return cmdGet(args);
    case 'refresh':  return cmdRefresh(args);
    default:         console.log(HELP);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
