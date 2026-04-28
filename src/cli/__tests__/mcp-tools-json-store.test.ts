/**
 * Tests for the shared JSON-store helper used by the trimmed MCP tool surfaces.
 * Anchors all I/O at `<cwd>/.moflo/<subdir>/<file>`, so each test runs in its
 * own tmpdir to avoid polluting the real `.moflo/`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createJsonStore } from '../mcp-tools/json-store.js';

interface Sample {
  greeting: string;
  count: number;
}

describe('createJsonStore', () => {
  let originalCwd: string;
  let tmp: string;
  let storePath: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'moflo-json-store-'));
    process.chdir(tmp);
    storePath = join(tmp, '.moflo', 'sample', 'data.json');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns defaults() when the backing file is missing', () => {
    const store = createJsonStore<Sample>({
      subdir: 'sample',
      file: 'data.json',
      defaults: () => ({ greeting: 'hello', count: 0 }),
    });

    expect(store.load()).toEqual({ greeting: 'hello', count: 0 });
  });

  it('round-trips values through save/load', () => {
    const store = createJsonStore<Sample>({
      subdir: 'sample',
      file: 'data.json',
      defaults: () => ({ greeting: 'hello', count: 0 }),
    });

    store.save({ greeting: 'hi', count: 7 });

    expect(existsSync(storePath)).toBe(true);
    expect(store.load()).toEqual({ greeting: 'hi', count: 7 });
  });

  it('falls back to defaults() on malformed JSON', () => {
    const store = createJsonStore<Sample>({
      subdir: 'sample',
      file: 'data.json',
      defaults: () => ({ greeting: 'fallback', count: -1 }),
    });

    mkdirSync(join(tmp, '.moflo', 'sample'), { recursive: true });
    writeFileSync(storePath, '{not valid json', 'utf-8');

    expect(store.load()).toEqual({ greeting: 'fallback', count: -1 });
  });

  it('creates the parent directory tree on save', () => {
    const store = createJsonStore<Sample>({
      subdir: 'deeply/nested/sample',
      file: 'data.json',
      defaults: () => ({ greeting: 'hello', count: 0 }),
    });

    expect(existsSync(join(tmp, '.moflo', 'deeply'))).toBe(false);

    store.save({ greeting: 'hi', count: 1 });

    expect(existsSync(join(tmp, '.moflo', 'deeply', 'nested', 'sample', 'data.json'))).toBe(true);
  });

  it('calls defaults() per load() — fresh values on each miss', () => {
    let callCount = 0;
    const store = createJsonStore<{ id: number }>({
      subdir: 'sample',
      file: 'data.json',
      defaults: () => ({ id: ++callCount }),
    });

    expect(store.load().id).toBe(1);
    expect(store.load().id).toBe(2);
    expect(store.load().id).toBe(3);
  });

  it('writes pretty-printed JSON', () => {
    const store = createJsonStore<Sample>({
      subdir: 'sample',
      file: 'data.json',
      defaults: () => ({ greeting: 'hello', count: 0 }),
    });

    store.save({ greeting: 'hi', count: 7 });

    const raw = readFileSync(storePath, 'utf-8');
    expect(raw).toContain('\n');
    expect(raw).toContain('  "greeting"');
  });

  it('surfaces I/O errors other than ENOENT', () => {
    // mkdir at the file path → readFileSync throws EISDIR on every platform,
    // exercising the "not ENOENT, not SyntaxError" branch.
    mkdirSync(join(tmp, '.moflo', 'sample'), { recursive: true });
    mkdirSync(storePath);

    const store = createJsonStore<Sample>({
      subdir: 'sample',
      file: 'data.json',
      defaults: () => ({ greeting: 'fallback', count: -1 }),
    });

    expect(() => store.load()).toThrow();
  });
});
