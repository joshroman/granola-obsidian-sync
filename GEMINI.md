# Granola to Obsidian Sync

## Project Overview

This project is a TypeScript-based command-line tool for synchronizing meeting notes from the Granola API to an Obsidian vault. It is designed to be run with the Bun runtime.

The tool fetches past meetings, processes their content, and creates well-structured Markdown files in a specified Obsidian vault. It handles meeting transcripts by identifying speakers ("Me" vs. "Them"), removing duplicates, and grouping dialogue. It also processes "panels," which are structured content from Granola, into clean Markdown.

A key feature is its ability to deduplicate meetings, updating scheduled meetings when they become completed ("filed") meetings. The tool is configured via a `.env` file and can optionally trigger external scripts for further automation, such as sending notifications via Pushover.

The architecture is simple and explicit, with three main files:
- `sync.ts`: The main orchestration script.
- `transcript-processor.ts`: Handles all logic related to cleaning and formatting meeting transcripts.
- `panel-processor.ts`: Manages the conversion of HTML panel content into Markdown.

## Project Documentation

This repository contains several documentation files to aid development and usage with different AI assistants:

- `README.md`: The primary documentation for the project.
- `GEMINI.md`: (This file) Notes and context for Google's Gemini CLI.
- `CLAUDE.md`: Notes and context for Anthropic's Claude CLI.
- `AGENTS.md`: Notes and context for OpenAI's Codex CLI.
- `docs/recommendations.md`: A list of prioritized bug fixes and feature improvements.

## Building and Running

### Prerequisites
- [Bun](https://bun.sh/) must be installed.

### Installation
Install the dependencies using Bun:
```bash
bun install
```

### Configuration
1.  Copy the example environment file:
    ```bash
    cp .env.example .env
    ```
2.  Edit the `.env` file with your specific paths and API tokens. The following variables are required:
    *   `GRANOLA_API_KEY`: Granola public API key (`grn_...`) from Settings → Connectors → API keys.
    *   `OBSIDIAN_VAULT_MEETINGS_PATH`: The absolute path to the meetings directory within your Obsidian vault.

### Running the Sync
Execute the main sync script:
```bash
bun run sync
```
Alternatively, you can run the script directly:
```bash
bun sync.ts
```

The `README.md` also provides instructions for setting up scheduled execution using `launchd` on macOS or `cron` on Linux.

## Development Conventions

*   **Language**: The project is written entirely in TypeScript.
*   **Runtime**: It uses Bun as the JavaScript runtime and package manager.
*   **Configuration**: All configuration is managed through environment variables loaded from a `.env` file using the `dotenv` library.
*   **Modularity**: The codebase is organized into distinct modules with clear responsibilities: `sync.ts` for orchestration, `transcript-processor.ts` for transcript logic, and `panel-processor.ts` for panel content conversion.
*   **Dependencies**:
    *   `dotenv`: For loading environment variables.
    *   `gray-matter`: For creating and parsing YAML frontmatter in Markdown files.
    *   `cheerio` and `turndown`: For converting HTML content from Granola panels into Markdown.
*   **Error Handling**: The tool is designed to "fail-loud." It will crash on any significant error and can be configured to send Pushover notifications on failure.
*   **Code Style**: The code is formatted and follows standard TypeScript conventions. It is strictly typed, as defined in `tsconfig.json`.