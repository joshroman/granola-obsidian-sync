/**
 * Client for the official Granola public API.
 * https://docs.granola.ai/introduction
 *
 * Shared by sync.ts and the granola CLI so there is one definition of the
 * endpoints, the rate limiting and the response shapes.
 */

import './env';
import { requireEnv } from './env';

// GRANOLA_API_BASE exists so callers can be pointed at a local mock in tests.
export const API_BASE = process.env.GRANOLA_API_BASE || 'https://public-api.granola.ai/v1';

// API limits: 30 notes/page max, 5 req/sec sustained (300/min), 25 burst per 5s.
export const PAGE_SIZE = 30;
export const REQUEST_INTERVAL_MS = 250; // ~4 req/sec, under the sustained limit

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface NoteSummary {
  id: string;
  title: string | null;
  owner?: { name: string | null; email: string };
  created_at: string;
}

export interface TranscriptSegmentApi {
  speaker?: {
    source?: 'microphone' | 'speaker';
    attribution?: 'me' | 'them';
    name?: string;
  };
  text: string;
  start_time?: string;
  end_time?: string;
}

export interface Note extends NoteSummary {
  web_url?: string;
  calendar_event?: {
    organiser?: string | null;
    scheduled_start_time?: string | null;
    scheduled_end_time?: string | null;
  };
  attendees?: Array<{ name: string | null; email: string }>;
  summary_text?: string;
  summary_markdown?: string | null;
  transcript?: TranscriptSegmentApi[] | null;
}

export async function apiGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${requireEnv('GRANOLA_API_KEY')}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText} ${body}`.trim());
  }

  return await response.json();
}

export interface ListOptions {
  /** Stop once this many notes have been collected. */
  limit: number;
  /** Only keep notes whose summary passes this. Titles are in the list
   *  response, so title filtering costs no extra requests. */
  filter?: (note: NoteSummary) => boolean;
  /** ISO date; the API excludes anything created before it. */
  since?: string;
  /** ISO date; the API excludes anything created after it. */
  until?: string;
  /** Cap on notes examined, so a filter that matches nothing terminates. */
  maxScan?: number;
  onProgress?: (scanned: number, matched: number) => void;
}

/**
 * Page through /notes newest-first, collecting notes that pass `filter`.
 *
 * Pagination continues past non-matching notes, so asking for the last 10
 * meetings with a given title works even when hundreds of other meetings sit
 * between them — bounded by maxScan.
 */
export async function listNotes(opts: ListOptions): Promise<NoteSummary[]> {
  const { limit, filter, since, until, maxScan = 1000, onProgress } = opts;

  const matched: NoteSummary[] = [];
  let cursor: string | null = null;
  let scanned = 0;

  while (matched.length < limit && scanned < maxScan) {
    const params: Record<string, string> = { page_size: String(PAGE_SIZE) };
    if (cursor) params.cursor = cursor;
    if (since) params.created_after = since;
    if (until) params.created_before = until;

    const page = await apiGet('/notes', params);
    const batch: NoteSummary[] = page.notes || [];
    if (batch.length === 0) break;

    for (const note of batch) {
      scanned++;
      if (!filter || filter(note)) {
        matched.push(note);
        if (matched.length >= limit) break;
      }
    }

    onProgress?.(scanned, matched.length);

    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
    await sleep(REQUEST_INTERVAL_MS);
  }

  return matched.slice(0, limit);
}

export async function getNote(id: string, includeTranscript = false): Promise<Note> {
  return await apiGet(`/notes/${id}`, includeTranscript ? { include: 'transcript' } : {});
}

/** Fetch details for many notes, paced under the rate limit. */
export async function getNotes(
  ids: string[],
  includeTranscript = false,
  onProgress?: (done: number, total: number) => void
): Promise<Note[]> {
  const notes: Note[] = [];
  for (const id of ids) {
    notes.push(await getNote(id, includeTranscript));
    onProgress?.(notes.length, ids.length);
    if (notes.length < ids.length) await sleep(REQUEST_INTERVAL_MS);
  }
  return notes;
}
