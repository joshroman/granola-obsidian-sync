#!/usr/bin/env bun

import 'dotenv/config';
import { readFile, writeFile, mkdir, access, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import matter from 'gray-matter';
import { processTranscript, shouldSkipPastMeeting } from './transcript-processor';
import { processPanels } from './panel-processor';

const execFileAsync = promisify(execFile);

// --- CONFIGURATION ---
// All user-configurable values are sourced from environment variables.
// See .env.example for details.

const requiredEnvVars = [
  'GRANOLA_AUTH_PATH',
  'OBSIDIAN_VAULT_MEETINGS_PATH',
];

// Helper to resolve tilde (~) in paths
const resolvePath = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// Validate required environment variables
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}. Please copy .env.example to .env and set this value.`);
  }
}

const config = {
  granolaAuthPath: resolvePath(process.env.GRANOLA_AUTH_PATH!),
  obsidianVaultPath: resolvePath(process.env.OBSIDIAN_VAULT_MEETINGS_PATH!),
  meetingsLimit: parseInt(process.env.GRANOLA_MEETINGS_LIMIT || '50'),
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

const API_BASE = 'https://api.granola.ai/v1';
const VAULT_PATH = config.obsidianVaultPath;
const TOKEN_PATH = config.granolaAuthPath;

// Template identification for panel processing
const TEMPLATE_SLUG = 'b491d27c-1106-4ebf-97c5-d5129742945c';

// TYPES
interface GranolaDoc {
  id: string;
  title: string;
  created_at: string;
  workspace?: { name: string };
}

interface DocMetadata {
  attendees?: Array<{ name: string; email: string }>;
  creator?: { name: string; email: string };
  sharing_link_visibility?: string;
}


interface Panel {
  id: string;
  title: string;
  template_slug: string;
  original_content: string;
  created_at: string;
  updated_at: string;
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
}

// VAULT INDEX
interface ExistingMeeting {
  filePath: string;
  title: string;
  startTime: Date;
  status: 'filed' | 'scheduled';
  id: string; // calendar_event_id from frontmatter
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
    const years = await readdir(vaultPath);
    
    for (const year of years) {
      if (!year.match(/^\d{4}$/)) continue; // Skip non-year folders
      
      const yearPath = join(vaultPath, year);
      const yearStat = await stat(yearPath);
      if (!yearStat.isDirectory()) continue;
      
      const months = await readdir(yearPath);
      
      for (const month of months) {
        const monthPath = join(yearPath, month);
        const monthStat = await stat(monthPath);
        if (!monthStat.isDirectory()) continue;
        
        const days = await readdir(monthPath);
        
        for (const day of days) {
          const dayPath = join(monthPath, day);
          const dayStat = await stat(dayPath);
          if (!dayStat.isDirectory()) continue;
          
          const files = await readdir(dayPath);
          
          for (const file of files) {
            if (!file.endsWith('.md')) continue;
            
            const filePath = join(dayPath, file);
            try {
              const content = await readFile(filePath, 'utf-8');
              const parsed = matter(content);
              const frontmatter = parsed.data;
              
              if (frontmatter.source === 'granola' && frontmatter.calendar_event_id) {
                meetings.push({
                  filePath,
                  title: frontmatter.title || '',
                  startTime: new Date(frontmatter.start_time || ''),
                  status: frontmatter.status || 'scheduled',
                  id: frontmatter.calendar_event_id
                });
              }
            } catch (error) {
              // Skip files that can't be parsed
              continue;
            }
          }
        }
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


// CONTENT VALIDATION FUNCTION
function hasContent(transcriptData: any, panels?: Panel[]): boolean {
  // Check transcript segments
  const segments = Array.isArray(transcriptData) ? transcriptData :
                  transcriptData?.segments || 
                  transcriptData?.transcript?.segments || 
                  [];
  
  const hasTranscriptContent = segments.length > 0;
  
  // Check panels
  const hasPanelContent = panels && panels.length > 0 && 
    panels.some(p => p.original_content && p.original_content.trim().length > 0);
  
  return hasTranscriptContent || hasPanelContent || false;
}

// CHECK IF MEETING IS IN THE PAST
function isPastMeeting(meeting: GranolaDoc): boolean {
  const meetingTime = new Date(meeting.created_at);
  return meetingTime < new Date();
}

// NORMALIZE ATTENDEE DATA FOR CONSISTENT FORMATTING
function normalizeAttendee(attendee: { name?: string; email?: string }): string {
  const hasValidName = attendee.name && attendee.name !== "undefined";
  return hasValidName ? `${attendee.name} <${attendee.email}>` : attendee.email || '';
}

// SHARED FUNCTION TO PROCESS AND WRITE MEETINGS  
async function processAndWriteMeeting(data: MeetingData, existingMeeting?: ExistingMeeting): Promise<{ success: boolean; filePath?: string }> {
  // Convert to Eastern timezone for folder structure (use direct toLocaleDateString with timezone)
  const year = parseInt(data.startTime.toLocaleDateString('en-US', { year: 'numeric', timeZone: 'America/New_York' }));
  const month = String(parseInt(data.startTime.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'America/New_York' }))).padStart(2, '0');
  const monthName = data.startTime.toLocaleDateString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const day = String(parseInt(data.startTime.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'America/New_York' }))).padStart(2, '0');
  const dayName = data.startTime.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  
  // For filename timestamp, use Eastern timezone as well
  const easternDateStr = data.startTime.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const easternTimeStr = data.startTime.toLocaleTimeString('en-US', { 
    hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' 
  }).replace(':', '');
  const dateStr = `${easternDateStr} ${easternTimeStr}`;

  // Use existing file path if updating, otherwise create new path
  let filePath: string;
  
  if (existingMeeting) {
    // Update existing scheduled meeting file
    filePath = existingMeeting.filePath;
  } else {
    // Create new file path
    const cleanTitle = data.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
    const shortId = data.id.substring(0, 8);
    const filename = `${dateStr} ${cleanTitle} -- ${shortId}.md`;
    filePath = join(VAULT_PATH, String(year), `${month}-${monthName}`, `${day}-${dayName}`, filename);

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
    attendees: data.attendees,
    organizer: data.organizer,
    location: data.location,
    start_time: data.startTime.toISOString(),
    end_time: data.endTime?.toISOString() || '',
    duration_min: data.durationMin || 0,
    area: '',
    source: 'granola',
    status: data.status,
    privacy: 'internal',
    calendar_event_id: data.id,
    meeting_url: data.meetingUrl || '',
    transcript_url: data.status === 'filed' ? `https://notes.granola.ai/d/${data.id}` : ''
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
  
  // Write file
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, 'utf-8');
  
  console.log(data.status === 'filed' ? `✓ ${data.title}` : `📅 ${data.title} (${dateStr})`);
  return { success: true, filePath };
}

