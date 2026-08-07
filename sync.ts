#!/usr/bin/env bun

import 'dotenv/config';
import dotenv from 'dotenv';
import { readFile, writeFile, mkdir, access, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import { processTranscript, shouldSkipPastMeeting } from './transcript-processor';

// --- CONFIGURATION ---
// All user-configurable values are sourced from environment variables.
// See .env.example for details.

// Helper to resolve tilde (~) in paths
const resolvePath = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// Shared secrets live alongside the other automation credentials. The local .env
// is loaded first and wins; this only fills in what it does not define.
const SHARED_ENV_PATH = resolvePath(
  process.env.JOSH_AUTOMATIONS_ENV || '~/.config/josh-automations/.env'
);
if (existsSync(SHARED_ENV_PATH)) {
  dotenv.config({ path: SHARED_ENV_PATH });
}

const requiredEnvVars = [
  'GRANOLA_API_KEY',
  'OBSIDIAN_VAULT_MEETINGS_PATH',
];

// Validate required environment variables
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}. Please copy .env.example to .env and set this value.`);
  }
}

const config = {
  granolaApiKey: process.env.GRANOLA_API_KEY!,
  obsidianVaultPath: resolvePath(process.env.OBSIDIAN_VAULT_MEETINGS_PATH!),
  meetingsLimit: parseInt(process.env.GRANOLA_MEETINGS_LIMIT || '50'),
  // DRY_RUN=true reports what would be written without touching the vault
  dryRun: process.env.DRY_RUN === 'true',
  syncTranscript: process.env.SYNC_TRANSCRIPT === 'true',
  transcriptTitleFilter: process.env.TRANSCRIPT_TITLE_FILTER?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) || [],
  // Meeting processing config
  enableMeetingProcessing: process.env.ENABLE_MEETING_PROCESSING === 'true',
  vaultOpsScriptPath: process.env.VAULT_OPS_SCRIPT_PATH,
  // Pushover config for future use
  pushover: {
    userKey: process.env.PUSHOVER_USER_KEY,
    apiToken: process.env.PUSHOVER_API_TOKEN,
  },
};

// Check external script exists if processing is enabled (log but don't fail)
if (config.enableMeetingProcessing) {
  if (!config.vaultOpsScriptPath || !existsSync(config.vaultOpsScriptPath)) {
    console.log(`⚠️  External script not found: ${config.vaultOpsScriptPath}. Meeting processing will be skipped.`);
  }
}

// --- END CONFIGURATION ---

// Official Granola public API (https://docs.granola.ai/introduction)
// Auth is a static `grn_` key from Granola → Settings → Connectors → API keys.
// GRANOLA_API_BASE exists so the sync can be pointed at a local mock in tests.
const API_BASE = process.env.GRANOLA_API_BASE || 'https://public-api.granola.ai/v1';
const VAULT_PATH = config.obsidianVaultPath;

// API limits: 30 notes/page max, 5 req/sec sustained (300/min), 25 burst per 5s.
const PAGE_SIZE = 30;
const REQUEST_INTERVAL_MS = 250; // ~4 req/sec, comfortably under the sustained limit

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// TYPES — mirror the documented public API schema
interface NoteSummary {
  id: string;
  object: 'note';
  title: string | null;
  owner?: { name: string | null; email: string };
  created_at: string;
  updated_at: string;
}

interface TranscriptSegmentApi {
  speaker?: {
    source?: 'microphone' | 'speaker';
    attribution?: 'me' | 'them';
    diarization_label?: string;
    name?: string;
  };
  text: string;
  start_time?: string;
  end_time?: string;
}

interface Note extends NoteSummary {
  web_url?: string;
  calendar_event?: {
    event_title?: string | null;
    invitees?: Array<{ email: string }>;
    organiser?: string | null;
    calendar_event_id?: string | null;
    scheduled_start_time?: string | null;
    scheduled_end_time?: string | null;
  };
  attendees?: Array<{ name: string | null; email: string }>;
  summary_text?: string;
  summary_markdown?: string | null;
  transcript?: TranscriptSegmentApi[] | null;
}

// AUTHENTICATED REQUEST HELPER
async function apiGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${config.granolaApiKey}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText} ${body}`.trim());
  }

  return await response.json();
}

