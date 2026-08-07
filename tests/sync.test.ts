#!/usr/bin/env bun
/**
 * Integration check for the Granola sync.
 *
 * Serves the documented public-API schema from a local HTTP server, runs the
 * real sync.ts against a throwaway vault, and asserts on the files it produces.
 * No network access and no credentials required — GRANOLA_API_BASE points the
 * sync at the local mock.
 *
 * This exists because the Granola API has broken this tool before: the private
 * endpoints it originally used disappeared without warning and the sync failed
 * 71 times before anyone noticed. Run it after any change here, and after any
 * Granola release that touches the API.
 *
 * Run: bun test   (or: bun tests/sync.test.ts)
 */

import { mkdtemp, writeFile, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const PORT = 39847;

// --- Fixtures: shaped exactly per docs.granola.ai/api-reference ---

const NOTES = {
  // Page 1
  not_aaaaaaaaaaaaaa: {
    id: 'not_aaaaaaaaaaaaaa',
    object: 'note',
    title: 'Strategy Sync',
    owner: { name: 'Josh Roman', email: 'josh@omaihq.com' },
    created_at: '2026-08-07T14:30:00.000Z',
    updated_at: '2026-08-07T15:30:00.000Z',
    web_url: 'https://notes.granola.ai/d/not_aaaaaaaaaaaaaa',
    calendar_event: {
      event_title: 'Strategy Sync',
      organiser: 'josh@omaihq.com',
      scheduled_start_time: '2026-08-07T14:30:00.000Z',
      scheduled_end_time: '2026-08-07T15:15:00.000Z',
    },
    attendees: [
      { name: 'Josh Roman', email: 'josh@omaihq.com' },
      { name: 'Adrian Vance', email: 'adrian@omaihq.com' },
    ],
    summary_text: 'Discussed Q3 roadmap.',
    // H1/H2 as the API returns them — must be demoted to H3/H4 to match the vault
    summary_markdown: '# Key Points\n- Q3 roadmap locked\n## Detail\n- Hiring paused\n```\n# not a heading\n```',
    transcript: [
      { speaker: { source: 'microphone', attribution: 'me' }, text: 'How is the roadmap looking?', start_time: '2026-08-07T14:30:05.000Z', end_time: '2026-08-07T14:30:08.000Z' },
      { speaker: { source: 'speaker', attribution: 'them' }, text: 'Locked for Q3.', start_time: '2026-08-07T14:30:09.000Z', end_time: '2026-08-07T14:30:11.000Z' },
      { speaker: { source: 'microphone', attribution: 'me' }, text: 'Good, ship it.', start_time: '2026-08-07T14:30:12.000Z', end_time: '2026-08-07T14:30:14.000Z' },
      // Near-miss pair the old 0.68 fuzzy threshold would have collapsed —
      // distinct statements that must both survive.
      { speaker: { source: 'speaker', attribution: 'them', name: 'Adrian Vance' }, text: 'Nausea is here.', start_time: '2026-08-07T14:31:00.000Z', end_time: '2026-08-07T14:31:02.000Z' },
      { speaker: { source: 'speaker', attribution: 'them', name: 'Adrian Vance' }, text: 'Fatigue is here.', start_time: '2026-08-07T14:31:02.000Z', end_time: '2026-08-07T14:31:04.000Z' },
      // Paraphrase across speakers — the quoted original must not be deleted.
      { speaker: { source: 'microphone', attribution: 'me' }, text: 'So when you say we can figure that out.', start_time: '2026-08-07T14:31:05.000Z', end_time: '2026-08-07T14:31:07.000Z' },
      { speaker: { source: 'speaker', attribution: 'them', name: 'Adrian Vance' }, text: 'We can figure that out.', start_time: '2026-08-07T14:31:07.000Z', end_time: '2026-08-07T14:31:09.000Z' },
      // Byte-identical repeat from the same speaker — this one SHOULD collapse.
      { speaker: { source: 'speaker', attribution: 'them', name: 'Adrian Vance' }, text: 'Exactly right.', start_time: '2026-08-07T14:31:10.000Z', end_time: '2026-08-07T14:31:12.000Z' },
      { speaker: { source: 'speaker', attribution: 'them', name: 'Adrian Vance' }, text: 'Exactly right.', start_time: '2026-08-07T14:31:12.000Z', end_time: '2026-08-07T14:31:14.000Z' },
      // Identical text from two DIFFERENT named people — both must survive.
      // Placed late so the transcript spans a realistic >2 minutes and is not
      // caught by the short-meeting filter.
      { speaker: { source: 'speaker', attribution: 'them', name: 'Rita Geraghty' }, text: 'Okay.', start_time: '2026-08-07T14:35:00.000Z', end_time: '2026-08-07T14:35:01.000Z' },
      { speaker: { source: 'speaker', attribution: 'them', name: 'Bea L.' }, text: 'Okay.', start_time: '2026-08-07T14:35:01.000Z', end_time: '2026-08-07T14:35:02.000Z' },
    ],
  },

  // Solo meeting — only owner emails, must be skipped
  not_bbbbbbbbbbbbbb: {
    id: 'not_bbbbbbbbbbbbbb',
    object: 'note',
    title: 'Personal Braindump',
    owner: { name: 'Josh Roman', email: 'josh@omaihq.com' },
    created_at: '2026-08-07T09:00:00.000Z',
    updated_at: '2026-08-07T09:30:00.000Z',
    attendees: [{ name: 'Josh Roman', email: 'josh@omaihq.com' }],
    summary_text: 'Notes to self.',
    summary_markdown: '### Thoughts\n- Ship faster',
    transcript: [
      { speaker: { source: 'microphone', attribution: 'me' }, text: 'Note to self.', start_time: '2026-08-07T09:00:05.000Z', end_time: '2026-08-07T09:00:07.000Z' },
    ],
  },

  // Page 2 — collides with a legacy vault file by date+title (UUID id there)
  not_cccccccccccccc: {
    id: 'not_cccccccccccccc',
    object: 'note',
    title: 'GBA Weekly Debrief',
    owner: { name: 'Josh Roman', email: 'josh@omaihq.com' },
    created_at: '2026-08-06T13:02:44.819Z',
    updated_at: '2026-08-06T14:02:44.819Z',
    attendees: [
      { name: 'Josh Roman', email: 'josh@omaihq.com' },
      { name: 'jud brewer', email: 'jud.brewer@gmail.com' },
    ],
    summary_text: 'Weekly debrief.',
    summary_markdown: '### Recap\n- Went well',
    transcript: [
      { speaker: { source: 'speaker', attribution: 'them' }, text: 'Good week overall.', start_time: '2026-08-06T13:03:00.000Z', end_time: '2026-08-06T13:03:03.000Z' },
    ],
  },

  // Empty note — no transcript, no summary, must be skipped
  not_dddddddddddddd: {
    id: 'not_dddddddddddddd',
    object: 'note',
    title: 'Empty Placeholder',
    owner: { name: 'Josh Roman', email: 'josh@omaihq.com' },
    created_at: '2026-08-07T11:00:00.000Z',
    updated_at: '2026-08-07T11:00:00.000Z',
    attendees: [
      { name: 'Josh Roman', email: 'josh@omaihq.com' },
      { name: 'Sam Real', email: 'sam@example.com' },
    ],
    summary_text: '',
    summary_markdown: null,
    transcript: [],
  },
};

// Real meeting, real attendees, real summary — but the recording caught almost
// nothing. Must be skipped on transcript span, not written as a stub note.
(NOTES as any).not_eeeeeeeeeeeeee = {
  id: 'not_eeeeeeeeeeeeee',
  object: 'note',
  title: 'Barely Recorded Call',
  owner: { name: 'Josh Roman', email: 'josh@omaihq.com' },
  created_at: '2026-08-07T16:00:00.000Z',
  updated_at: '2026-08-07T16:05:00.000Z',
  attendees: [
    { name: 'Josh Roman', email: 'josh@omaihq.com' },
    { name: 'Sam Real', email: 'sam@example.com' },
  ],
  summary_text: 'Short call.',
  summary_markdown: '# Recap\n- Nothing captured',
  transcript: [
    { speaker: { source: 'microphone', attribution: 'me' }, text: 'Okay. Yeah.', start_time: '2026-08-07T16:00:01.000Z', end_time: '2026-08-07T16:00:01.400Z' },
  ],
};

const PAGES = [
  ['not_aaaaaaaaaaaaaa', 'not_bbbbbbbbbbbbbb'],
  ['not_cccccccccccccc', 'not_dddddddddddddd', 'not_eeeeeeeeeeeeee'],
];

function summaryOf(id: string) {
  const n = NOTES[id as keyof typeof NOTES];
  return { id: n.id, object: n.object, title: n.title, owner: n.owner, created_at: n.created_at, updated_at: n.updated_at };
}

let sawAuthHeader = '';
let transcriptIncludeRequests = 0;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    sawAuthHeader = req.headers.get('authorization') || '';

    if (url.pathname === '/v1/notes') {
      const cursor = url.searchParams.get('cursor');
      const pageIndex = cursor ? parseInt(cursor) : 0;
      const ids = PAGES[pageIndex] || [];
      return Response.json({
        notes: ids.map(summaryOf),
        hasMore: pageIndex < PAGES.length - 1,
        cursor: pageIndex < PAGES.length - 1 ? String(pageIndex + 1) : null,
      });
    }

    const match = url.pathname.match(/^\/v1\/notes\/(not_[a-zA-Z0-9]+)$/);
    if (match) {
      if (url.searchParams.get('include') === 'transcript') transcriptIncludeRequests++;
      const note = NOTES[match[1] as keyof typeof NOTES];
      if (!note) return new Response('Not found', { status: 404 });
      return Response.json(note);
    }

    return new Response('Not found', { status: 404 });
  },
});

