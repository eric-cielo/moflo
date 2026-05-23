/**
 * Tests for updateGitignore step in flo init.
 *
 * These additions matter because moflo writes (and overwrites on every install)
 * ~25 guidance files under `.claude/guidance/moflo-*.md` plus 11 scripts under
 * `.claude/scripts/`. Without gitignore coverage, those show up as untracked
 * additions in every consumer's `git status` and tempt commits of derived
 * state. The leading `/` anchor is mandatory — see the `guidance-gitignore-
 * shipped-trap` learning for why a bare `.claude/guidance/` rule once silently
 * swallowed shipped subdirectories and broke `npm pack`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { updateGitignore } from '../init/moflo-init.js';
import { loadShippedScripts } from '../init/shipped-scripts.js';

describe('updateGitignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-init-gitignore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readGitignore(): string {
    return fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
  }

  it('creates .gitignore with all moflo entries when none exists', () => {
    const result = updateGitignore(tmpDir);

    expect(result.status).toBe('created');
    const content = readGitignore();

    // Default consumer entries
    expect(content).toContain('node_modules/');
    expect(content).toContain('dist/');
    expect(content).toContain('.env');

    // MoFlo runtime/state entries
    expect(content).toContain('.claude-epic/');
    expect(content).toContain('.moflo/');
    expect(content).toContain('.swarm/');
    expect(content).toContain('.claude/settings.local.json');
    expect(content).toContain('.claude/scheduled_tasks.lock');
    expect(content).toContain('**/workflow-state.json');

    // Auto-synced moflo files (the new entries)
    expect(content).toContain('/.claude/guidance/moflo-*.md');
    for (const name of loadShippedScripts().scriptFiles) {
      expect(content).toContain(`/.claude/scripts/${name}`);
    }
  });

  it('appends moflo entries to an existing .gitignore', () => {
    const existing = 'node_modules/\nbuild/\n# user comment\n';
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), existing, 'utf-8');

    const result = updateGitignore(tmpDir);

    expect(result.status).toBe('updated');
    const content = readGitignore();

    // Existing lines preserved
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain('build/');
    expect(content).toContain('# user comment');

    // New entries appended under the heading
    expect(content).toContain('# MoFlo state (gitignored)');
    expect(content).toContain('/.claude/guidance/moflo-*.md');
    for (const name of loadShippedScripts().scriptFiles) {
      expect(content).toContain(`/.claude/scripts/${name}`);
    }
  });

  it('is idempotent — second call is a no-op', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');

    updateGitignore(tmpDir);
    const afterFirst = readGitignore();

    const second = updateGitignore(tmpDir);
    const afterSecond = readGitignore();

    expect(second.status).toBe('skipped');
    expect(afterSecond).toBe(afterFirst);
  });

  it('does not duplicate .moflo/ in the entries list', () => {
    updateGitignore(tmpDir);
    const content = readGitignore();

    const matches = content.split(/\r?\n/).filter(line => line.trim() === '.moflo/');
    expect(matches).toHaveLength(1);
  });

  it('anchors guidance + scripts patterns with a leading slash', () => {
    updateGitignore(tmpDir);
    const content = readGitignore();

    // Leading slash is mandatory — bare patterns once swallowed shipped subdirs
    // (guidance-gitignore-shipped-trap learning).
    expect(content).toContain('/.claude/guidance/moflo-*.md');
    expect(content).not.toMatch(/^\.claude\/guidance\/moflo-\*\.md$/m);

    for (const name of loadShippedScripts().scriptFiles) {
      expect(content).toContain(`/.claude/scripts/${name}`);
    }
  });

  it('treats leading-slash and bare forms as equivalent for dedup', () => {
    // Consumer added the un-anchored form manually before this fix shipped, or
    // copy-pasted from older moflo — neither should produce a duplicate.
    const existing = [
      'node_modules/',
      '.claude/guidance/moflo-*.md',
      '.claude/scripts/hooks.mjs',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), existing, 'utf-8');

    updateGitignore(tmpDir);
    const content = readGitignore();

    const guidanceLines = content
      .split(/\r?\n/)
      .filter(l => l.includes('.claude/guidance/moflo-*.md'));
    expect(guidanceLines).toHaveLength(1);

    const hooksLines = content
      .split(/\r?\n/)
      .filter(l => l.includes('.claude/scripts/hooks.mjs'));
    expect(hooksLines).toHaveLength(1);
  });

  it('appends only the missing entries when some are already present', () => {
    const existing = [
      'node_modules/',
      '.moflo/',
      '/.claude/scripts/hooks.mjs',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), existing, 'utf-8');

    const result = updateGitignore(tmpDir);
    expect(result.status).toBe('updated');

    const content = readGitignore();
    // The pre-existing .moflo/ stays as a single occurrence
    const moflo = content.split(/\r?\n/).filter(l => l.trim() === '.moflo/');
    expect(moflo).toHaveLength(1);

    // hooks.mjs entry stays as a single occurrence
    const hooks = content
      .split(/\r?\n/)
      .filter(l => l.trim() === '/.claude/scripts/hooks.mjs');
    expect(hooks).toHaveLength(1);

    // Other SCRIPT_MAP entries got appended
    expect(content).toContain('/.claude/scripts/session-start-launcher.mjs');
    expect(content).toContain('/.claude/guidance/moflo-*.md');
  });
});
