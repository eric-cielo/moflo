/**
 * Tests for the Embedding hygiene auto-fix gate (#1046).
 *
 * Pre-#1046 the autoFixCheck for "Embedding hygiene" fell through to a
 * generic shell-out: `npx moflo embeddings init`. The migration child
 * correctly re-embedded dirty rows, but a long-lived moflo process
 * (daemon, MCP server) holding a stale sql.js in-memory snapshot would
 * flush back the legacy state seconds later — the repair was silently
 * undone, and healer reported a false success.
 *
 * The fix: when a daemon is alive, skip the auto-fix and surface a
 * "restart Claude Code" message that points to the existing session-start
 * launcher repair path. When no daemon is running (CI, fresh shell,
 * post-`daemon stop`), invoke the migration in-process directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hoisted mocks. These must be set up via `vi.mock` (which Vitest hoists
// above all imports) rather than `vi.doMock` + dynamic re-import, because
// `autoFixCheck` is loaded once and cached by the worker — a doMock+reimport
// pattern silently no-ops once the cache is warm. See PR review on #1046.
vi.mock('../../services/daemon-lock.js', () => ({
  getDaemonLockHolder: vi.fn(),
}));
vi.mock('../../services/embeddings-migration.js', () => ({
  runEmbeddingsMigrationIfNeeded: vi.fn(),
}));

import { autoFixCheck } from '../../commands/doctor-fixes.js';
import { getDaemonLockHolder } from '../../services/daemon-lock.js';
import { runEmbeddingsMigrationIfNeeded } from '../../services/embeddings-migration.js';

const mockGetHolder = vi.mocked(getDaemonLockHolder);
const mockMigrate = vi.mocked(runEmbeddingsMigrationIfNeeded);

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-hygiene-fix-'));
  process.chdir(tmpDir);
  mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
  mockGetHolder.mockReset();
  mockMigrate.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

const hygieneCheck = {
  name: 'Embedding hygiene',
  status: 'warn' as const,
  message: '277 row(s) with embedding_model=local AND embedding IS NULL',
  // Vestigial — the new code path inside `autoFixCheck` does NOT read
  // `check.fix` for this check. Kept non-empty so the early `if
  // (!check.fix) return false` guard at the top of `autoFixCheck` lets us
  // reach the dispatch.
  fix: 'session-start launcher',
};

describe('Embedding hygiene auto-fix — daemon-aware skip (#1046)', () => {
  it('refuses to run when a daemon is alive (returns false, never invokes migration)', async () => {
    mockGetHolder.mockReturnValue(process.pid);

    const result = await autoFixCheck(hygieneCheck);

    expect(result).toBe(false);
    expect(mockMigrate).not.toHaveBeenCalled();
  });

  it('runs the migration in-process when no daemon is alive', async () => {
    mockGetHolder.mockReturnValue(null);
    mockMigrate.mockResolvedValue(true);

    const result = await autoFixCheck(hygieneCheck);

    expect(mockGetHolder).toHaveBeenCalledTimes(1);
    expect(mockMigrate).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('returns false when the migration runs but completes with no work (no eligible rows)', async () => {
    mockGetHolder.mockReturnValue(null);
    mockMigrate.mockResolvedValue(false);

    const result = await autoFixCheck(hygieneCheck);

    expect(result).toBe(false);
  });

  it('returns false when the migration throws — does not bubble up', async () => {
    mockGetHolder.mockReturnValue(null);
    mockMigrate.mockRejectedValue(new Error('embed service unavailable'));

    const result = await autoFixCheck(hygieneCheck);

    expect(result).toBe(false);
  });
});