// --- Build a throwaway vault containing one LEGACY (UUID-keyed) meeting ---

const vault = await mkdtemp(join(tmpdir(), 'granola-test-vault-'));

await writeFile(
  join(vault, '2026-08-06-Thu-GBA-Weekly-Debrief--b1dfb835.md'),
  `---
title: GBA Weekly Debrief
date: '2026-08-06'
day: Thu
attendees:
  - jud brewer <jud.brewer@gmail.com>
organizer: Josh Roman
start_time: '2026-08-06T13:02:44.819Z'
source: granola
source_id: b1dfb835-0b86-450d-859c-29a0a0e10693
status: filed
calendar_event_id: b1dfb835-0b86-450d-859c-29a0a0e10693
---
# GBA Weekly Debrief
`,
  'utf-8'
);

// --- Run the real sync against the mock ---

const result = await new Promise<{ code: number; out: string }>((resolve) => {
  const proc = spawn('bun', ['sync.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      GRANOLA_API_KEY: 'grn_test_key_123',
      GRANOLA_API_BASE: `http://localhost:${PORT}/v1`,
      OBSIDIAN_VAULT_MEETINGS_PATH: vault,
      OWNER_EMAILS: 'josh@omaihq.com,josh@mindshiftrecovery.org,joshroman@gmail.com',
      GRANOLA_MEETINGS_LIMIT: '10',
      SYNC_TRANSCRIPT: 'true',
      TRANSCRIPT_TITLE_FILTER: '',
      ENABLE_MEETING_PROCESSING: 'false',
      DRY_RUN: 'false',
      PUSHOVER_USER_KEY: '',
      PUSHOVER_API_TOKEN: '',
    },
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  proc.on('close', (code) => resolve({ code: code ?? 1, out }));
});

server.stop();

console.log('─'.repeat(60));
console.log(result.out.trim());
console.log('─'.repeat(60));

// --- Assertions ---

const files = (await readdir(vault)).filter((f) => f.endsWith('.md')).sort();
const checks: Array<[string, boolean, string]> = [];

const strategyFile = files.find((f) => f.includes('Strategy-Sync'));
checks.push(['exits 0', result.code === 0, `exit=${result.code}`]);
checks.push(['sends Bearer key', sawAuthHeader === 'Bearer grn_test_key_123', sawAuthHeader]);
checks.push(['follows cursor to page 2', result.out.includes('GBA Weekly Debrief'), 'page 2 note never seen']);
checks.push(['requests include=transcript', transcriptIncludeRequests > 0, `${transcriptIncludeRequests} calls`]);
checks.push(['writes new meeting', Boolean(strategyFile), files.join(', ')]);
checks.push(['skips solo meeting', !files.some((f) => f.includes('Personal-Braindump')), 'solo file written']);
checks.push(['skips empty note', !files.some((f) => f.includes('Empty-Placeholder')), 'empty file written']);
checks.push([
  'skips sub-2-minute transcript span',
  !files.some((f) => f.includes('Barely-Recorded-Call')),
  'short-span note written',
]);
checks.push([
  'dedups legacy UUID file by date+title',
  files.filter((f) => f.includes('GBA-Weekly-Debrief')).length === 1,
  `${files.filter((f) => f.includes('GBA-Weekly-Debrief')).length} copies`,
]);

if (strategyFile) {
  const body = await readFile(join(vault, strategyFile), 'utf-8');
  checks.push(['labels local speaker "Me:"', body.includes('Me:'), 'missing']);
  checks.push(['falls back to "Them:" when unnamed', body.includes('Them:'), 'missing (speaker->them mapping broken)']);
  checks.push(['no Unknown speakers', !body.includes('Unknown:'), 'attribution not mapped']);
  checks.push(['uses real speaker name', body.includes('Adrian Vance:'), 'name not used as label']);
  checks.push(['names verbatim, not merged', body.includes('Rita Geraghty:') && body.includes('Bea L.:'), 'names altered or merged']);
  checks.push([
    'keeps identical text from two different people',
    (body.match(/^Okay\.$/gm) || []).length === 2,
    `${(body.match(/^Okay\.$/gm) || []).length} survived, expected 2`,
  ]);
  checks.push(['embeds summary_markdown', body.includes('Key Points'), 'summary missing']);
  checks.push(['demotes summary H1 to H3', body.includes('### Key Points'), 'H1 not demoted']);
  checks.push(['preserves relative depth (H2→H4)', body.includes('#### Detail'), 'depth not preserved']);
  // Count H1s outside fenced code blocks (the fixture deliberately hides one in a fence)
  const outsideFences = body.replace(/```[\s\S]*?```/g, '');
  const h1Count = (outsideFences.match(/^# /gm) || []).length;
  checks.push(['only the title is H1', h1Count === 1, `${h1Count} H1s`]);
  checks.push(['leaves fenced code untouched', body.includes('\n# not a heading'), 'code fence mangled']);
  checks.push(['uses web_url for transcript_url', body.includes('notes.granola.ai/d/not_aaaaaaaaaaaaaa'), 'web_url not used']);
  checks.push(['computes duration from calendar_event', /duration_min:\s*45/.test(body), 'duration wrong']);
  checks.push(['keeps source_id as note id', body.includes('source_id: not_aaaaaaaaaaaaaa'), 'id missing']);

  // Dedup safety — distinct content must survive, identical repeats must not
  checks.push(['keeps "Nausea is here."', body.includes('Nausea is here.'), 'fuzzy dedup deleted it']);
  checks.push(['keeps "Fatigue is here."', body.includes('Fatigue is here.'), 'fuzzy dedup deleted it']);
  checks.push(['keeps paraphrased original', body.includes('We can figure that out.'), 'paraphrase deleted the original']);
  checks.push([
    'collapses identical same-speaker repeat',
    (body.match(/Exactly right\./g) || []).length === 1,
    `${(body.match(/Exactly right\./g) || []).length} copies`,
  ]);
}

console.log('\nRESULTS\n');
let failed = 0;
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? '✅' : '❌'} ${name}${pass ? '' : `  → ${detail}`}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed\n`);

await rm(vault, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
