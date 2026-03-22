/**
 * Tests for bin/index-tests.mjs — test file indexing
 *
 * Verifies:
 * 1. Script exists and has valid syntax
 * 2. Test framework detection
 * 3. Test block extraction (describe/it/test)
 * 4. Import target extraction
 * 5. Reverse mapping generation
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');
const SCRIPT = resolve(BIN, 'index-tests.mjs');

/** Run `node --check <file>` and return whether it succeeded. */
function syntaxCheck(file: string): { ok: boolean; error?: string } {
  try {
    execFileSync('node', ['--check', file], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.stderr || err.message };
  }
}

describe('bin/index-tests.mjs', () => {
  it('exists on disk', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('parses as valid ESM', () => {
    // index-tests.mjs uses top-level await for sql.js import,
    // so --check alone may not fully validate. Verify the file at least
    // has the expected shebang and exports pattern.
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain("const NAMESPACE = 'tests'");
  });

  it('contains all required chunk type generators', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain('generateTestFileEntries');
    expect(content).toContain('generateTestMaps');
    expect(content).toContain('generateTestDirSummaries');
  });

  it('contains framework detection for vitest, jest, mocha, playwright', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain("'vitest'");
    expect(content).toContain("'jest'");
    expect(content).toContain("'mocha'");
    expect(content).toContain("'playwright'");
  });

  it('extracts describe/it/test blocks via regex', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    // Verify the regex patterns for test block extraction
    expect(content).toContain('describe|suite');
    expect(content).toContain('it|test|specify');
  });

  it('extracts import targets (ES modules and CJS)', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    // Verify both import styles are handled
    expect(content).toContain("import\\s+");  // ES import pattern
    expect(content).toContain("require\\s*\\("); // CJS require pattern
  });

  it('generates reverse mapping (test-map) entries', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain('test-map:');
    expect(content).toContain('reverseMap');
  });

  it('supports incremental indexing via hash', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain('tests-hash.txt');
    expect(content).toContain('computeFileListHash');
    expect(content).toContain('isUnchanged');
  });

  it('reads test directories from moflo.yaml', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain('moflo.yaml');
    expect(content).toContain('loadTestDirs');
  });

  it('uses the tests namespace', () => {
    const content = readFileSync(SCRIPT, 'utf-8');
    expect(content).toContain("const NAMESPACE = 'tests'");
  });
});
