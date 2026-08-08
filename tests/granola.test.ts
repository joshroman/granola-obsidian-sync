#!/usr/bin/env bun
/**
 * Integration check for the granola query CLI.
 *
 * Serves the documented public-API schema from a local HTTP server and runs the
 * real CLI against it, asserting on stdout. Needs no network and no API key.
 *
 * Covers the two query modes and the cost properties that justify them:
 * title selection paging past non-matches without per-note fetches, content
 * search matching summaries and diarized speakers, and transcripts staying
 * opt-in.
 *
 * Run: bun tests/granola.test.ts
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const PORT = 39851;

// 70 notes: a recurring "Mindshift Team Meeting" every 7th, noise between.
const NOTES: Record<string, any> = {};
const ORDER: string[] = [];

for (let i = 0; i < 70; i++) {
  const id = `not_${String(i).padStart(14, '0')}`;
  const isTeam = i % 7 === 0;
  const day = String(28 - Math.floor(i / 3)).padStart(2, '0');
  NOTES[id] = {
    id,
    title: isTeam ? 'Mindshift Team Meeting' : `Random Sync ${i}`,
    owner: { name: 'Josh Roman', email: 'josh@omaihq.com' },
    created_at: `2026-06-${day}T15:00:00.000Z`,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: {
      scheduled_start_time: `2026-06-${day}T15:00:00.000Z`,
      scheduled_end_time: `2026-06-${day}T16:00:00.000Z`,
    },
    attendees: [
      { name: 'Josh Roman', email: 'josh@omaihq.com' },
      { name: 'Andrea Reggio', email: 'andrea@example.org' },
    ],
    summary_text: isTeam ? 'Team sync.' : 'Other topics.',
    summary_markdown: isTeam
      ? '# Recap\n- Budget discussed\n- Grant timeline reviewed'
      : '# Recap\n- Unrelated matters',
    transcript: [
      {
        speaker: { source: 'microphone', attribution: 'me' },
        text: isTeam ? 'How is the budget looking?' : 'Unrelated opener.',
        start_time: `2026-06-${day}T15:00:05.000Z`,
        end_time: `2026-06-${day}T15:00:08.000Z`,
      },
      {
        // A diarized speaker who is NOT a calendar attendee — the case that
        // makes attendee-only name search useless for group calls.
        speaker: { source: 'speaker', attribution: 'them', name: isTeam ? 'Rita Geraghty' : 'Someone Else' },
        text: isTeam ? 'Budget is on track.' : 'Nothing to report.',
        start_time: `2026-06-${day}T15:10:00.000Z`,
        end_time: `2026-06-${day}T15:10:04.000Z`,
      },
    ],
  };
  ORDER.push(id);
}

let detailFetches = 0;
let transcriptFetches = 0;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/v1/notes') {
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? parseInt(cursor) : 0;
      const size = Math.min(30, parseInt(url.searchParams.get('page_size') || '30'));
      const slice = ORDER.slice(start, start + size);
      const next = start + size;
      return Response.json({
        notes: slice.map(id => {
          const n = NOTES[id];
          return { id: n.id, title: n.title, owner: n.owner, created_at: n.created_at };
        }),
        hasMore: next < ORDER.length,
        cursor: next < ORDER.length ? String(next) : null,
      });
    }

    const m = url.pathname.match(/^\/v1\/notes\/(not_[a-zA-Z0-9]+)$/);
    if (m) {
      detailFetches++;
      const withTranscript = url.searchParams.get('include') === 'transcript';
      if (withTranscript) transcriptFetches++;
      const note = NOTES[m[1]];
      if (!note) return new Response('Not found', { status: 404 });
      return Response.json(withTranscript ? note : { ...note, transcript: null });
    }

    return new Response('Not found', { status: 404 });
  },
});

const cacheDir = await mkdtemp(join(tmpdir(), 'granola-cli-test-'));

function run(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const proc = spawn('bun', ['granola.ts', ...args], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        GRANOLA_API_KEY: 'grn_test_key',
        GRANOLA_API_BASE: `http://localhost:${PORT}/v1`,
        GRANOLA_CACHE_PATH: join(cacheDir, 'summaries.json'),
      },
    });
    let stdout = '';
    proc.stdout.on('data', d => (stdout += d));
    proc.on('close', code => resolve({ code: code ?? 1, stdout }));
  });
}

const checks: Array<[string, boolean, string]> = [];
const count = (s: string, re: RegExp) => (s.match(re) || []).length;

// --- title selection, paging past non-matches ---
detailFetches = 0;
const team = await run(['meetings', '--title', 'Mindshift Team', '--last', '5']);
checks.push(['meetings: exits 0', team.code === 0, `exit ${team.code}`]);
checks.push([
  'meetings: finds 5 matches across pages',
  count(team.stdout, /^## Mindshift Team Meeting$/gm) === 5,
  `${count(team.stdout, /^## Mindshift Team Meeting$/gm)} found`,
]);
checks.push([
  'meetings: excludes non-matching titles',
  !team.stdout.includes('Random Sync'),
  'non-matching title leaked in',
]);
checks.push([
  'meetings: title filter costs no extra detail fetches',
  detailFetches === 5,
  `${detailFetches} detail fetches for 5 results`,
]);
checks.push([
  'meetings: omits transcripts by default',
  !team.stdout.includes('### Transcript'),
  'transcript included without --transcripts',
]);

// --- transcripts opt-in ---
transcriptFetches = 0;
const withTr = await run(['meetings', '--title', 'Mindshift Team', '--last', '3', '--transcripts']);
checks.push([
  'meetings: --transcripts includes transcript',
  withTr.stdout.includes('### Transcript'),
  'no transcript section',
]);
checks.push([
  'meetings: --transcripts requests include=transcript',
  transcriptFetches === 3,
  `${transcriptFetches} transcript fetches`,
]);
checks.push([
  'meetings: transcript uses diarized speaker names',
  withTr.stdout.includes('Rita Geraghty:'),
  'speaker name missing from transcript',
]);

// --- content search over summaries ---
const budget = await run(['search', 'budget', '--scan', '40']);
checks.push(['search: exits 0', budget.code === 0, `exit ${budget.code}`]);
checks.push([
  'search: matches summary text',
  budget.stdout.includes('Mindshift Team Meeting'),
  'summary match missed',
]);
checks.push([
  'search: excludes non-matching meetings',
  !budget.stdout.includes('Random Sync'),
  'non-matching meeting returned',
]);
checks.push([
  'search: omits transcripts by default',
  !budget.stdout.includes('### Transcript'),
  'transcript included without --transcripts',
]);

// --- the case attendee-only search gets wrong ---
const byName = await run(['search', 'Rita Geraghty', '--scan', '40']);
checks.push([
  'search: finds a diarized speaker who is not a calendar attendee',
  byName.stdout.includes('Mindshift Team Meeting'),
  'speaker-name search found nothing',
]);

// --- cache ---
detailFetches = 0;
const warm = await run(['search', 'budget', '--scan', '40']);
checks.push([
  'search: warm cache issues no detail fetches',
  detailFetches === 0,
  `${detailFetches} detail fetches on a warm cache`,
]);
checks.push([
  'search: warm result matches cold result',
  count(warm.stdout, /^## /gm) === count(budget.stdout, /^## /gm),
  'warm and cold results differ',
]);

server.stop();
await rm(cacheDir, { recursive: true, force: true });

console.log('\nRESULTS\n');
let failed = 0;
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? '✅' : '❌'} ${name}${pass ? '' : `  → ${detail}`}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed\n`);
process.exit(failed === 0 ? 0 : 1);
