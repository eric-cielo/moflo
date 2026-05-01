/**
 * Issue #829 (follow-up to #825): every store-writing MCP tool surface in
 * `src/cli/mcp-tools/` must anchor on `findProjectRoot()`, NOT `process.cwd()`.
 *
 * Each surface is exercised once with cwd diverged from the project root; the
 * fix is correct iff the JSON store lands under <project-root>/.moflo/ and
 * NOT under <cwd>/.moflo/. Mirrors hive-mind-store-path.test.ts.
 *
 * Covers: json-store, session-tools, github-tools, neural-tools.
 *
 * Out of scope here: hooks-tools (changes only forward findProjectRoot() to
 * `startDaemon()` / `hooksPretrain` — both are themselves rooted there, so
 * an end-to-end assertion would require spawning a daemon).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let fakeProjectRoot = '';
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => fakeProjectRoot,
}));

import { createJsonStore } from '../../mcp-tools/json-store.js';
import { sessionTools } from '../../mcp-tools/session-tools.js';
import { githubTools } from '../../mcp-tools/github-tools.js';
import { neuralTools } from '../../mcp-tools/neural-tools.js';

const sessionSave = sessionTools.find(t => t.name === 'session_save')!;
const githubAnalyze = githubTools.find(t => t.name === 'github_repo_analyze')!;
const neuralTrain = neuralTools.find(t => t.name === 'neural_train')!;

describe('mcp-tools store paths anchor on findProjectRoot() (issue #829)', () => {
  let originalCwd: string;
  let cwdSentinel: string;

  beforeEach(() => {
    fakeProjectRoot = mkdtempSync(join(tmpdir(), 'moflo-mcp-store-root-'));
    writeFileSync(join(fakeProjectRoot, 'package.json'), '{"name":"fake"}');
    cwdSentinel = mkdtempSync(join(tmpdir(), 'moflo-mcp-store-cwd-'));
    originalCwd = process.cwd();
    process.chdir(cwdSentinel);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(fakeProjectRoot, { recursive: true, force: true });
    rmSync(cwdSentinel, { recursive: true, force: true });
    fakeProjectRoot = '';
  });

  describe('json-store', () => {
    it('save() writes under findProjectRoot()/.moflo, not cwd/.moflo', () => {
      const store = createJsonStore<{ value: number }>({
        subdir: 'sample',
        file: 'data.json',
        defaults: () => ({ value: 0 }),
      });

      store.save({ value: 42 });

      const correctPath = resolve(fakeProjectRoot, '.moflo', 'sample', 'data.json');
      const buggyPath = resolve(cwdSentinel, '.moflo', 'sample', 'data.json');
      expect(existsSync(correctPath)).toBe(true);
      expect(existsSync(buggyPath)).toBe(false);
      expect(JSON.parse(readFileSync(correctPath, 'utf-8'))).toEqual({ value: 42 });
    });
  });

  describe('session-tools', () => {
    it('session_save writes under findProjectRoot()/.moflo/sessions, not cwd', async () => {
      const result = (await sessionSave.handler({ name: 'test-session' })) as {
        sessionId: string;
        path: string;
      };

      const expectedDir = resolve(fakeProjectRoot, '.moflo', 'sessions');
      const buggyDir = resolve(cwdSentinel, '.moflo', 'sessions');
      expect(existsSync(join(expectedDir, `${result.sessionId}.json`))).toBe(true);
      expect(existsSync(buggyDir)).toBe(false);
      expect(result.path).toContain(expectedDir);
    });
  });

  describe('github-tools', () => {
    it('github_repo_analyze writes under findProjectRoot()/.moflo/github, not cwd', async () => {
      await githubAnalyze.handler({ owner: 'eric-cielo', repo: 'moflo', branch: 'main' });

      const correctPath = resolve(fakeProjectRoot, '.moflo', 'github', 'store.json');
      const buggyPath = resolve(cwdSentinel, '.moflo', 'github', 'store.json');
      expect(existsSync(correctPath)).toBe(true);
      expect(existsSync(buggyPath)).toBe(false);
      const stored = JSON.parse(readFileSync(correctPath, 'utf-8')) as {
        repos: Record<string, unknown>;
      };
      expect(stored.repos['eric-cielo/moflo']).toBeDefined();
    });
  });

  describe('neural-tools', () => {
    it('neural_train writes under findProjectRoot()/.moflo/neural, not cwd', async () => {
      const result = (await neuralTrain.handler({ modelType: 'classifier', epochs: 1 })) as {
        success: boolean;
        modelId: string;
      };
      expect(result.success).toBe(true);

      const correctPath = resolve(fakeProjectRoot, '.moflo', 'neural', 'models.json');
      const buggyPath = resolve(cwdSentinel, '.moflo', 'neural', 'models.json');
      expect(existsSync(correctPath)).toBe(true);
      expect(existsSync(buggyPath)).toBe(false);
      const stored = JSON.parse(readFileSync(correctPath, 'utf-8')) as {
        models: Record<string, unknown>;
      };
      expect(stored.models[result.modelId]).toBeDefined();
    });
  });
});