// LIST NOTES - cursor-paginated, newest first
async function listNotes(limit: number): Promise<NoteSummary[]> {
  const notes: NoteSummary[] = [];
  let cursor: string | null = null;

  while (notes.length < limit) {
    const params: Record<string, string> = {
      page_size: String(Math.min(PAGE_SIZE, limit - notes.length))
    };
    if (cursor) params.cursor = cursor;

    const page = await apiGet('/notes', params);
    const batch: NoteSummary[] = page.notes || [];
    notes.push(...batch);

    if (!page.hasMore || !page.cursor || batch.length === 0) break;
    cursor = page.cursor;
    await sleep(REQUEST_INTERVAL_MS);
  }

  return notes.slice(0, limit);
}

// Wall-clock minutes covered by a transcript, or undefined when it can't be
// determined. Undefined rather than 0 so callers can tell "no data" apart from
// "genuinely instantaneous" and skip the length check instead of guessing.
function transcriptSpanMinutes(segments: TranscriptSegmentApi[] | null | undefined): number | undefined {
  if (!segments || segments.length === 0) return undefined;

  const stamps = segments
    .flatMap(s => [s.start_time, s.end_time])
    .filter((v): v is string => Boolean(v))
    .map(v => new Date(v).getTime())
    .filter(n => !isNaN(n));

  if (stamps.length < 2) return undefined;
  // Deliberately not rounded: a 25-second recording must stay below the
  // short-meeting threshold rather than rounding down to a falsy 0.
  return (Math.max(...stamps) - Math.min(...stamps)) / 60000;
}

// GET SINGLE NOTE - includes attendees, summary and (optionally) transcript
async function getNote(id: string, includeTranscript: boolean): Promise<Note> {
  return await apiGet(`/notes/${id}`, includeTranscript ? { include: 'transcript' } : {});
}

// UNIFIED MEETING DATA
interface MeetingData {
  id: string;
  title: string;
  startTime: Date;
  endTime?: Date;
  attendees: string[];
  organizer: string;
  location: string;
  status: 'filed' | 'scheduled';
  transcript?: string;
  meetingUrl?: string;
  durationMin?: number;
  panelContent?: string;
  tags?: string[];
  webUrl?: string;
}

// VAULT INDEX
interface ExistingMeeting {
  filePath: string;
  title: string;
  startTime: Date;
  status: 'filed' | 'scheduled';
  id: string; // calendar_event_id from frontmatter
  date: string; // YYYY-MM-DD (Eastern) from frontmatter
}

// Eastern-date string used for filenames and dedup keys
function easternDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// MIGRATION SAFETY: the legacy private API used UUID document ids, the official
// public API uses `not_...` ids. Meetings already in the vault therefore can't be
// matched by id, so fall back to a date + normalized-title key to avoid
// re-syncing the entire overlap window as duplicates.
function dedupKey(title: string, date: string): string {
  return `${date}|${normalizeTitle(title)}`;
}

// TITLE NORMALIZATION FOR MATCHING
function normalizeTitle(title: string): string {
  return title
    .replace(/^Re:\s*/i, '') // Remove "Re:" prefix
    .toLowerCase()
    .trim();
}

// CHECK IF TRANSCRIPT SHOULD BE SYNCED FOR THIS MEETING
function titleHasTranscriptTag(title: string): boolean {
  return /(\s|^)#transcript(\b|[^\w])/i.test(title);
}

function stripTranscriptTag(title: string): string {
  // Remove '#transcript' token, collapse spaces, and tidy spaces before punctuation
  let s = title.replace(/(^|\s)#transcript(\b)/ig, '$1');
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/\s+([,.;:!?])/g, '$1');
  return s.trim();
}

// Titles that always get transcripts (case-insensitive prefix match)
const ALWAYS_TRANSCRIPT_TITLES = [
  'meet this moment',
  'mindshift recovery national call',
];

