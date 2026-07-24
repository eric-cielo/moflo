/**
 * System E2E: automatic durable-learning sharing across git worktrees (#1231
 * follow-up).
 *
 * The service-layer unit tests (src/cli/__tests__/services/durable-sync.test.ts)
 * prove detection + derivation + merge against synthetic `.git` fixtures. The
 * launcher pre-gate that DECIDES to call the sync for worktrees is locked by
 * tests/bin/launcher-1231-worktree-durable-gate.test.ts. What neither exercises
 * is the whole thing wired together against REAL git worktrees and the SHIPPED
 * dist — the "does a learning written in worktree A actually show up in worktree
 * B?" question.
 *
 * This test:
 *   1. `git init` a repo and `git worktree add` a second worktree (B).
 *   2. Write a learning in the primary checkout (A) via the shipped `flo memory
 *      store` CLI — a real subprocess, real embedding generation, real DB write.
 *   3. Run `syncDurableAtSessionStart` from `dist/` (the exact entry the session-
 *      start launcher calls once its worktree pre-gate fires) for A then B.
 *   4. Assert the learning converged: present in the auto-derived
 *      `<main>/.git/moflo/durable.db`, seeded into B's local DB with its
 *      embedding intact, and visible to the real `flo memory list` CLI in B.
 *   5. Negative: a plain single checkout (no worktree) writes NOTHING — the
 *      byte-for-byte-unchanged guarantee for solo users.
 *
 * Loads dist/, so it SKIPS (not fails) when the build is missing (fresh clone /
 * post-clean) or when `git` is unavailable. Cross-platform: real git worktrees,
 * `process.execPath`, `execFileSync` with `shell:false`, os.tmpdir, node:sqlite
 * (Rule #1).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'cli.js');
const DURABLE_DIST = path.join(REPO_ROOT, 'dist', 'src', 'cli', 'services', 'durable-sync.js');

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DIST_READY = fs.existsSync(DURABLE_DIST) && fs.existsSync(CLI);
const GIT_READY = gitAvailable();
const CAN_RUN = DIST_READY && GIT_READY;

const created: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}
function initRepo(prefix: string): string {
  const dir = tmp(prefix);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'e2e@moflo.test');
  git(dir, 'config', 'user.name', 'e2e');
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
/** Run the shipped `flo` CLI in `cwd`, pinned to it as the project root. */
function flo(cwd: string, ...args: string[]): string {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  // Force direct-DB writes: a closed daemon port makes the routing health-probe
  // fail fast, so the store never depends on a daemon.
  //
  // This does NOT stop one being spawned — the port only steers write ROUTING,
  // while autostart is gated on `daemon.auto_start` (true in DEFAULT_CONFIG,
  // and these tmp repos have no moflo.yaml to override it). That gap leaked a
  // detached daemon per invocation, orphaned the moment the tmp dir was
  // removed. MOFLO_TEST_SKIP_DAEMON_AUTOSTART (vitest.setup.ts, inherited here
  // through process.env) is what actually prevents the spawn.
  env.MOFLO_DAEMON_PORT = '44571';
  delete env.MOFLO_DURABLE_PATH; // exercise auto-derivation, not an override
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function rows(dbPath: string): Array<{ namespace: string; key: string; embedding: string | null }> {
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare('SELECT namespace, key, embedding FROM memory_entries ORDER BY namespace, key')
      .all() as Array<{ namespace: string; key: string; embedding: string | null }>;
  } finally {
    db.close();
  }
}

describe('System E2E — automatic worktree durable sharing (#1231)', () => {
  beforeAll(() => {
    // The test process itself resolves durable paths — keep the override clean so
    // auto-derivation (not MOFLO_DURABLE_PATH) is what's under test.
    delete process.env.MOFLO_DURABLE_PATH;
    if (!CAN_RUN) {
      const why = !DIST_READY ? `dist not built (run: npm run build)` : `git not available`;
      // eslint-disable-next-line no-console
      console.warn(`[worktree-durable-sharing-e2e] skipping suite — ${why}.`);
    }
  });

  afterEach(() => {
    while (created.length) {
      const d = created.pop()!;
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows file-lock — non-fatal for a temp dir */
      }
    }
  });

  it.skipIf(!CAN_RUN)(
    'a learning written in worktree A converges into worktree B',
    async () => {
      const { syncDurableAtSessionStart } = await import(pathToFileURL(DURABLE_DIST).href);

      const main = initRepo('e2e-wt-main-');
      const wtB = path.join(tmp('e2e-wt-parent-'), 'wt-b');
      git(main, 'worktree', 'add', '-q', '-b', 'wtb', wtB);

      const KEY = 'lesson-e2e';
      flo(main, 'memory', 'store', '-k', KEY, '-n', 'learnings', '-v', 'worktrees converge automatically', '-u');

      const sharedDb = path.join(main, '.git', 'moflo', 'durable.db');
      const bDb = path.join(wtB, '.moflo', 'moflo.db');

      const repA = await syncDurableAtSessionStart({ projectRoot: main });
      const repB = await syncDurableAtSessionStart({ projectRoot: wtB });

      // Both checkouts independently derive the SAME store under the shared .git.
      expect(repA.autoWorktree).toBe(true);
      expect(repA.durablePath).toBe(sharedDb);
      expect(repB.durablePath).toBe(sharedDb);
      expect(repB.autoWorktree).toBe(true);

      // The learning reached the shared store (via write-through at store time
      // and/or the session-start flush) and seeded into B, embedding intact.
      const sharedHit = rows(sharedDb).find((r) => r.key === KEY && r.namespace === 'learnings');
      expect(sharedHit, 'shared .git/moflo/durable.db should hold the learning').toBeTruthy();
      expect(sharedHit!.embedding, 'shared row keeps its embedding (searchable)').toBeTruthy();

      const bHit = rows(bDb).find((r) => r.key === KEY && r.namespace === 'learnings');
      expect(bHit, "worktree B's local DB should have the seeded learning").toBeTruthy();
      expect(bHit!.embedding, 'B keeps the embedding (no recompute)').toBeTruthy();

      // And the shipped CLI in B sees it.
      const bList = flo(wtB, 'memory', 'list', '-n', 'learnings');
      expect(bList).toContain(KEY);
    },
    120_000,
  );

  it.skipIf(!CAN_RUN)('a plain single checkout (no worktrees) writes nothing', async () => {
    const { syncDurableAtSessionStart } = await import(pathToFileURL(DURABLE_DIST).href);

    const solo = initRepo('e2e-solo-');
    const report = await syncDurableAtSessionStart({ projectRoot: solo });

    expect(report.durablePath).toBeNull();
    expect(report.skipped).toBe('not-configured');
    expect(fs.existsSync(path.join(solo, '.git', 'moflo', 'durable.db'))).toBe(false);
  });
});
