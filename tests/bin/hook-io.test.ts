/**
 * Tests for shared hook I/O primitives (#1198) — bin/lib/hook-io.mjs.
 *
 * readHookStdin is covered end-to-end by the meditate-capture and
 * session-continuity subprocess tests; here we cover the pure readFileTail
 * (small file, tail slice, missing file).
 *
 * Cross-platform (Rule #1): temp dirs via path, Node fs only, no shell.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

import { readFileTail } from '../../bin/lib/hook-io.mjs';

let root: string;
beforeEach(() => {
  root = resolve(__dirname, '../../.testoutput/.test-hookio-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(root, { recursive: true });
});
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ } });

describe('readFileTail', () => {
  it('returns the whole file when smaller than the window', () => {
    const p = join(root, 'small.txt');
    writeFileSync(p, 'hello world', 'utf-8');
    expect(readFileTail(p, 1024)).toBe('hello world');
  });

  it('returns only the last `bytes` for a larger file', () => {
    const p = join(root, 'big.txt');
    writeFileSync(p, 'A'.repeat(1000) + 'TAILMARKER', 'utf-8');
    const tail = readFileTail(p, 20);
    expect(tail.length).toBe(20);
    expect(tail).toBe('A'.repeat(10) + 'TAILMARKER'); // 20 - len('TAILMARKER')=10 → 10 A's
  });

  it("returns '' for a missing file or empty path", () => {
    expect(readFileTail(join(root, 'nope.txt'), 100)).toBe('');
    expect(readFileTail('', 100)).toBe('');
    expect(readFileTail(undefined as unknown as string, 100)).toBe('');
  });
});
