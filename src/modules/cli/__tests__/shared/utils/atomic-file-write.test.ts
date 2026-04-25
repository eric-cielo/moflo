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
  existsSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  atomicWriteFileSync,
  type AtomicWriteFs,
} from '../../../src/shared/utils/atomic-file-write.js';

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
