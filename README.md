# Granola to Obsidian Sync

Simple tool for syncing Granola meeting notes to an Obsidian vault. Fetches past meetings with panels and transcripts from the Granola API and creates organized Markdown files with YAML frontmatter in a configurable Obsidian subdirectory.

**Important Notes:** 
- Granola does not have a public API. This project uses the private Granola MacOS app API which is subject to frequent breaking changes. When a public API is available this project will be updated to use it.

## Features

- **Panel-Required Sync**: Only syncs meetings that have panels (Granola's structured content) to ensure that meeting is over & Granola AI has summarized meeting 
- **Transcript Processing**: Adds speaker labels (Me/Them), removes duplicates, groups by speaker (raw transcripts from Granola do not have this)
- **Selective Transcript Sync**: Filter which meetings get transcripts based on title keywords
- **Deduplication**: Automatically updates scheduled meetings when they become filed meetings
- **Vault Indexing**: Scans existing meetings to prevent duplicates and enable smart matching
- **External Processing**: Optional integration with external scripts for further automation
- **Error Notifications**: Pushover notifications on sync failures
- **Clean Architecture**: Two-file design with zero abstractions and fail-loud behavior

## Setup

1. Clone the repository
```bash
git clone https://github.com/joshroman/granola-obsidian-sync.git
cd granola-obsidian-sync
```

2. Install dependencies
```bash
bun install
```

3. Configure environment
```bash
cp .env.example .env
# Edit .env with your paths and tokens
```

## Configuration

Edit `.env` with required settings:

### Required
- `GRANOLA_AUTH_PATH`: Path to Granola's supabase.json auth file (default: `~/Library/Application Support/Granola/supabase.json`)
- `OBSIDIAN_VAULT_MEETINGS_PATH`: Absolute path to meetings directory in your Obsidian vault

### Optional
- `GRANOLA_MEETINGS_LIMIT`: Number of meetings to fetch from API (default: 50)
- `OWNER_EMAILS`: Comma-separated email(s) to identify which speaker is "Me" in transcripts
- `SYNC_TRANSCRIPT`: Include meeting transcript in Obsidian notes (default: false)
- `TRANSCRIPT_TITLE_FILTER`: Only sync transcripts for meetings with these title keywords (comma-separated, case-insensitive). Example: `"1:1,sync,review"`. Leave blank to use `SYNC_TRANSCRIPT` setting for all meetings
- `PUSHOVER_USER_KEY` & `PUSHOVER_API_TOKEN`: For error notifications
- `ENABLE_MEETING_PROCESSING`: Set to 'true' to enable external script processing
- `VAULT_OPS_SCRIPT_PATH`: Path to external processing script

## Running

### Manual
```bash
bun sync.ts
```

### Scheduled (macOS launchd)

Save this to `~/Library/LaunchAgents/com.user.granola-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.granola-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/joshroman/.bun/bin/bun</string>
        <string>/path/to/granola-obsidian-sync/sync.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/granola-obsidian-sync</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/joshroman/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Minute</key>
            <integer>0</integer>
        </dict>
        <dict>
            <key>Minute</key>
            <integer>30</integer>
        </dict>
    </array>
    <key>StandardOutPath</key>
    <string>/tmp/granola-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/granola-sync.error.log</string>
</dict>
</plist>
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/com.user.granola-sync.plist
```

### Scheduled (Linux cron)

Add to crontab with `crontab -e`:
```bash
*/30 * * * * cd /path/to/granola-obsidian-sync && /usr/local/bin/bun sync.ts >> /tmp/granola-sync.log 2>&1
```

## How It Works

1. **Index Vault**: Scans existing meeting files to build index for deduplication
2. **Authentication**: Reads auth token from Granola app support directory
3. **Fetch Meetings**: Gets processed meetings from Granola API (configurable limit)
4. **Panel Validation**: Only processes meetings that have panels (structured content)
5. **Content Processing**: 
   - Processes transcripts with speaker identification and deduplication
   - Processes panels with template-specific sorting
6. **File Organization**: Creates year/month/day folder structure in Obsidian vault
7. **Smart Filename**: `YYYY-MM-DD HHMM {title} -- {shortId}.md` (Eastern timezone)
8. **Deduplication**: Updates existing scheduled meetings when they become filed
9. **External Processing**: Optionally calls external script for further automation

## File Structure

```
sync.ts                 # Main sync orchestration
transcript-processor.ts # Transcript processing and speaker identification
panel-processor.ts      # Panel content processing
.env                   # Configuration (not tracked)
.env.example          # Configuration template
CLAUDE.md             # Primary guidance for Claude Code (claude.ai/code)
GEMINI.md             # Guidance for Gemini CLI (alternative assistant)
AGENTS.md             # Guidance for OpenAI Codex CLI (alternative assistant)
docs/                 # Additional documentation
└── recommendations.md # Prioritized improvements and bug fixes
temp/                 # temporary files (git ignored)
```

> **Note**: This project is developed primarily with Claude Code, but includes documentation for Gemini and Codex CLI tools for those who prefer alternative assistants or wish to fork the repository.

## Sync Behavior

- **Skips**: Solo meetings, meetings without transcripts/panels, existing files
- **Processes**: Past meetings with panels and transcript content
- **Updates**: Scheduled meetings that become filed meetings
- **Timezone**: All operations use Eastern US timezone for consistency

## Transcript Overrides

Transcripts are always included for:
- **#transcript tag**: Meeting title contains `#transcript` (case-insensitive). Tag is stripped from saved title/filename and added to frontmatter tags.
- **Meet This Moment**: Meetings with titles starting with "Meet This Moment"
- **Mindshift Recovery National Call**: Meetings with titles starting with "Mindshift Recovery National Call"

For all other meetings, transcripts follow `SYNC_TRANSCRIPT` and `TRANSCRIPT_TITLE_FILTER` settings.

## Failure Behavior

- **API Validation**: "0 meetings returned" triggers failure notification
- **Fail-Fast**: Crashes immediately on any error (no retry logic)
- **Notifications**: Sends Pushover alerts on failures if configured
- **Logging**: All sync operations logged with timestamps

## Dependencies

- `bun`: Runtime (TypeScript support)
- `gray-matter`: YAML frontmatter processing
- `dotenv`: Environment variable loading

Total: ~600 lines across 3 focused files with minimal dependencies.

## External Script Task Processing

The specifics of running Claude Code headlessly via an external script are left up to the reader, but here is an example prompt that works reasonably well with both Sonnet and Opus models. Note that this runs in the vault folder itself and there is a custom `CLAUDE.md` and a custom `output-style` that will further modify Claude's behavior.

### Example External Prompt
```
You are an executive assistant in an Obsidian vault at ${VAULT_PATH}

Current date and time: ${CURRENT_DATETIME_ET} 

Your task is to process a meeting following the steps below.

**STEP 1** Analyze the meeting title, date, and content:
- meeting title: ${MEETING_TITLE}
- meeting date: ${MEETING_DATE}
- meeting organizer: ${MEETING_ORGANIZER}
- meeting attendees: ${MEETING_ATTENDEES}
- meeting content: ${MEETING_CONTENT}

**STEP 2** Review the list of valid tags:
- valid tag file: ${TAG_FILE_PATH}

**STEP 3** Update the YAML frontmatter metadata for this meeting:  ${MEETING_FILE}
   - Area: [should be one of #TAG1 #TAG2 #TAG3 based on the meeting content]
   - Tags: add tags as YAML list format: ['#tag1', '#tag2'] - tags must be valid, do not make up new tags
   - Summary: [from the analysis - this should be a concise 2-3 sentence description. avoid phrases like 'this meeting...' or 'You met with...' - every word should add meaning to the summary]  IMPORTANT: Only use straight quotes or apostrophes. This must be valid YAML.
   - Processed: Claude
   - Ensure that the frontmatter is valid YAML format and there are "---" on their own lines at the top and bottom of the frontmatter section

**STEP 4** Identify all  NEXT ACTIONS in the meeting and add them to the body of the meeting as Obsidian tasks:
   - Add all tasks immediately under the "## Tasks" header
   - Use the Obsidian Tasks plugin format: - [ ] {insert task description here}
   - Add a valid tag for the area 
   - Add a valid owner tag corresponding to the person responsible
   - Add the created date at the end using the heavy plus emoji ➕ and the current date in YYYY-MM-DD format
   - if the task seems urgent, add #urgent
   - if the task needs to be done in the next 24 hours, add #today

Your final response must end with exactly:
'PROCESSED: [meeting name]' if successful
'ERROR: [description]' if error occurred
