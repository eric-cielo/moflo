/**
 * Launcher §0-bootstrap-sentinel promotes a partial-bootstrap failure to the
 * statusline channel (#975 follow-up).
 *
 * When `scripts/post-install-bootstrap.mjs` writes
 * `<root>/.moflo/bootstrap-failed.json`, the launcher's section-0 block must
 * also write `<root>/.moflo/upgrade-notice.json` with `kind: 'repair'` +
 * `status: 'in-progress'` so the statusline keeps the "/healer --fix" prompt
 * in front of the user across the full session — `emitWarning` alone only
 * lands on stderr (additionalContext) once at session start.
 *
 * Spawns the real launcher against a minimal consumer fixture and reads back
 * the notice file. Most of the launcher's heavy work (daemon recycle, memory
 * rebuild, embeddings migration) short-circuits when there's no `node_modules
 * /moflo/` and no `.moflo/moflo.db`, so the run is fast.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const LAUNCHER = join(REPO_ROOT, 'bin', 'session-start-launcher.mjs');

function makeConsumer(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'moflo-launcher-sentinel-'));
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  mkdirSync(join(tmp, '.moflo'), { recursive: true });
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ name: 'sentinel-fixture', version: '0.0.0' }, null, 2),
  );
  return tmp;
}

function runLauncher(cwd: string) {
  return spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      CI: '1',
      // Suppress the dogfood self-detect path — fixture has its own package.json
      // and findProjectRoot picks it up from cwd.
      CLAUDE_PROJECT_DIR: cwd,
    },
    input: '',
  });
}

describe('launcher §0-bootstrap-sentinel → upgrade-notice promotion (#975)', () => {
  let consumerRoot: string;

  beforeEach(() => {
    consumerRoot = makeConsumer();
  });
  afterEach(() => {
    rmSync(consumerRoot, { recursive: true, force: true });
  });

  it('writes a kind=repair, status=in-progress upgrade-notice when a bootstrap-failed sentinel is present', () => {
    writeFileSync(
      join(consumerRoot, '.moflo', 'bootstrap-failed.json'),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          mofloVersion: '4.9.99',
          failures: [
            {
              key: '.claude/scripts/session-start-launcher.mjs',
              message: 'EBUSY resource busy or locked',
              src: '/fake/src',
              dest: '/fake/dest',
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    const noticePath = join(consumerRoot, '.moflo', 'upgrade-notice.json');
    expect(
      existsSync(noticePath),
      `expected upgrade-notice.json after sentinel detected. stderr:\n${result.stderr}`,
    ).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.kind).toBe('repair');
    expect(notice.status).toBe('in-progress');
    expect(notice.from).toBe('4.9.99');
    expect(notice.to).toBe('4.9.99');
    expect(typeof notice.expiresAt).toBe('string');
    // 5-min in-progress TTL, give or take a few seconds for spawn overhead
    const ttlMs = new Date(notice.expiresAt).getTime() - new Date(notice.at).getTime();
    expect(ttlMs).toBeGreaterThan(4 * 60_000);
    expect(ttlMs).toBeLessThan(6 * 60_000);

    // The launcher's emitWarning to stderr is also a contract of #975 —
    // the statusline notice is the persistent surface, the warning is the
    // one-shot session-start surface.
    expect(result.stderr).toContain('/healer --fix');
  });

  it('does not write an upgrade-notice when no sentinel is present', () => {
    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    const noticePath = join(consumerRoot, '.moflo', 'upgrade-notice.json');
    // §0-pre always unlinks any leftover; without a sentinel, §0-bootstrap-sentinel
    // never writes one. (A real upgrade-detect path could write one, but the
    // fixture has no node_modules/moflo/ install for the launcher to detect.)
    expect(existsSync(noticePath)).toBe(false);
  });

  it('clears sentinel and flips notice to completed when §3h verifies all failed copies are now in sync (#976 B6)', () => {
    // Stage the recovery scenario: bootstrap reported a failure on file X,
    // but by the time the launcher runs the file is now in sync with src
    // (e.g. the AV scan finished, the lock cleared, a later sync attempt
    // succeeded). §3h should:
    //   1. read the sentinel
    //   2. compare each failed src/dest pair byte-for-byte
    //   3. when all match, unlink the sentinel and flip the upgrade-notice
    //      from in-progress to completed so the statusline shows the
    //      post-repair badge briefly.
    const fakeSrc = join(consumerRoot, 'fake-src.bin');
    const fakeDest = join(consumerRoot, '.claude/scripts/fake-dest.bin');
    mkdirSync(join(consumerRoot, '.claude/scripts'), { recursive: true });
    const payload = 'identical-on-both-sides';
    writeFileSync(fakeSrc, payload);
    writeFileSync(fakeDest, payload);

    writeFileSync(
      join(consumerRoot, '.moflo', 'bootstrap-failed.json'),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          mofloVersion: '4.9.99',
          failures: [
            {
              key: '.claude/scripts/fake-dest.bin',
              message: 'EBUSY (resolved)',
              src: fakeSrc,
              dest: fakeDest,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    // Sentinel is gone — §3h verified and unlinked it.
    expect(existsSync(join(consumerRoot, '.moflo', 'bootstrap-failed.json'))).toBe(false);

    // Notice is now completed (statusline post-repair badge).
    const noticePath = join(consumerRoot, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.status).toBe('completed');
    expect(notice.kind).toBe('repair');
    // Completed TTL is 2 minutes (statusline contract; #738).
    const ttlMs = new Date(notice.expiresAt).getTime() - new Date(notice.at).getTime();
    expect(ttlMs).toBeGreaterThan(60_000);
    expect(ttlMs).toBeLessThan(3 * 60_000);

    // Mutation log mentions the cleared sentinel. emitMutation writes to
    // stdout — Claude relays that as additionalContext.
    expect(result.stdout).toContain('cleared bootstrap-failed sentinel');
  });

  it('keeps sentinel in place when verify fails (file still out of sync)', () => {
    // Companion to the test above: if §3h's content compare doesn't match,
    // the sentinel must persist so the user sees the warning again next
    // session and /healer can complete the repair.
    const fakeSrc = join(consumerRoot, 'fake-src.bin');
    const fakeDest = join(consumerRoot, '.claude/scripts/fake-dest.bin');
    mkdirSync(join(consumerRoot, '.claude/scripts'), { recursive: true });
    writeFileSync(fakeSrc, 'src-content');
    writeFileSync(fakeDest, 'dest-content-MISMATCH');

    writeFileSync(
      join(consumerRoot, '.moflo', 'bootstrap-failed.json'),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          mofloVersion: '4.9.99',
          failures: [
            {
              key: '.claude/scripts/fake-dest.bin',
              message: 'EBUSY',
              src: fakeSrc,
              dest: fakeDest,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runLauncher(consumerRoot);
    expect(result.status, `launcher stderr: ${result.stderr}`).toBe(0);

    // Sentinel survives — §3h refused to clear it because verify failed.
    expect(existsSync(join(consumerRoot, '.moflo', 'bootstrap-failed.json'))).toBe(true);
    // Notice stays at in-progress (or a fresh in-progress was written).
    const noticePath = join(consumerRoot, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.status).toBe('in-progress');
  });
});