function titleAlwaysGetsTranscript(title: string): boolean {
  const titleLower = title.toLowerCase();
  return ALWAYS_TRANSCRIPT_TITLES.some(pattern => titleLower.startsWith(pattern));
}

function shouldSyncTranscript(title: string): boolean {
  // Directive tag always forces inclusion
  if (titleHasTranscriptTag(title)) return true;

  // Specific meeting types always get transcripts
  if (titleAlwaysGetsTranscript(title)) return true;

  // If no filters are configured, use global setting
  if (config.transcriptTitleFilter.length === 0) {
    return config.syncTranscript;
  }

  // Check if any filter matches the title (case-insensitive)
  const titleLower = title.toLowerCase();
  return config.transcriptTitleFilter.some(filter => titleLower.includes(filter));
}

// TIME WINDOW MATCHING (12 hours)
function isWithinTimeWindow(time1: Date, time2: Date): boolean {
  const diffMs = Math.abs(time1.getTime() - time2.getTime());
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours <= 12;
}

// VAULT INDEXING - SCAN EXISTING MEETING FILES
async function indexVaultMeetings(vaultPath: string): Promise<ExistingMeeting[]> {
  const meetings: ExistingMeeting[] = [];

  try {
    const files = await readdir(vaultPath);

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = join(vaultPath, file);
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) continue;

        const content = await readFile(filePath, 'utf-8');
        const parsed = matter(content);
        const frontmatter = parsed.data;

        if (frontmatter.source === 'granola' && frontmatter.calendar_event_id) {
          const startTime = new Date(frontmatter.start_time || '');
          meetings.push({
            filePath,
            title: frontmatter.title || '',
            startTime,
            status: frontmatter.status || 'scheduled',
            id: frontmatter.calendar_event_id,
            date: frontmatter.date
              ? String(frontmatter.date).slice(0, 10)
              : (isNaN(startTime.getTime()) ? '' : easternDate(startTime))
          });
        }
      } catch (error) {
        // Skip files that can't be parsed
        continue;
      }
    }
  } catch (error) {
    console.error('Error indexing vault:', error);
  }

  return meetings;
}

// FIND MATCHING SCHEDULED MEETING
function findMatchingScheduledMeeting(
  filedMeeting: { title: string; startTime: Date }, 
  existingMeetings: ExistingMeeting[]
): ExistingMeeting | null {
  const normalizedTitle = normalizeTitle(filedMeeting.title);
  
  for (const existing of existingMeetings) {
    if (existing.status !== 'scheduled') continue;
    
    const existingNormalizedTitle = normalizeTitle(existing.title);
    
    if (existingNormalizedTitle === normalizedTitle && 
        isWithinTimeWindow(filedMeeting.startTime, existing.startTime)) {
      return existing;
    }
  }
  
  return null;
}

// PUSHOVER NOTIFICATION - FIRE AND FORGET
function sendPushover(title: string, message: string): void {
  if (!config.pushover.userKey || !config.pushover.apiToken) return;
  
  fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: config.pushover.apiToken,
      user: config.pushover.userKey,
      title,
      message,
      priority: '1'
    })
  }).catch(err => {
    console.error(`Pushover failed: ${err.message}`);
  });
}

// MEETING PROCESSING FUNCTION
async function processSingleMeeting(): Promise<void> {
  if (!config.enableMeetingProcessing) return;
  
  if (!config.vaultOpsScriptPath || !existsSync(config.vaultOpsScriptPath)) {
    console.log(`⚠️  External script not found, skipping meeting processing`);
    return;
  }
  
  console.log(`🤖 Calling external processing script...`);
  
  try {
    // Fire and forget - don't wait for completion
    const { spawn } = await import('child_process');
    spawn('/opt/homebrew/bin/bash', [config.vaultOpsScriptPath], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    console.log(`✅ External script launched (fire and forget)`);
  } catch (error: any) {
    console.error(`❌ Failed to launch external script: ${error.message}`);
    // Don't throw - this shouldn't fail the sync
  }
}


// SUMMARY HEADING NORMALIZATION
// The legacy panel scraper emitted H3 sections, so the whole vault nests summary
// content at `###` beneath `## Summary`. The public API's summary_markdown starts
// at `#`, which would put multiple H1s in every note. Shift headings so the
// shallowest becomes H3, preserving relative depth. Fenced code blocks are left
// alone so `#` comments inside them aren't mangled.
function normalizeSummaryHeadings(markdown: string): string {
  if (!markdown) return '';

  const lines = markdown.split('\n');
  const headingRe = /^(#{1,6})(\s+\S)/;

  let inFence = false;
  let minLevel = 7;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(headingRe);
    if (m) minLevel = Math.min(minLevel, m[1].length);
  }

  if (minLevel === 7 || minLevel >= 3) return markdown;

  const shift = 3 - minLevel;
  inFence = false;
  return lines
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(headingRe, (_, hashes, rest) =>
        '#'.repeat(Math.min(6, hashes.length + shift)) + rest
      );
    })
    .join('\n');
}