// PANEL API FUNCTION
async function getPanels(documentId: string, token: string): Promise<Panel[]> {
  const response = await fetch(`${API_BASE}/get-document-panels`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ document_id: documentId })
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch panels: ${response.status}`);
  }

  return await response.json();
}

// MAIN SYNC FUNCTION
async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting sync with future meetings...`);

  // 1. INDEX EXISTING VAULT MEETINGS
  console.log('\n📁 Indexing existing vault meetings...');
  const existingMeetings = await indexVaultMeetings(VAULT_PATH);
  console.log(`   Found ${existingMeetings.length} existing meetings`);

  // 2. GET AUTH TOKEN
  const tokenData = JSON.parse(await readFile(TOKEN_PATH, 'utf-8'));
  const tokens = JSON.parse(tokenData.workos_tokens);
  const token = tokens.access_token;
  
  if (!token) throw new Error('No auth token found');

  // 3. FETCH PAST/PROCESSED MEETINGS FROM API
  console.log('\n📥 Fetching processed meetings from API...');
  const docsResponse = await fetch(`${API_BASE}/get-documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ limit: config.meetingsLimit })
  });

  if (!docsResponse.ok) {
    const error = `Docs API failed: ${docsResponse.status} ${docsResponse.statusText}`;
    sendPushover('Granola Sync FAILED', error);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  const meetings: GranolaDoc[] = await docsResponse.json();
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
  for (const meeting of meetings) {
    // Check if we already have a filed meeting with this Granola ID
    const existingFiledMeeting = existingMeetings.find(em => 
      em.id === meeting.id && em.status === 'filed'
    );
    
    if (existingFiledMeeting) {
      console.log(`⏭️  Already exists: ${meeting.title}`);
      continue;
    }
    
    // Check if meeting has panels (required for sync)
    let panels: Panel[] = [];
    try {
      panels = await getPanels(meeting.id, token);
    } catch (error) {
      console.log(`⚠️  Failed to fetch panels for ${meeting.title} - skipping`);
      continue;
    }

    if (!panels || panels.length === 0) {
      console.log(`⏳ No panels yet: ${meeting.title}`);
      continue;
    }
    
    // Fetch metadata and transcript
    const [metaResponse, transcriptResponse] = await Promise.all([
      fetch(`${API_BASE}/get-document-metadata`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ document_id: meeting.id })
      }),
      fetch(`${API_BASE}/get-document-transcript`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ document_id: meeting.id })
      })
    ]);

    if (!metaResponse.ok || !transcriptResponse.ok) {
      const error = `Failed to fetch data for ${meeting.title} - skipping`;
      console.error(error);
      sendPushover('Granola Sync Warning', error);
      continue;
    }

    const metadata: DocMetadata = await metaResponse.json();
    const transcriptData = await transcriptResponse.json();
    
    // Filter out solo/empty meetings
    const processedTranscript = processTranscript(transcriptData);
    const hasTranscriptDirective = titleHasTranscriptTag(meeting.title);
    const cleanedTitle = hasTranscriptDirective ? stripTranscriptTag(meeting.title) : meeting.title;
    const skipCheck = shouldSkipPastMeeting({
      attendees: metadata.attendees || [],
      transcript: processedTranscript,
      title: meeting.title
    });
    
    if (skipCheck.skip) {
      console.log(`⏭️  Skipping past meeting: ${meeting.title} (${skipCheck.reason})`);
      skippedCount++;
      continue;
    }
    
    // Only do full transcript processing if we're syncing transcripts for this meeting
    const finalTranscript = shouldSyncTranscript(meeting.title) ? processedTranscript : '';
    
    // CONTENT VALIDATION FOR PAST MEETINGS - Skip empty meetings
    if (isPastMeeting(meeting)) {
      if (!hasContent(transcriptData, panels)) {
        console.log(`⏭️  Skipping empty: ${meeting.title} (0 segments, ${panels.length} panels)`);
        skippedCount++;
        continue;
      }
    }
    
    // Panel processing using already fetched panels
    let panelContent = '';
    try {
      if (panels && panels.length > 0) {
        // Sort panels: specified template first
        const sortedPanels = panels.sort((a, b) => 
          (b.template_slug === TEMPLATE_SLUG ? 1 : 0) - 
          (a.template_slug === TEMPLATE_SLUG ? 1 : 0)
        );
        panelContent = processPanels(sortedPanels);
      }
    } catch (error) {
      console.error(`Failed to process panels for "${meeting.title}":`, error);
      // Continue without panels - don't break existing functionality
    }
    
    // Normalize data for shared function
    const meetingData: MeetingData = {
      id: meeting.id,
      title: cleanedTitle,
      startTime: new Date(meeting.created_at),
      attendees: metadata.attendees?.map(normalizeAttendee).filter(Boolean) || [],
      organizer: metadata.creator?.name || '',
      location: '',
      status: 'filed',
      transcript: finalTranscript,
      panelContent: panelContent,
      tags: hasTranscriptDirective ? ['#transcript'] : undefined
    };
    
    // DEDUPLICATION: Check for matching scheduled meeting
    const matchingScheduledMeeting = findMatchingScheduledMeeting(meetingData, existingMeetings);
    
    if (matchingScheduledMeeting) {
      console.log(`🔄 Updating scheduled meeting: ${meeting.title} → ${matchingScheduledMeeting.filePath}`);
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
  if (config.enableMeetingProcessing && newlyProcessedMeetings.length > 0) {
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
