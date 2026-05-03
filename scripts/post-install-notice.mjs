#!/usr/bin/env node
/**
 * Postinstall restart-nudge banner.
 *
 * When `npm install` runs inside Claude Code (typically because the user
 * asked Claude to upgrade moflo), the just-installed bits are sitting on
 * disk but the running session still has the OLD launcher, hooks, MCP
 * server, and statusline loaded. The session-start launcher only re-reads
 * them on the NEXT session-start — so the upgrade is inert until the user
 * exits and reopens Claude Code.
 *
 * This script prints a banner that npm relays back to Claude as the install
 * stdout. The phrasing names Claude Code explicitly so the assistant
 * surfaces it to the user as a restart prompt.
 *
 * Gating:
 *   - Only prints when CLAUDE_PROJECT_DIR or CLAUDECODE is set (avoids
 *     noise on CI and non-Claude installs).
 *   - Dedupes by version: only prints once per (consumer-project, version)
 *     pair, so unrelated `npm install` runs that re-trigger postinstall
 *     don't re-spam the banner. Tracker lives at
 *     `<project>/.moflo/last-install-banner.json`.
 *
 * Failure posture: never blocks an install. Errors are swallowed; exit 0.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function readLastBanner(trackerPath) {
  if (!existsSync(trackerPath)) return null;
  try {
    return JSON.parse(readFileSync(trackerPath, 'utf-8')).version || null;
  } catch {
    return null;
  }
}

function writeLastBanner(trackerPath, version) {
  try {
    mkdirSync(dirname(trackerPath), { recursive: true });
    writeFileSync(trackerPath, JSON.stringify({
      version,
      shownAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* non-fatal */ }
}

function printBanner(version) {
  // Phrased to name Claude Code by name so the assistant surfaces it as a
  // restart instruction rather than a generic install log line.
  const lines = [
    '',
    '═══════════════════════════════════════════════════════════════════',
    `  MoFlo ${version} installed.`,
    '',
    '  ⚠ Claude Code: please restart your session to load the new MoFlo.',
    '',
    '  Hooks, MCP tools, statusline, and the session-start launcher are',
    '  loaded once at session-start — the running session is still on',
    '  the previous moflo until you exit and reopen Claude Code.',
    '═══════════════════════════════════════════════════════════════════',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

function run() {
  if (!isClaudeSession()) return { fired: false, reason: 'not-claude' };

  const version = installedVersion();
  if (!version) return { fired: false, reason: 'no-version' };

  const projectRoot = consumerProjectRoot();
  const trackerPath = join(projectRoot, '.moflo', 'last-install-banner.json');
  const lastShown = readLastBanner(trackerPath);
  if (lastShown === version) return { fired: false, reason: 'already-shown' };

  printBanner(version);
  writeLastBanner(trackerPath, version);
  return { fired: true, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch { /* never block install */ }
  process.exit(0);
}
