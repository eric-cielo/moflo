/**
 * Regression guard for #1145 — no fixed `3117` port literal outside the
 * central resolver.
 *
 * Background: pre-#1145, two separate `DEFAULT_*_PORT = 3117` constants
 * (server in `daemon-dashboard.ts`, client in `daemon-write-client.ts`)
 * produced silent cross-project DB routing when two moflo daemons collided.
 * The fix collapses both to one `daemon-port.ts` module. This test pins the
 * collapse so a future drive-by edit can't reintroduce the bug class.
 *
 * Allowlist intentionally narrow:
 *   - `src/cli/services/daemon-port.ts` (the canonical resolver — owns
 *     `LEGACY_DEFAULT_PORT = 3117`)
 *   - `bin/lib/daemon-port.mjs` (JS twin — same constant)
 *   - This file (it must reference the literal to fail-detect it)
 *   - `docs/internal/1145-daemon-port-collision-analysis.md` (audit doc)
 *   - `CHANGELOG.md` advisory (records the migration)
 *   - existing test fixtures and the issue body — pattern is "3117" inside
 *     a string literal in a test or doc; case-by-case allowlist below.
 *
 * Any NEW file matching `3117` will fail the test. The fix is to route
 * through `resolveProjectPort` / `resolveClientPort` / `serverPortCandidates`.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Paths allowed to reference the literal `3117`. Forward-slashes only. */
const ALLOWLIST = new Set<string>([
  'src/cli/services/daemon-port.ts',
  'bin/lib/daemon-port.mjs',
  // Dogfood mirror twin of bin/lib/daemon-port.mjs — same LEGACY_DEFAULT_PORT
  // constant. .claude/scripts/ is the byte-for-byte mirror a consumer's launcher
  // syncs from bin/ (#1185 restored it after dogfood drift), so it carries the
  // same allowlisted resolver.
  '.claude/scripts/lib/daemon-port.mjs',
  'tests/system/no-fixed-3117-port.test.ts',
  'docs/internal/1145-daemon-port-collision-analysis.md',
  'CHANGELOG.md',
  // Existing test/doc fixtures that reference the legacy port as historical
  // context. NEW additions to this list need a PR comment justifying why
  // the literal can't route through the resolver.
  'src/cli/__tests__/daemon-dashboard.test.ts',
  'src/cli/__tests__/memory/daemon-write-client.test.ts',
  'src/cli/__tests__/memory/store-entry-routing.test.ts',
  'src/cli/__tests__/services/daemon-port.test.ts',
  'src/cli/commands/daemon.ts',
  'harness/consumer-smoke/lib/checks.mjs',
  'harness/consumer-smoke/run.mjs',
  'harness/consumer-smoke/run-populated.mjs',
  'README.md',
  '.claude/guidance/internal/dogfooding.md',
  '.claude/guidance/internal/testing-performance.md',
  'docs/linkedin-luminarium.html',
]);

describe('no-fixed-3117 regression guard (#1145)', () => {
  it('no shipped source references the literal 3117 outside the allowlist', () => {
    // Use git grep so we only scan tracked files. Exit code 1 = no matches
    // (success); 0 = matches found.
    let raw = '';
    try {
      raw = execSync('git grep -nF 3117 -- "src/**" "bin/**" "harness/**" "tests/**" "docs/**" "*.md" ".claude/**"', {
        encoding: 'utf-8',
        cwd: REPO_ROOT,
        timeout: 30_000,
      });
    } catch (err) {
      // git grep exits 1 when no matches; treat as "all clean".
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
        `Found ${violations.length} reference(s) to the legacy port 3117 outside the allowlist.`,
        'Route through src/cli/services/daemon-port.ts (resolveProjectPort / resolveClientPort / serverPortCandidates).',
        'Violations:',
        ...violations.slice(0, 20),
      ].join('\n');
      expect(violations, message).toEqual([]);
    }
  });
});
