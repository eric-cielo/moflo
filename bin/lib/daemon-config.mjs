/**
 * Daemon spawn-gate config reader for bin/ scripts.
 *
 * Mirrors the TypeScript `daemon.auto_start` behavior in src/cli/index.ts but
 * reads from .claude/settings.json (claudeFlow.daemon.autoStart) — that's the
 * Claude-Code-facing setting and the one the SessionStart hook surface
 * documents to users. moflo.yaml's daemon.auto_start is a separate, parallel
 * gate honored by the CLI's `maybeAutoStartDaemon`.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Returns true if the daemon should auto-start at session-start.
 *
 * Default is `true` (preserves prior behavior). Returns `false` only when
 * `.claude/settings.json` has `claudeFlow.daemon.autoStart === false`.
 * Missing file, missing key, or malformed JSON all default to `true` so a
 * broken config can't silently disable the daemon.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {boolean}
 */
export function shouldDaemonAutoStart(projectRoot) {
  try {
    const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return true;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.claudeFlow?.daemon?.autoStart !== false;
  } catch {
    return true;
  }
}
