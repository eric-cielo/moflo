// Statusline upgrade-notice tests (#636 → #738 → #743).
//
// Contract evolution:
//   #636 — original feature: launcher writes notice after upgrade, statusline
//          renders it for 1 hour (legacy "complete" mode).
//   #738 — launcher writes status='in-progress' BEFORE upgrade work, deletes
//          file when work completes; statusline still rendered legacy mode
//          as a fallback.
//   #743 — statusline now renders ONLY status='in-progress' notices. Stale
//          legacy files (or any future bad writer) cannot turn the segment
//          into a permanent column; the launcher's section 0-pre also drops
//          any leftover file at session start as a second line of defence.
//
// These tests pin the #743 contract so a regression to "rendering complete
// notices for an hour" can't slip back in unobserved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const STATUSLINE = resolve(__dirname, '../../../.claude/helpers/statusline.cjs');
const REPO_ROOT = resolve(__dirname, '../../..');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function makeTempRoot(): string {
  const root = resolve(
    REPO_ROOT,
    '.testoutput',
    '.test-statusline-notice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sl-test', version: '0.0.0' }));
  return root;
}

function cleanTempRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows occasionally holds handles — non-fatal */
  }
}

function runStatusline(cwd: string, args: string[] = ['--json-compact']): RunResult {
  const result = spawnSync('node', [STATUSLINE, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CI: '1' },
    input: '',
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function writeNotice(root: string, body: unknown) {
  const dir = join(root, '.moflo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'upgrade-notice.json'), JSON.stringify(body, null, 2));
}

describe('statusline upgrade-notice (#636 / #738 / #743)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    cleanTempRoot(root);
  });

  it('treats a legacy "complete" notice (no status field) as stale and renders nothing', () => {
    // Legacy notice written by pre-#738 launcher: 1-hour TTL, no status field.
    // Pre-#743 the statusline rendered this for the full hour as a permanent
    // "📦 4.8.79 → 4.8.80 (3 changes)" column. After #743 it's dropped.
    const now = Date.now();
    writeNotice(root, {
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(),
      changes: 3,
    });

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toBeNull();

    const compact = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = compact.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).not.toContain('4.8.79 → 4.8.80');
    expect(plain).not.toContain('changes');
  });

  it('renders an in-progress notice with an updating… indicator', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'in-progress',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 5_000).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toEqual({
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
    });

    const compact = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = compact.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('4.8.79 → 4.8.80');
    expect(plain).toContain('updating');
    expect(plain).not.toContain('changes');
  });

  it('omits an in-progress notice past its TTL (zombie launcher safety)', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'in-progress',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 10 * 60_000).toISOString(),
      expiresAt: new Date(now - 5 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout } = runStatusline(root);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toBeNull();
  });

  it('omits an expired in-progress notice (past expiresAt)', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'in-progress',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 2 * 60 * 60_000).toISOString(),
      expiresAt: new Date(now - 60 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout } = runStatusline(root);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toBeNull();
  });

  it('omits the segment when no notice file exists (fast path)', () => {
    const { stdout } = runStatusline(root);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toBeNull();
  });

  it('tolerates a malformed notice file without crashing', () => {
    const dir = join(root, '.moflo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'upgrade-notice.json'), '{ this is not json');

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toBeNull();
  });

  it('renders an in-progress "repair" notice with the expected wording', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'in-progress',
      kind: 'repair',
      from: '4.8.80',
      to: '4.8.80',
      at: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout } = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('install repaired');
    expect(plain).toContain('updating');
  });
});
