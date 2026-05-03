#!/usr/bin/env node
/**
 * Postinstall restart-nudge — drops a notice file Claude reads after upgrade.
 *
 * Problem this solves:
 *   When `npm install` runs inside Claude Code (typically because the user
 *   asked Claude to upgrade moflo), the just-installed bits are on disk but
 *   the running session still has the OLD launcher, hooks, MCP server, and
 *   statusline loaded. The launcher only re-reads them on the NEXT
 *   session-start — the upgrade is inert until the user restarts.
 *
 *   The original v4.9.4 design printed a banner to stdout, expecting npm to
 *   relay it. It does not: npm 7+ defaults to `foreground-scripts: false`
 *   and captures install-script stdout/stderr into log files. The banner
 *   never reached Claude. (#856.)
 *
 * Fix:
 *   This script drops `<project>/.moflo/restart-pending.json` on every
 *   relevant install. Claude is instructed (via the moflo CLAUDE.md
 *   injection) to read + surface + delete the file after running
 *   `npm install moflo@*`. No reliance on npm cooperating with stdout.
 *
 *   The banner is still printed to stdout for the rare `--foreground-scripts`
 *   user, and the dedup tracker is preserved so repeat postinstalls of the
 *   same version don't double-write the notice.
 *
 * Files written:
 *   - .moflo/restart-pending.json       (the payload Claude reads)
 *   - .moflo/last-install-banner.json   (dedup tracker, version-stamped)
 *
 * Gating:
 *   - Only fires when CLAUDE_PROJECT_DIR or CLAUDECODE is set; non-Claude
 *     installs and CI stay silent.
 *   - Dedupes by version: same (project, version) pair won't re-write.
 *
 * Failure posture: never blocks an install. Errors are swallowed; exit 0.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform } from 'node:os';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function isClaudeSession() {
  return Boolean(process.env.CLAUDE_PROJECT_DIR || process.env.CLAUDECODE);
}

function consumerProjectRoot() {
  // npm sets INIT_CWD to the original directory where the user ran `npm
  // install` — the consumer's project root, regardless of which package's
  // postinstall is running.
  return process.env.INIT_CWD || process.cwd();
}

function installedVersion() {
  // package.json sits one level above scripts/.
  const pkgPath = resolve(dirname(SCRIPT_PATH), '..', 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || null;
  } catch {
    return null;
  }
}

function readTrackedVersion(trackerPath) {
  if (!existsSync(trackerPath)) return null;
  try {
    return JSON.parse(readFileSync(trackerPath, 'utf-8')).version || null;
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

function buildMessage(version) {
  // Plain-text payload Claude relays verbatim. Names Claude Code explicitly
  // so the assistant frames it as a restart instruction, not a log line.
  return [
    `MoFlo ${version} installed.`,
    '',
    'Please restart Claude Code to load the new MoFlo.',
    '',
    'Hooks, MCP tools, statusline, and the session-start launcher are',
    'loaded once at session-start — the running session is still on the',
    'previous moflo until you exit and reopen Claude Code.',
  ].join('\n');
}

function ttyDevicePath() {
  // Direct TTY write reaches the user's terminal even when npm 7+ captures
  // stdout into log files (#867). POSIX has /dev/tty; Windows has the CON
  // device. If neither resolves, the helper silently no-ops.
  return platform() === 'win32' ? '\\\\.\\CON' : '/dev/tty';
}

function writeToTty(text) {
  // Best-effort terminal write. Returns true on success so the caller knows
  // not to also fall back to stdout (avoids double-printing when both work).
  // CI / piped npm output / no-controlling-terminal cases trip the catch
  // and return false — postinstall MUST never block install over a missing
  // TTY, so all errors are swallowed.
  let fd = null;
  try {
    fd = openSync(ttyDevicePath(), 'w');
    writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* fd already closed or failed to open */ }
    }
  }
}

function bannerText(version, message) {
  const border = '═'.repeat(67);
  return `\n${border}\n  MoFlo ${version} installed.\n\n  ⚠ ${message.split('\n')[2]}\n${border}\n\n`;
}

function printBanner(version, message) {
  // Two-channel print: TTY-direct first (works around npm's stdio capture
  // in v7+ default `foreground-scripts: false` mode), stdout second as the
  // belt-and-braces fallback for `--foreground-scripts` users and CI logs.
  // Pre-#867 only stdout was attempted, which npm captured into log files
  // the user never sees — the notice file existed solely to compensate.
  const text = bannerText(version, message);
  const ttyOk = writeToTty(text);
  if (!ttyOk) {
    try { process.stdout.write(text); } catch { /* stdout broken — give up silently */ }
  }
}

function run() {
  if (!isClaudeSession()) return { fired: false, reason: 'not-claude' };

  const version = installedVersion();
  if (!version) return { fired: false, reason: 'no-version' };

  const projectRoot = consumerProjectRoot();
  const trackerPath = join(projectRoot, '.moflo', 'last-install-banner.json');
  const noticePath = join(projectRoot, '.moflo', 'restart-pending.json');

  const lastShown = readTrackedVersion(trackerPath);
  if (lastShown === version) return { fired: false, reason: 'already-shown' };

  const writtenAt = new Date().toISOString();
  const message = buildMessage(version);

  writeJson(noticePath, { version, writtenAt, message });
  writeJson(trackerPath, { version, shownAt: writtenAt });

  printBanner(version, message);
  return { fired: true, version, noticePath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch { /* never block install */ }
  process.exit(0);
}
