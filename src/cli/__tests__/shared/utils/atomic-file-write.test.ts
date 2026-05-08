/**
 * Unit tests for `atomicWriteFileSync` — the temp-file + rename helper that
 * protects DB/config files from mid-write corruption (#548, #564).
 *
 * Covers the three failure modes a real SIGINT mid-write can produce:
 *   1. write itself throws (e.g. ENOSPC) — original intact, temp cleaned up
 *   2. rename throws (e.g. EACCES, EPERM) — original intact, temp cleaned up
 *   3. both writes succeed — new content on target, no temp left behind
 *
 * Failure-path cases inject a fake fs (ESM doesn't let us spy on `node:fs`
 * exports), while happy-path cases use the real filesystem under `os.tmpdir()`.
 *
 * Cross-platform: stays on `node:fs` sync APIs and `os.tmpdir()` per
 * `feedback_cross_platform_mandatory`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  atomicWriteFileSync,
  type AtomicWriteFs,
} from '../../../shared/utils/atomic-file-write.js';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds file handles briefly — non-fatal for tests */
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moflo-atomic-'));
  tmpDirs.push(dir);
  return dir;
}

describe('atomicWriteFileSync (real fs)', () => {
  it('writes new content to the target path', () => {
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');

    atomicWriteFileSync(target, Buffer.from('hello'));

    expect(readFileSync(target, 'utf8')).toBe('hello');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('replaces existing target content atomically', () => {
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');
    writeFileSync(target, 'original');

    atomicWriteFileSync(target, Buffer.from('replaced'));

    expect(readFileSync(target, 'utf8')).toBe('replaced');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('accepts a Uint8Array directly without Buffer.from wrapping (#564)', () => {
    // db.export() returns a Uint8Array — the helper must accept it as-is
    // so callers don't need a Buffer.from(...) copy.
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    atomicWriteFileSync(target, payload);

    const read = readFileSync(target);
    expect(read.length).toBe(4);
    expect(read[0]).toBe(0xde);
    expect(read[3]).toBe(0xef);
  });

  it('leaves the target immediately readable after return (#1015)', () => {
    // After atomicWriteFileSync returns, openSync(target, 'r') must succeed
    // *now* — no retry needed. On Windows this is what closes the AV-settle
    // race. On POSIX it's a no-op assertion (rename was already atomic).
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');

    atomicWriteFileSync(target, Buffer.from('settled'));

    const fd = openSync(target, 'r');
    try {
      // No-op — the open succeeding is the signal.
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(target, 'utf8')).toBe('settled');
  });

  it('uses a process-unique temp path so concurrent writers cannot clobber tmp', async () => {
    // 50 concurrent writers race for the same target. Each writes a complete
    // parseable JSON payload tagged with its writer ID. The destination must
    // always end up with exactly one writer's full payload — never a mix.
    const dir = makeTmpDir();
    const target = join(dir, 'concurrent.json');

    const writers = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          atomicWriteFileSync(target, JSON.stringify({ writer: i, payload: 'x'.repeat(2048) }));
        } catch {
          /* rename-race losers throw; expected under last-writer-wins semantics */
        }
      }),
    );
    await Promise.all(writers);

    const parsed = JSON.parse(readFileSync(target, 'utf8'));
    expect(typeof parsed.writer).toBe('number');
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(50);
    expect(parsed.payload).toBe('x'.repeat(2048));

    // No leftover .tmp.* files — the helper either renamed them or unlinked
    // them on failure. Stale tmp files would silently leak disk over time.
    const stragglers = readdirSync(dir).filter(f => f.startsWith('concurrent.json.tmp.'));
    expect(stragglers).toEqual([]);
  });
});

