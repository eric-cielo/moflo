import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseIsolationTests, loadIsolationTests } from '../../scripts/load-isolation-tests.mjs';
import { makeTempRoot, cleanTempRoot } from './_helpers';

describe('parseIsolationTests', () => {
  it('returns paths from a clean array', () => {
    const src = `
export const isolationTests = [
  'a.test.ts',
  'b.test.ts',
];
`;
    expect(parseIsolationTests(src)).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('keeps later paths when a // comment contains an apostrophe', () => {
    const src = `
export const isolationTests = [
  'before.test.ts',
  // it's tricky — comment with apostrophe
  'after.test.ts',
  // doesn't break anymore
  'final.test.ts',
];
`;
    expect(parseIsolationTests(src)).toEqual([
      'before.test.ts',
      'after.test.ts',
      'final.test.ts',
    ]);
  });

  it('strips /* */ block comments before extracting paths', () => {
    const src = `
export const isolationTests = [
  'one.test.ts',
  /* it's a block comment with apostrophes */
  'two.test.ts',
];
`;
    expect(parseIsolationTests(src)).toEqual(['one.test.ts', 'two.test.ts']);
  });

  it('supports double-quoted entries', () => {
    const src = `
export const isolationTests = [
  "double.test.ts",
  'single.test.ts',
];
`;
    expect(parseIsolationTests(src)).toEqual(['double.test.ts', 'single.test.ts']);
  });

  it('returns [] when the export is missing', () => {
    expect(parseIsolationTests('// no array here\n')).toEqual([]);
  });

  it('returns the canonical full list from the real vitest.config.ts', () => {
    const root = resolve(__dirname, '..', '..');
    const entries = loadIsolationTests(resolve(root, 'vitest.config.ts'));
    expect(entries.length).toBeGreaterThanOrEqual(40);
    for (const path of entries) {
      expect(path).toMatch(/\.test\.ts$/);
      expect(path.length).toBeLessThan(120);
    }
  });
});

describe('loadIsolationTests', () => {
  it('reads from a file path and parses correctly', () => {
    const tmpDir = makeTempRoot('load-isolation');
    try {
      const fixture = resolve(tmpDir, 'vitest.config.ts');
      writeFileSync(fixture, `
export const isolationTests = [
  'x.test.ts', // it's fine
  'y.test.ts',
];
`);
      expect(loadIsolationTests(fixture)).toEqual(['x.test.ts', 'y.test.ts']);
    } finally {
      cleanTempRoot(tmpDir);
    }
  });

  it('returns [] when the file does not exist', () => {
    expect(loadIsolationTests(resolve(__dirname, '__never_exists__', 'nope.ts'))).toEqual([]);
  });
});
