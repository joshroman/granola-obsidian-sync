# Repository Guidelines

## Project Structure & Module Organization
- `sync.ts`: Orchestrates Granola → Obsidian sync (entry point).
- `transcript-processor.ts`: Cleans, deduplicates, and labels transcript text.
- `panel-processor.ts`: Converts Granola HTML panels to Markdown sections.
- `.env`/`.env.example`: Runtime configuration (paths, flags, tokens).
- `temp/`: Scratch area; repo ignores contents except `.gitkeep`.
- `docs/`: Additional documentation; see `docs/recommendations.md` for guidance and tips.
- `CLAUDE.md`: Usage notes for the Claude CLI.
- `GEMINI.md`: Usage notes for the Gemini CLI.

## Build, Test, and Development Commands
- `bun install`: Install dependencies.
- `bun run sync` or `bun run sync.ts`: Run a full sync once.
- Quick verify: set `OBSIDIAN_VAULT_MEETINGS_PATH` to a throwaway folder, then run the sync and inspect generated Markdown.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM), strict mode, no emit; executed by Bun.
- Indentation: 2 spaces; line length reasonable (no hard wrap).
- Names: `camelCase` for vars/functions, `PascalCase` for types/interfaces, `kebab-case` filenames (`*.ts`).
- Patterns: small, single-purpose functions; fail-fast error handling; minimal abstractions.

## Testing Guidelines
- No formal test harness in repo. Validate changes by pointing the vault path to a temp directory and reviewing outputs.
- If adding complex logic, include focused unit tests (e.g., `__tests__/transcript-processor.test.ts`) using Bun’s test API or a lightweight runner; keep tests fast and deterministic.
- Prefer table-driven tests for text transforms and edge cases (duplicates, empty panels, time windows).

## Commit & Pull Request Guidelines
- Commits: follow Conventional Commits (`feat:`, `fix:`, `docs:`, optional `[scope]`). Keep messages imperative and concise.
- PRs must include: purpose/summary, linked issues, config changes (env vars/flags), screenshots or log excerpts, and before/after examples of generated filenames like `YYYY-MM-DD HHMM {title} -- {shortId}.md`.
- Touch only related files; keep diffs small and reversible.

## Security & Configuration Tips
- Do not commit `.env`, tokens, or real vault paths (`.gitignore` enforces this).
- Required env: `GRANOLA_API_KEY`, `OBSIDIAN_VAULT_MEETINGS_PATH`. Optional: `GRANOLA_MEETINGS_LIMIT`, `SYNC_TRANSCRIPT`, Pushover keys, external processing flags.
- When experimenting, use a disposable vault path to avoid overwriting real notes.