// CONTENT VALIDATION FUNCTION
// The public API only returns notes that already have a generated summary, but a
// note can still come back with an empty transcript and an empty summary.
function hasContent(note: Note): boolean {
  const hasTranscriptContent = Array.isArray(note.transcript) && note.transcript.length > 0;
  const hasSummaryContent = Boolean(
    (note.summary_markdown && note.summary_markdown.trim()) ||
    (note.summary_text && note.summary_text.trim())
  );

  return hasTranscriptContent || hasSummaryContent;
}

// CHECK IF MEETING IS IN THE PAST
function isPastMeeting(startTime: Date): boolean {
  return startTime < new Date();
}

// NORMALIZE ATTENDEE DATA FOR CONSISTENT FORMATTING
function normalizeAttendee(attendee: { name?: string; email?: string }): string {
  const hasValidName = attendee.name && attendee.name !== "undefined";
  return hasValidName ? `${attendee.name} <${attendee.email}>` : attendee.email || '';
}

// SHARED FUNCTION TO PROCESS AND WRITE MEETINGS
async function processAndWriteMeeting(data: MeetingData, existingMeeting?: ExistingMeeting): Promise<{ success: boolean; filePath?: string }> {
  // Convert to Eastern timezone for date components
  const easternDateStr = easternDate(data.startTime);
  const dayName = data.startTime.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });

  // Use existing file path if updating, otherwise create new path
  let filePath: string;

  if (existingMeeting) {
    // Update existing scheduled meeting file
    filePath = existingMeeting.filePath;
  } else {
    // Create new file path with flat structure: YYYY-MM-DD-DDD-Title--hash.md
    const cleanTitle = data.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').trim();
    // Strip the `not_` prefix so the suffix carries 8 chars of real entropy
    const shortId = data.id.replace(/^not_/, '').substring(0, 8);
    const filename = `${easternDateStr}-${dayName}-${cleanTitle}--${shortId}.md`;
    filePath = join(VAULT_PATH, filename);

    // Skip if file exists
    try {
      await access(filePath);
      return { success: false };
    } catch {
      // File doesn't exist, continue
    }
  }

  // Create frontmatter
  const frontmatter: Record<string, any> = {
    title: data.title,
    date: data.startTime.toISOString().split('T')[0],
    day: dayName,
    attendees: data.attendees,
    organizer: data.organizer,
    location: data.location,
    start_time: data.startTime.toISOString(),
    end_time: data.endTime?.toISOString() || '',
    duration_min: data.durationMin || 0,
    area: '',
    source: 'granola',
    source_id: data.id,
    status: data.status,
    privacy: 'internal',
    calendar_event_id: data.id,
    meeting_url: data.meetingUrl || '',
    transcript_url: data.status === 'filed'
      ? (data.webUrl || `https://notes.granola.ai/d/${data.id}`)
      : ''
  };

  // Preserve directive in frontmatter tags
  if (data.tags && data.tags.length > 0) {
    frontmatter.tags = data.tags;
  }

  // Create content based on status
  const content = data.status === 'filed'
    ? `# ${data.title}

## Agenda

## Tasks

## Summary

${data.panelContent || ''}${data.transcript ? `

