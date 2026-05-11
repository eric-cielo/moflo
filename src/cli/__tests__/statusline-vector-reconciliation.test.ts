// Statusline vector-count reconciliation tests (epic #1054.S5 / #1059).
//
// The statusline must NEVER display an embedding count it cannot reconcile
// across both (a) `.moflo/vector-stats.json` and (b) the daemon's reported
// version (from `.moflo/daemon.lock`). When the daemon is down or its version
// disagrees with the installed package, the count is rendered as `?` and the
// stale-reason tag explains why.
//
// Pre-1059 the statusline fell back to `vectorCount = Math.floor(dbSizeKB/2)`
// when no cache existed — exactly the unreconciled fabrication the story
// prohibits.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

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
    '.test-statusline-recon-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sl-recon-test', version: '0.0.0' }));
  return root;
}

function cleanTempRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* non-fatal on Windows */
  }
}

function runStatusline(cwd: string, args: string[] = ['--json-compact']): RunResult {
  const result = spawnSync('node', [STATUSLINE, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 25_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      CI: '1',
      GIT_CEILING_DIRECTORIES: dirname(cwd),
    },
    input: '',
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function writeVectorStats(root: string, stats: object) {
  const dir = join(root, '.moflo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vector-stats.json'), JSON.stringify(stats));
}

function writeDaemonLock(root: string, payload: object) {
  const dir = join(root, '.moflo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'daemon.lock'), JSON.stringify(payload));
}

function writeInstalledPkg(root: string, version: string) {
  const dir = join(root, 'node_modules', 'moflo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'moflo', version }));
}

describe('statusline vector reconciliation (#1059)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('marks vectorCount unreconciled when no daemon.lock exists', () => {
    writeVectorStats(root, { vectorCount: 1234, missing: 0, dbSizeKB: 100, namespaces: 3 });
    writeInstalledPkg(root, '4.9.40');

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.embeddings.vectorCount).toBe(1234);
    expect(json.embeddings.reconciled).toBe(false);
    expect(json.embeddings.staleReason).toBe('daemon-down');
  });

  it('marks vectorCount unreconciled when daemon version disagrees with installed', () => {
    writeVectorStats(root, { vectorCount: 1234, missing: 0, dbSizeKB: 100, namespaces: 3 });
    writeInstalledPkg(root, '4.9.40');
    writeDaemonLock(root, {
      pid: 999999,
      startedAt: Date.now(),
      label: 'moflo-daemon',
      version: '4.9.37', // skew
    });

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.embeddings.reconciled).toBe(false);
    expect(json.embeddings.staleReason).toBe('version-skew');
  });

  it('marks vectorCount reconciled when daemon version matches installed', () => {
    writeVectorStats(root, { vectorCount: 1234, missing: 0, dbSizeKB: 100, namespaces: 3 });
    writeInstalledPkg(root, '4.9.40');
    writeDaemonLock(root, {
      pid: 999999,
      startedAt: Date.now(),
      label: 'moflo-daemon',
      version: '4.9.40',
    });

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.embeddings.vectorCount).toBe(1234);
    expect(json.embeddings.reconciled).toBe(true);
  });

  it('removes the legacy dbSize/2 fabrication when cache is absent', () => {
    // Pre-1059 the statusline fabricated `vectorCount = floor(dbSizeKB/2)`
    // when no vector-stats.json existed. The fabricated number is exactly
    // what the story flags as unreconciled — vectorCount must stay 0.
    writeInstalledPkg(root, '4.9.40');
    // Create a fake DB file with a noticeable size so the old fallback would
    // have invented vectorCount = size/2.
    const dbDir = join(root, '.moflo');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'moflo.db'), Buffer.alloc(2048));

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.embeddings.vectorCount).toBe(0);
    expect(json.embeddings.reconciled).toBe(false);
    expect(json.embeddings.staleReason).toBe('cache-missing');
  });

  it('renders "?" instead of a number in compact mode when unreconciled', () => {
    writeVectorStats(root, { vectorCount: 9999, missing: 0, dbSizeKB: 100, namespaces: 3 });
    writeInstalledPkg(root, '4.9.40');
    // no daemon.lock — unreconciled

    const { stdout } = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\x1B\[[0-9;]*m/g, '');
    // The compact embeddings segment must NOT print the unverified 9999.
    expect(plain).not.toContain('9999');
    expect(plain).toContain('?');
  });
});
