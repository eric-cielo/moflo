/**
 * Tests for hooks.mjs test indexing integration
 *
 * Verifies:
 * - runTestIndexBackground function exists
 * - Test indexer is spawned during session-start
 * - Respects auto_index.tests flag from moflo.yaml
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HOOKS_FILE = resolve(__dirname, '../bin/hooks.mjs');

describe('hooks.mjs test indexing', () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(HOOKS_FILE, 'utf-8');
  });

  it('defines runTestIndexBackground function', () => {
    expect(content).toContain('function runTestIndexBackground()');
  });

  it('calls runTestIndexBackground in session-start', () => {
    // The session-start case should call the test indexer
    const sessionStart = content.substring(
      content.indexOf("case 'session-start':"),
      content.indexOf("case 'session-restore':")
    );
    expect(sessionStart).toContain('runTestIndexBackground()');
  });

  it('checks auto_index.tests flag in moflo.yaml', () => {
    expect(content).toContain('auto_index.tests');
    expect(content).toContain("match[1] === 'false'");
  });

  it('resolves index-tests.mjs via resolveBinOrLocal', () => {
    expect(content).toContain("resolveBinOrLocal('flo-testmap', 'index-tests.mjs')");
  });

  it('uses spawnWindowless for background execution', () => {
    const fn = content.substring(
      content.indexOf('function runTestIndexBackground'),
      content.indexOf('function runBackgroundTraining') // next function
    );
    expect(fn).toContain('spawnWindowless');
  });
});
