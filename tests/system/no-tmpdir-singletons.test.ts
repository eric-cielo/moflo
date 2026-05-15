/**
 * Regression guard for #1151 — no MCP PID/log file written to `os.tmpdir()`.
 *
 * Background: pre-#1151, `src/cli/mcp-server.ts` wrote
 * `<tmpdir>/claude-flow-mcp.{pid,log}`. Because `os.tmpdir()` is shared across
 * every moflo consumer on the machine, two projects' MCP servers raced to
 * overwrite the same PID file — and `flo mcp stop` then killed whichever
 * project happened to write last (potentially the wrong one). Same bug class
 * as #1145 (cross-project daemon port collision) at a different layer.
 *
 * Fix shape: PID/log moved to `<projectRoot>/.moflo/mcp-server.{pid,log}`
 * resolved through the unified `findProjectRoot`. The legacy filename is
 * referenced only by the abandoned-PID cleanup path in `mcp-server.ts`. Any
 * NEW file writing a moflo state file under `os.tmpdir()` reintroduces the
 * cross-project singleton hazard and fails this test.
 *
 * Allowlist intentionally narrow:
 *   - `src/cli/mcp-server.ts` — owns the `LEGACY_TMPDIR_PID_FILE` constant
 *     used only to clean up stale pre-#1151 files. Never written to.
 *   - This test (it must reference the literal to detect it).
 *   - `docs/internal/1145-daemon-port-collision-analysis.md` — historical
 *     audit doc that names the bug.
 *   - `.gitignore` — the legacy `claude-flow-mcp-wrapper` entry from the
 *     pre-rename era.
 *
 * Any new match fails. Fix by routing through `findProjectRoot()` and
 * writing under `<projectRoot>/.moflo/` like the daemon, lock, and indexer.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Paths allowed to reference `claude-flow-mcp.{pid,log}`. Forward-slashes only. */
const ALLOWLIST = new Set<string>([
  'src/cli/mcp-server.ts',
  'tests/system/no-tmpdir-singletons.test.ts',
  'docs/internal/1145-daemon-port-collision-analysis.md',
  '.gitignore',
]);

describe('no-tmpdir-singletons regression guard (#1151)', () => {
  it('no shipped source references claude-flow-mcp.{pid,log} outside the allowlist', () => {
    let raw = '';
    try {
      raw = execSync(
        'git grep -nE "claude-flow-mcp\\.(pid|log)" -- "src/**" "bin/**" "harness/**" "tests/**" "docs/**" "*.md" ".claude/**" ".gitignore"',
        { encoding: 'utf-8', cwd: REPO_ROOT, timeout: 30_000 },
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 1) return; // No matches — guard passes.
      throw err;
    }

    const violations: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const file = line.slice(0, colonIdx).split(/[\\/]/).join('/');
      if (ALLOWLIST.has(file)) continue;
      violations.push(line);
    }

    if (violations.length > 0) {
      const message = [
        `Found ${violations.length} reference(s) to the legacy tmpdir MCP PID/log filenames outside the allowlist.`,
        'Route through findProjectRoot() and write under <projectRoot>/.moflo/ instead.',
        'Violations:',
        ...violations.slice(0, 20),
      ].join('\n');
      expect(violations, message).toEqual([]);
    }
  });

  it('no shipped source writes a moflo state file under os.tmpdir()', () => {
    // Catch the bug class one step earlier than the filename guard above:
    // ANY `os.tmpdir()` use combined with a moflo/claude-flow PID/log/state
    // filename on the same source line, outside the allowlist.
    let raw = '';
    try {
      raw = execSync(
        'git grep -nE "os\\.tmpdir\\(\\).*(moflo|claude-flow).*(pid|log|state|db)" -- "src/**" "bin/**"',
        { encoding: 'utf-8', cwd: REPO_ROOT, timeout: 30_000 },
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 1) return;
      throw err;
    }

    const violations: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const file = line.slice(0, colonIdx).split(/[\\/]/).join('/');
      if (ALLOWLIST.has(file)) continue;
      violations.push(line);
    }

    if (violations.length > 0) {
      const message = [
        `Found ${violations.length} new os.tmpdir() reference(s) for moflo state outside the allowlist.`,
        'Per-project state must live under <projectRoot>/.moflo/ (resolved via findProjectRoot).',
        'Violations:',
        ...violations.slice(0, 20),
      ].join('\n');
      expect(violations, message).toEqual([]);
    }
  });
});
