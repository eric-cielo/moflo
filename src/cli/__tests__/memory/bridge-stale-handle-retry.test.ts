/**
 * Issue #1123: stale-handle race in `withDb`.
 *
 * Reproduction context — concurrent doctor probes (`checkMemoryAccessFunctional`,
 * `checkHiveMindFunctional`, etc.) run in `Promise.allSettled`. Each calls
 * `withDb`, which front-loads `checkBridgeCoherence`. If probe B's coherence
 * check observes another writer's mtime advance, it calls `shutdownBridge()`
 * — closing the registry's underlying `DatabaseSync`. Probe A has already
 * resolved its `ctx` from the now-closed registry, so A's `fn(ctx, ...)`
 * throws node:sqlite's `ERR_INVALID_STATE: database is not open`.
 *
 * Pre-fix behaviour: `withDb` caught the error, logged
 * `[moflo] bridge operation failed: database is not open` to stderr, and
 * returned `null`. Callers fell back to direct-write (so no data loss), but
 * stderr noise corrupted `healer --json --fix` output and masked a real race.
 *
 * Post-fix contract: bounded one-shot retry against a freshly-acquired
 * registry, matching the shape of `withBusyRetry` for `SQLITE_BUSY`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import {
  _resetProjectRootForTest,
  shutdownBridge,
  withDb,
} from '../../memory/bridge-core.js';
import { storeEntry } from '../../memory/memory-initializer.js';

function makeStaleHandleError(): Error {
  const err = new Error('database is not open');
  (err as Error & { code: string }).code = 'ERR_INVALID_STATE';
  return err;
}

describe('withDb stale-handle retry (#1123)', () => {
  let tempDir: string;
  let originalProjectDir: string | undefined;
  let stderrLines: string[];
  let origConsoleError: typeof console.error;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'moflo-1123-'));
    fs.mkdirSync(path.join(tempDir, '.moflo'), { recursive: true });
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tempDir;
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

    await shutdownBridge();
    _resetProjectRootForTest();

    stderrLines = [];
    origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      stderrLines.push(args.map((a) => String(a)).join(' '));
    };

    // Anchor the bridge against a real DB so `withDb` has a registry to
    // re-acquire. Without this initial write, `getRegistry` may resolve to
    // null on the retry path and we'd be testing the wrong failure mode.
    const seed = await storeEntry({ key: 'seed', value: 's', namespace: 'ns' });
    if (!seed.success) {
      throw new Error(`test setup failed — seed write rejected: ${seed.error ?? 'unknown'}`);
    }
  });

  afterEach(async () => {
    console.error = origConsoleError;
    await shutdownBridge();
    _resetProjectRootForTest();
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    delete process.env.MOFLO_DISABLE_DAEMON_ROUTING;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('retries once with a fresh registry when fn throws stale-handle error', async () => {
    let calls = 0;
    const result = await withDb<{ ok: true }>(undefined, async () => {
      calls++;
      if (calls === 1) throw makeStaleHandleError();
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(stderrLines.filter((s) => s.includes('bridge operation failed'))).toEqual([]);
  });

  it('recognises plain "database is not open" message even without ERR_INVALID_STATE code', async () => {
    let calls = 0;
    const result = await withDb<{ ok: true }>(undefined, async () => {
      calls++;
      if (calls === 1) throw new Error('database is not open');
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('gives up after one retry — bounded so a broken bridge still surfaces', async () => {
    let calls = 0;
    const result = await withDb<{ ok: true }>(undefined, async () => {
      calls++;
      throw makeStaleHandleError();
    });

    expect(result).toBeNull();
    expect(calls).toBe(2);
    expect(
      stderrLines.some((s) => s.includes('bridge operation failed: database is not open')),
    ).toBe(true);
  });

  it('does not retry on unrelated errors (no semantic change for non-race failures)', async () => {
    let calls = 0;
    const result = await withDb<{ ok: true }>(undefined, async () => {
      calls++;
      throw new Error('something else entirely');
    });

    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(
      stderrLines.some((s) => s.includes('bridge operation failed: something else entirely')),
    ).toBe(true);
  });
});
