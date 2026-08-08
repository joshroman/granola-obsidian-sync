/**
 * Environment loading, in one place.
 *
 * Import this first from any entrypoint. Module-level constants elsewhere are
 * evaluated when their module is imported, and ES imports are hoisted above the
 * importing module's body — so loading config inside sync.ts meant anything
 * transcript-processor.ts read at import time saw an unloaded environment and
 * silently fell back to defaults. Doing it here means the environment is
 * complete before any other module body runs.
 *
 * Project .env wins; the shared automation config only fills in what it omits.
 */

import 'dotenv/config';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const resolvePath = (p: string) =>
  p.startsWith('~') ? join(homedir(), p.slice(1)) : p;

const SHARED_ENV_PATH = resolvePath(
  process.env.JOSH_AUTOMATIONS_ENV || '~/.config/josh-automations/.env'
);

if (existsSync(SHARED_ENV_PATH)) {
  dotenv.config({ path: SHARED_ENV_PATH });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it in .env or ${SHARED_ENV_PATH}.`
    );
  }
  return value;
}
