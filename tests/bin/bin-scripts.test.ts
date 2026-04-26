/**
 * Smoke tests for bin/ scripts.
 *
 * Verifies that each script:
 * 1. Exists on disk
 * 2. Parses as valid JS/ESM (node --check)
 *
 * Does NOT execute the scripts (they have side effects).
 * Follows the pattern established in gate-helpers.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');

/** Run `node --check <file>` and return whether it succeeded. */
function syntaxCheck(file: string): { ok: boolean; error?: string } {
  try {
    // Spawning `node --check` under cumulative isolation-batch load can
    // exceed a tight 5 s ceiling on Windows; the check itself is fast,
    // it's just the child-process spin-up that's contended.
    execFileSync('node', ['--check', file], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.stderr || err.message };
  }
}

describe('bin/cli.js', () => {
  const file = resolve(BIN, 'cli.js');

  it('exists on disk', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('parses as valid JS', () => {
    const result = syntaxCheck(file);
    expect(result.ok).toBe(true);
  });
});

describe('bin/hooks.mjs', () => {
  const file = resolve(BIN, 'hooks.mjs');

  it('exists on disk', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('parses as valid ESM', () => {
    const result = syntaxCheck(file);
    expect(result.ok).toBe(true);
  });
});

describe('bin/session-start-launcher.mjs', () => {
  const file = resolve(BIN, 'session-start-launcher.mjs');

  it('exists on disk', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('parses as valid ESM', () => {
    const result = syntaxCheck(file);
    expect(result.ok).toBe(true);
  });
});

describe('bin/build-embeddings.mjs', () => {
  const file = resolve(BIN, 'build-embeddings.mjs');

  it('exists on disk', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('parses as valid ESM', () => {
    const result = syntaxCheck(file);
    expect(result.ok).toBe(true);
  });
});

describe('bin/index-guidance.mjs', () => {
  const file = resolve(BIN, 'index-guidance.mjs');

  it('exists on disk', () => {
    expect(existsSync(file)).toBe(true);
  });

  it('parses as valid ESM', () => {
    const result = syntaxCheck(file);
    expect(result.ok).toBe(true);
  });
});
