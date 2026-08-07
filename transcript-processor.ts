#!/usr/bin/env bun

import 'dotenv/config';

/**
 * Transcript Processing for Granola to Obsidian Sync
 * 
 * Processes raw Granola transcripts to:
 * - Add speaker labels (Me/Them)
 * - Remove duplicate segments
 * - Group consecutive same-speaker text
 * - Clean whitespace
 */

interface TranscriptSegment {
  text?: string;
  speaker?: {
    source?: string;      // 'microphone' | 'speaker'
    attribution?: string; // 'me' | 'them'
    name?: string;
  };
  start_time?: string;
  end_time?: string;
}

interface ProcessedSegment {
  text: string;
  speaker: string;
  startTime: number;
}

/**
 * Process raw transcript data from Granola API
 * Returns formatted markdown with speaker labels
 */
export function processTranscript(segments: TranscriptSegment[] | null | undefined): string {
  if (!segments || segments.length === 0) return '';

  // Convert to processed segments with speaker info
  const processed = segments
    .filter(s => s.text && s.text.trim())
    .map(s => toProcessedSegment(s))
    .sort((a, b) => a.startTime - b.startTime);

  // Deduplicate segments within time windows
  const deduplicated = deduplicateSegments(processed);

  // Format as readable markdown
  return formatTranscript(deduplicated);
}

/**
 * Convert raw segment to processed segment with speaker identification
 */
function toProcessedSegment(segment: TranscriptSegment): ProcessedSegment {
  const startTime = segment.start_time ? new Date(segment.start_time).getTime() : 0;

  // Determine the speaker label.
  //
  // The public API diarizes remote participants and names them, so a group call
  // resolves to individual people rather than one undifferentiated "Them". Names
  // are used verbatim — no fuzzy merging of variants, since collapsing two
  // similar labels risks merging two different people, which is worse than
  // listing one person twice.
  //
  // The local speaker is never named by the API, so it stays "Me" rather than
  // mixing "Me" and a configured name within a single transcript.
  const attribution = segment.speaker?.attribution;
  const name = segment.speaker?.name?.trim();

  let speaker: string;
  if (attribution === 'me') {
    speaker = 'Me';
  } else if (name) {
    speaker = name;
  } else if (attribution === 'them') {
    speaker = 'Them';
  } else if (segment.speaker?.source === 'microphone') {
    speaker = 'Me';
  } else if (segment.speaker?.source === 'speaker') {
    speaker = 'Them';
  } else {
    speaker = 'Unknown';
  }

  return {
    text: segment.text!.trim(),
    speaker,
    startTime
  };
}

/**
 * Remove repeated segments within a short time window.
 *
 * This used to fuzzy-match on a 0.68 similarity threshold to undo the echo the
 * old private API produced, where the same utterance arrived on both the
 * microphone and system audio streams. The public API diarizes server-side and
 * returns pre-attributed segments, so that echo is effectively gone — measured
 * at 3 cross-source duplicate pairs across 4 meetings.
 *
 * What the fuzzy matching did instead was delete real content: across 2,464
 * live segments it removed 12, and half of those removals crossed a speaker
 * boundary. It dropped "Nausea is here." because someone else said "Fatigue is
 * here.", and dropped a statement because another participant paraphrased it
 * back. Only byte-identical repeats from the same speaker are removed now.
 */
export function deduplicateSegments(
  segments: ProcessedSegment[],
  timeWindowMs: number = 4500
): ProcessedSegment[] {
  if (segments.length === 0) return [];

  const toRemove = new Set<number>();

  for (let i = 0; i < segments.length; i++) {
    if (toRemove.has(i)) continue;

    const segment = segments[i];
    const windowEnd = segment.startTime + timeWindowMs;

    for (let j = i + 1; j < segments.length; j++) {
      if (toRemove.has(j)) continue;

      const other = segments[j];
      if (other.startTime > windowEnd) break;

      if (other.speaker === segment.speaker && other.text === segment.text) {
        toRemove.add(j);
      }
    }
  }

  return segments.filter((_, i) => !toRemove.has(i));
}

/**
 * Format segments as readable markdown with speaker labels
 */
function formatTranscript(segments: ProcessedSegment[]): string {
  if (segments.length === 0) return '';

  const lines: string[] = [];
  let currentSpeaker: string | null = null;
  let speakerText: string[] = [];

  for (const segment of segments) {
    // When speaker changes, output accumulated text
    if (currentSpeaker && currentSpeaker !== segment.speaker) {
      lines.push(`${currentSpeaker}:`);
      lines.push(speakerText.join(' ').trim());
      lines.push('');
      speakerText = [];
    }

    currentSpeaker = segment.speaker;
    speakerText.push(segment.text);
  }

  // Output final speaker's text
  if (currentSpeaker && speakerText.length > 0) {
    lines.push(`${currentSpeaker}:`);
    lines.push(speakerText.join(' ').trim());
    lines.push('');
  }

  return lines.join('\n');
}

// MEETING FILTERING FUNCTIONS

/**
 * A '#transcript' directive in a meeting title forces the transcript to be
 * synced and overrides the solo/empty skip checks. Defined here and re-exported
 * to sync.ts so the pattern has a single definition.
 */
export function titleHasTranscriptTag(title: string): boolean {
  return /(\s|^)#transcript(\b|[^\w])/i.test(title);
}

// Read lazily rather than at module load. ES imports are hoisted, so this
// module is evaluated before sync.ts gets to load the shared automation config
// — binding OWNER_EMAILS eagerly meant a value set there was silently ignored
// and the hardcoded defaults were used instead, with no error.
let ownerEmailsCache: Set<string> | null = null;

function ownerEmails(): Set<string> {
  if (!ownerEmailsCache) {
    ownerEmailsCache = new Set(
      (process.env.OWNER_EMAILS || 'josh@omaihq.com,josh@mindshiftrecovery.org,joshroman@gmail.com')
        .split(',')
        .map(email => email.trim())
        .filter(Boolean)
    );
  }
  return ownerEmailsCache;
}


/**
 * Check if a past meeting (from API) should be skipped
 * Returns { skip: true, reason: string } if should skip, { skip: false } otherwise
 */
export function shouldSkipPastMeeting(meeting: {
  attendees?: Array<{ name: string; email: string }>;
  transcript?: string;
  durationInMinutes?: number;
  title?: string;
}): { skip: boolean; reason?: string } {
  // If directive tag is present, never skip based on solo/empty checks
  if (meeting.title && titleHasTranscriptTag(meeting.title)) {
    return { skip: false };
  }

  const attendees = meeting.attendees || [];
  
  // No attendees = solo meeting
  if (attendees.length === 0) {
    return { skip: true, reason: 'No attendees (solo meeting)' };
  }
  
  // Check if all attendees are owner's email addresses
  const owners = ownerEmails();
  const nonOwnerAttendees = attendees.filter(a => a.email && !owners.has(a.email));
  
  if (nonOwnerAttendees.length === 0) {
    return { skip: true, reason: 'Solo meeting (only owner\'s emails)' };
  }
  
  // Check for empty transcript
  const transcript = meeting.transcript || '';
  if (transcript.trim().length === 0) {
    return { skip: true, reason: 'Empty transcript' };
  }
  
  // Check for very short duration (less than 2 minutes). Tested against
  // undefined rather than truthiness: a sub-minute recording is exactly the
  // case this filters, and `0 && ...` would wave it through.
  if (meeting.durationInMinutes !== undefined && meeting.durationInMinutes < 2) {
    return { skip: true, reason: 'Too short (less than 2 minutes)' };
  }
  
  return { skip: false };
}
