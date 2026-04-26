// Daemon spawn-gate for bin/ scripts. Reads .claude/settings.json — the
// Claude-Code-facing surface. moflo.yaml's daemon.auto_start is a separate
// parallel gate honored by src/cli/index.ts maybeAutoStartDaemon.

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// Default-true on missing file, missing key, or malformed JSON so a broken
// config can't silently disable the daemon.
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
