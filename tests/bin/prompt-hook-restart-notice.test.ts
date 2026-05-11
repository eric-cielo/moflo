/**
 * #867 — UserPromptSubmit hook surfaces .moflo/restart-pending.json so the
 * user/Claude actually sees the "please restart" message between install and
 * the next session restart. Companion: launcher §0d clears the file once the
 * running moflo matches the file's version.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';

const PROMPT_HOOK = resolve(__dirname, '../../bin/prompt-hook.mjs');
const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');

describe('bin/prompt-hook.mjs — surface restart notice (#867)', () => {
  let root: string;
  beforeEach(() => {
    root = resolve(__dirname, '../../.testoutput/.test-prompt-hook-867-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(join(root, '.moflo'), { recursive: true });
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle */ }
  });

  function runHook(): string {
    const result = spawnSync('node', [PROMPT_HOOK], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      input: JSON.stringify({ user_prompt: 'hello' }),
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return result.stdout || '';
  }

  it('emits the restart-pending message when the file exists', () => {
    writeFileSync(
      join(root, '.moflo', 'restart-pending.json'),
      JSON.stringify({
        version: '4.9.9',
        writtenAt: new Date().toISOString(),
        message: 'MoFlo 4.9.9 installed.\n\nPlease restart Claude Code.',
      }),
    );
    expect(runHook()).toContain('Please restart Claude Code');
  });

  it('is silent when no restart-pending file exists', () => {
    expect(runHook()).not.toContain('Please restart Claude Code');
  });

  it('is silent when the file is malformed', () => {
    writeFileSync(join(root, '.moflo', 'restart-pending.json'), '{ not json');
    expect(runHook()).not.toContain('Please restart Claude Code');
  });
});

describe('bin/session-start-launcher.mjs §0d — clear notice when version matches (#867)', () => {
  let root: string;
  beforeEach(() => {
    root = resolve(__dirname, '../../.testoutput/.test-launcher-867-clear-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    mkdirSync(join(root, '.moflo'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'launcher-867-clear', version: '0.0.0' }));
    writeFileSync(join(root, 'node_modules', 'moflo', 'package.json'), JSON.stringify({ name: 'moflo', version: '4.9.9' }));
    // Pre-stamp the version so section 3 (upgrade work) short-circuits — we're
    // testing §0d's silent-cleanup behaviour, not the upgrade path.
    writeFileSync(join(root, '.moflo', 'moflo-version'), '4.9.9');
    writeFileSync(join(root, '.moflo', 'installed-files.json'), '[]');
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle */ }
  });

  function runLauncher(): { stdout: string; stderr: string } {
    // CLAUDE_PROJECT_DIR anchors the unified findProjectRoot (#1057) on the
    // temp root; without it the walk-up would land on the moflo repo itself.
    const result = spawnSync('node', [LAUNCHER], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  it('silently deletes restart-pending.json + last-install-banner.json when versions match (#887)', () => {
    const noticePath = join(root, '.moflo', 'restart-pending.json');
    const trackerPath = join(root, '.moflo', 'last-install-banner.json');
    writeFileSync(noticePath, JSON.stringify({ version: '4.9.9', message: 'restart please' }));
    writeFileSync(trackerPath, JSON.stringify({ version: '4.9.9' }));

    const { stdout, stderr } = runLauncher();

    expect(existsSync(noticePath)).toBe(false);
    expect(existsSync(trackerPath)).toBe(false);
    // Cleanup must be silent — surfacing it inflates mutationCount and triggers
    // the closing "starting background tasks" framing, both noise on a clean
    // post-restart session (#887).
    expect(stdout).not.toMatch(/cleared post-install restart notice/);
    expect(stdout).not.toMatch(/starting background tasks/);
    expect(stderr).not.toMatch(/cleared post-install restart notice/);
  });

  it('leaves restart-pending.json in place when the file version differs', () => {
    const noticePath = join(root, '.moflo', 'restart-pending.json');
    writeFileSync(noticePath, JSON.stringify({ version: '4.9.10', message: 'restart please' }));

    runLauncher();

    expect(existsSync(noticePath)).toBe(true);
  });

  it('is silent when no notice file exists', () => {
    const { stdout } = runLauncher();
    expect(stdout).not.toMatch(/cleared post-install restart notice/);
  });
});