describe('atomicWriteFileSync (injected fs)', () => {
  it('leaves original intact and cleans up temp when writeFileSync throws mid-write', () => {
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');
    writeFileSync(target, 'original');

    // Simulate SIGINT: the syscall starts, a partial temp file materialises,
    // then the process is interrupted. Cleanup must remove the partial temp.
    const fs: AtomicWriteFs = {
      writeFileSync: (p, d) => {
        writeFileSync(p, d);
        throw new Error('EINTR: interrupted system call');
      },
      renameSync,
      unlinkSync,
    };

    expect(() => atomicWriteFileSync(target, Buffer.from('replaced'), fs)).toThrow(
      /EINTR/,
    );
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('leaves original intact and cleans up temp when renameSync throws', () => {
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');
    writeFileSync(target, 'original');

    const fs: AtomicWriteFs = {
      writeFileSync,
      renameSync: () => {
        throw new Error('EPERM: operation not permitted');
      },
      unlinkSync,
    };

    expect(() => atomicWriteFileSync(target, Buffer.from('replaced'), fs)).toThrow(
      /EPERM/,
    );
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('tolerates missing temp when writeFileSync errors before creating it', () => {
    // ENOSPC-style failure: the temp never got written. Cleanup must not
    // re-throw ENOENT, otherwise the real write error would be masked.
    const dir = makeTmpDir();
    const target = join(dir, 'data.bin');
    writeFileSync(target, 'original');

    const fs: AtomicWriteFs = {
      writeFileSync: () => {
        throw new Error('ENOSPC: no space left on device');
      },
      renameSync,
      unlinkSync,
    };

    expect(() => atomicWriteFileSync(target, Buffer.from('replaced'), fs)).toThrow(
      /ENOSPC/,
    );
    expect(readFileSync(target, 'utf8')).toBe('original');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('does not mask the original error if cleanup itself throws', () => {
    // If the temp cleanup fails too (unlikely but possible), the primary
    // write/rename error is still what surfaces. This is the contract —
    // cleanup failures must never shadow the real cause.
    const fs: AtomicWriteFs = {
      writeFileSync: () => {
        throw new Error('EACCES: permission denied');
      },
      renameSync,
      unlinkSync: () => {
        throw new Error('cleanup exploded');
      },
    };

    expect(() => atomicWriteFileSync('/irrelevant', Buffer.from('x'), fs)).toThrow(
      /EACCES/,
    );
  });
});

describe.runIf(process.platform === 'win32')(
  'atomicWriteFileSync — Windows post-rename verify (#1015)',
  () => {
    it('tolerates one transient EBUSY in the post-rename open probe', () => {
      // Simulate the AV-scan window: the first open after rename throws EBUSY,
      // the second succeeds. The helper must absorb this transparently — no
      // throw, target intact with new content.
      const dir = makeTmpDir();
      const target = join(dir, 'data.bin');

      let openAttempts = 0;
      const fs: AtomicWriteFs = {
        writeFileSync,
        renameSync,
        unlinkSync,
        openSync: ((path: Parameters<typeof openSync>[0], flags: Parameters<typeof openSync>[1]) => {
          openAttempts++;
          if (openAttempts === 1) throw new Error('EBUSY: resource busy or locked');
          return openSync(path, flags);
        }) as typeof openSync,
        closeSync,
      };

      atomicWriteFileSync(target, Buffer.from('settled'), fs);

      expect(openAttempts).toBeGreaterThanOrEqual(2);
      expect(readFileSync(target, 'utf8')).toBe('settled');
    });

    it('returns (does not throw) when the verify deadline elapses', () => {
      // If the AV window outlasts our budget, the rename DID succeed — the
      // data is on disk and the next reader will eventually see it. The
      // helper must not throw on verify timeout, only log+return.
      const dir = makeTmpDir();
      const target = join(dir, 'data.bin');

      let openAttempts = 0;
      const fs: AtomicWriteFs = {
        writeFileSync,
        renameSync,
        unlinkSync,
        openSync: (() => {
          openAttempts++;
          throw new Error('EBUSY: resource busy or locked');
        }) as typeof openSync,
        closeSync,
      };

      expect(() => atomicWriteFileSync(target, Buffer.from('settled'), fs)).not.toThrow();
      // The loop actually retried — proves the deadline gating worked rather
      // than the function returning after one failed probe.
      expect(openAttempts).toBeGreaterThan(1);
      // Rename still happened — the file is on disk via the real renameSync.
      expect(readFileSync(target, 'utf8')).toBe('settled');
    });
  },
);
