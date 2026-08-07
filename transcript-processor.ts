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
  // Legacy private-API shape
  source?: string;
  start_timestamp?: string;
  end_timestamp?: string;
  // Official public-API shape
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
  endTime: number;
  source: string;
}

/**
 * Process raw transcript data from Granola API
 * Returns formatted markdown with speaker labels
 */
export function processTranscript(transcriptData: any): string {
  // Handle both string transcripts and structured segment data
  if (typeof transcriptData === 'string') {
    return transcriptData; // Pass through if already processed
  }

  // Extract segments array from various possible structures
  const segments: TranscriptSegment[] = 
    Array.isArray(transcriptData) ? transcriptData :  // Direct array case
    transcriptData?.segments || 
    transcriptData?.transcript?.segments || 
    [];

  if (!segments || segments.length === 0) {
    return transcriptData?.transcript || '';
  }

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
  // Timestamps: public API uses start_time/end_time, legacy used *_timestamp
  const rawStart = segment.start_time || segment.start_timestamp;
  const rawEnd = segment.end_time || segment.end_timestamp;

  const startTime = rawStart ? new Date(rawStart).getTime() : 0;
  const endTime = rawEnd ? new Date(rawEnd).getTime() : startTime;

  // Audio source. The public API nests this under `speaker` and renames the
  // remote source from 'system' to 'speaker'; normalize both to the legacy
  // values so the dedup logic below keeps working unchanged.
  const rawSource = segment.speaker?.source || segment.source || '';
  const source = rawSource === 'speaker' ? 'system' : rawSource;

  // Determine speaker label. The public API states attribution explicitly,
  // which is more reliable than inferring it from the audio source.
  let speaker = 'Unknown';
  const attribution = segment.speaker?.attribution;
  if (attribution === 'me') {
    speaker = 'Me';
  } else if (attribution === 'them') {
    speaker = 'Them';
  } else if (source === 'microphone') {
    speaker = 'Me';
  } else if (source === 'system') {
    speaker = 'Them';
  }

  return {
    text: segment.text!.trim(),
    speaker,
    startTime,
    endTime,
    source
  };
}

/**
 * Remove duplicate segments within time windows
 */
function deduplicateSegments(
  segments: ProcessedSegment[],
  timeWindowMs: number = 4500,
  similarityThreshold: number = 0.68
): ProcessedSegment[] {
  if (segments.length === 0) return [];

  const toRemove = new Set<number>();

  for (let i = 0; i < segments.length; i++) {
    if (toRemove.has(i)) continue;

    const segment = segments[i];
    const windowEnd = segment.startTime + timeWindowMs;

    // Check subsequent segments within time window
    for (let j = i + 1; j < segments.length; j++) {
      if (toRemove.has(j)) continue;

      const other = segments[j];
      if (other.startTime > windowEnd) break;

      const similarity = calculateSimilarity(segment.text, other.text);

      if (similarity >= similarityThreshold) {
        // Prefer microphone source over system
        if (segment.source === 'microphone' && other.source === 'system') {
          toRemove.add(j);
        } else if (segment.source === 'system' && other.source === 'microphone') {
          toRemove.add(i);
          break;
        } else {
          // Keep the longer text
          if (segment.text.length >= other.text.length) {
            toRemove.add(j);
          } else {
            toRemove.add(i);
            break;
          }
        }
      }
    }
  }

  return segments.filter((_, i) => !toRemove.has(i));
}

/**
 * Calculate text similarity (0.0 to 1.0)
 */
function calculateSimilarity(text1: string, text2: string): number {
  const s1 = text1.toLowerCase();
  const s2 = text2.toLowerCase();

  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  // Check containment
  if (s1.includes(s2) || s2.includes(s1)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    return minLen / maxLen + 0.2; // Bonus for containment
  }

  // Simple character-based similarity
  const lcs = longestCommonSubsequence(s1, s2);
  return lcs / Math.max(s1.length, s2.length);
}

/**
 * Calculate longest common subsequence length
 */
function longestCommonSubsequence(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[m][n];
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

const OWNER_EMAILS = new Set(
  (process.env.OWNER_EMAILS || 'josh@omaihq.com,josh@mindshiftrecovery.org,joshroman@gmail.com')
    .split(',')
    .map(email => email.trim())
);


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
  if (meeting.title && /(\s|^)#transcript(\b|[^\w])/i.test(meeting.title)) {
    return { skip: false };
  }

  const attendees = meeting.attendees || [];
  
  // No attendees = solo meeting
  if (attendees.length === 0) {
    return { skip: true, reason: 'No attendees (solo meeting)' };
  }
  
  // Check if all attendees are owner's email addresses
  const nonOwnerAttendees = attendees.filter(a => a.email && !OWNER_EMAILS.has(a.email));
  
  if (nonOwnerAttendees.length === 0) {
    return { skip: true, reason: 'Solo meeting (only owner\'s emails)' };
  }
  
  // Check for empty transcript
  const transcript = meeting.transcript || '';
  if (transcript.trim().length === 0) {
    return { skip: true, reason: 'Empty transcript' };
  }
  
  // Check for very short duration (less than 2 minutes)
  if (meeting.durationInMinutes && meeting.durationInMinutes < 2) {
    return { skip: true, reason: 'Too short (less than 2 minutes)' };
  }
  
  return { skip: false };
}