## Transcript
${data.transcript}` : ''}`
    : `# ${data.title}

## Agenda

## Notes

## Action Items
`;
  
  const markdown = matter.stringify(content, frontmatter);

  if (config.dryRun) {
    console.log(`[dry-run] would write ${filePath} (${markdown.length} bytes)`);
    return { success: true, filePath };
  }

  // Write file
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, 'utf-8');

  console.log(data.status === 'filed' ? `✓ ${data.title}` : `📅 ${data.title} (${easternDateStr})`);
  return { success: true, filePath };
}

// MAIN SYNC FUNCTION
async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting sync with future meetings...`);

  // 1. INDEX EXISTING VAULT MEETINGS
  console.log('\n📁 Indexing existing vault meetings...');
  const existingMeetings = await indexVaultMeetings(VAULT_PATH);
  console.log(`   Found ${existingMeetings.length} existing meetings`);

  // Build a date+title lookup so legacy UUID-keyed files still dedupe against
  // the new `not_...` note ids.
  const existingKeys = new Set(
    existingMeetings
      .filter(em => em.status === 'filed' && em.date)
      .map(em => dedupKey(em.title, em.date))
  );

  // 2. FETCH PAST/PROCESSED MEETINGS FROM API
  console.log('\n📥 Fetching processed meetings from API...');

  let meetings: NoteSummary[];
  try {
    meetings = await listNotes(config.meetingsLimit);
  } catch (err: any) {
    const error = `Notes API failed: ${err.message}`;
    sendPushover('Granola Sync FAILED', error);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  console.log(`   Found ${meetings.length} processed meetings`);

  // API should ALWAYS return past meetings
  if (meetings.length === 0) {
    const error = 'API returned 0 meetings - API is likely broken';
    sendPushover('Granola Sync FAILED', error);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  let processedCount = 0;
  let skippedCount = 0;
  const newlyProcessedMeetings: { filePath: string; data: MeetingData }[] = [];

  // 4. PROCESS PAST MEETINGS (FILED MEETINGS WITH DEDUPLICATION)
  console.log('\n📝 Processing past meetings...');
  for (const summary of meetings) {
    const rawTitle = summary.title || 'Untitled Meeting';
    const startTime = new Date(summary.created_at);

    // Check if we already have a filed meeting with this Granola ID
    const existingFiledMeeting = existingMeetings.find(em =>
      em.id === summary.id && em.status === 'filed'
    );

    if (existingFiledMeeting) {
      console.log(`⏭️  Already exists: ${rawTitle}`);
      continue;
    }

    // Legacy files predate the `not_...` id scheme — match on date + title too
    const legacyTitle = titleHasTranscriptTag(rawTitle) ? stripTranscriptTag(rawTitle) : rawTitle;
    if (existingKeys.has(dedupKey(legacyTitle, easternDate(startTime)))) {
      console.log(`⏭️  Already exists (date+title): ${rawTitle}`);
      continue;
    }

    // The transcript is always requested — the solo/empty skip checks below need
    // it even when the transcript body won't be written into the note itself.
    const wantsTranscript = shouldSyncTranscript(rawTitle);

    let note: Note;
    try {
      await sleep(REQUEST_INTERVAL_MS);
      note = await getNote(summary.id, true);
    } catch (error: any) {
      const message = `Failed to fetch note for ${rawTitle} - skipping (${error.message})`;
      console.error(message);
      sendPushover('Granola Sync Warning', message);
      continue;
    }

    // Filter out solo/empty meetings
    const processedTranscript = processTranscript(note.transcript);

    // Duration from the transcript's own span rather than the calendar. A
    // scheduled block says what was booked; the span says what actually
    // happened, and it can't be skewed by a malformed calendar event.
    const spanMinutes = transcriptSpanMinutes(note.transcript);
    const hasTranscriptDirective = titleHasTranscriptTag(rawTitle);
    const cleanedTitle = hasTranscriptDirective ? stripTranscriptTag(rawTitle) : rawTitle;
    const attendees = note.attendees || [];
    const skipCheck = shouldSkipPastMeeting({
      attendees: attendees.map(a => ({ name: a.name || '', email: a.email })),
      transcript: processedTranscript,
      durationInMinutes: spanMinutes,
      title: rawTitle
    });

    if (skipCheck.skip) {
      console.log(`⏭️  Skipping past meeting: ${rawTitle} (${skipCheck.reason})`);
      skippedCount++;
      continue;
    }

    // Only include the transcript body if this meeting is configured for it
    const finalTranscript = wantsTranscript ? processedTranscript : '';

    // CONTENT VALIDATION FOR PAST MEETINGS - Skip empty meetings
    if (isPastMeeting(startTime)) {
      if (!hasContent(note)) {
        console.log(`⏭️  Skipping empty: ${rawTitle} (no transcript or summary)`);
        skippedCount++;
        continue;
      }
    }

    // The public API returns the AI summary as markdown directly, replacing the
    // HTML panel scraping the private API required.
    const panelContent = normalizeSummaryHeadings(
      (note.summary_markdown || note.summary_text || '').trim()
    );

    // Duration comes from the calendar event when both scheduled times exist
    const scheduledStart = note.calendar_event?.scheduled_start_time;
    const scheduledEnd = note.calendar_event?.scheduled_end_time;
    let endTime: Date | undefined;
    let durationMin = 0;
    if (scheduledEnd) {
      endTime = new Date(scheduledEnd);
      if (scheduledStart) {
        durationMin = Math.max(
          0,
          Math.round((endTime.getTime() - new Date(scheduledStart).getTime()) / 60000)
        );
      }
    }

    // Normalize data for shared function
    const meetingData: MeetingData = {
      id: summary.id,
      title: cleanedTitle,
      startTime,
      endTime,
      durationMin,
      attendees: attendees
        .map(a => normalizeAttendee({ name: a.name || undefined, email: a.email }))
        .filter(Boolean),
      organizer: note.owner?.name || note.calendar_event?.organiser || '',
      location: '',
      status: 'filed',
      transcript: finalTranscript,
      panelContent,
      webUrl: note.web_url,
      tags: hasTranscriptDirective ? ['#transcript'] : undefined
    };
    
    // DEDUPLICATION: Check for matching scheduled meeting
    const matchingScheduledMeeting = findMatchingScheduledMeeting(meetingData, existingMeetings);
    
    if (matchingScheduledMeeting) {
      console.log(`🔄 Updating scheduled meeting: ${rawTitle} → ${matchingScheduledMeeting.filePath}`);
      const result = await processAndWriteMeeting(meetingData, matchingScheduledMeeting);
      if (result.success && result.filePath) {
        processedCount++;
        newlyProcessedMeetings.push({ filePath: result.filePath, data: meetingData });
      }
    } else {
      // No matching scheduled meeting, create new filed meeting
      const result = await processAndWriteMeeting(meetingData);
      if (result.success && result.filePath) {
        processedCount++;
        newlyProcessedMeetings.push({ filePath: result.filePath, data: meetingData });
      }
    }
  }

  // 5. PROCESS NEWLY SYNCED MEETINGS
  if (config.enableMeetingProcessing && newlyProcessedMeetings.length > 0 && !config.dryRun) {
    console.log(`\n🤖 Processing ${newlyProcessedMeetings.length} newly synced meetings...`);
    await processSingleMeeting();
  }

  // 6. SUCCESS MESSAGE
  const endTimestamp = new Date().toISOString();
  console.log(`\n[${endTimestamp}] SUCCESS: ${processedCount} meetings processed`);
  if (skippedCount > 0) {
    console.log(`⏭️  Skipped: ${skippedCount} empty meetings (no transcript or panels)`);
  }
}

// EXECUTION
main().catch(error => {
  const errorTimestamp = new Date().toISOString();
  console.error(`[${errorTimestamp}] === SYNC FAILED ===`);
  console.error(error);
  console.error('===================');
  
  // Send Pushover with stack trace
  const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
  sendPushover('Granola Sync CRASHED', `Script crashed at ${errorTimestamp}\n\n${errorMessage}`);
  
  // Give Pushover time to send before exiting
  setTimeout(() => process.exit(1), 1000);
});
