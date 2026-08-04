// Statusline upgrade-notice tests (#636 → #738 → #743 → completed-state).
//
// Contract evolution:
//   #636 — original feature: launcher writes notice after upgrade, statusline
//          renders it for 1 hour (legacy "complete" mode).
//   #738 — launcher writes status='in-progress' BEFORE upgrade work, deletes
//          file when work completes; statusline still rendered legacy mode
//          as a fallback.
//   #743 — statusline renders ONLY status='in-progress' notices. Stale legacy
//          files cannot turn the segment into a permanent column.
//   completed-state — section 3f writes status='completed' with 2-min TTL
//          instead of deleting, giving the post-upgrade badge a visibility
//          window. Section 0-pre still wipes any leftover at the next launcher
//          run, capping lifetime at one session.
//   #1363 — the 'completed' flip moves up to commitVersionStamp, so a launcher
//          killed during the best-effort tail still leaves a terminal state.
//   #1363 follow-up — Claude Code repaints the statusline DURING the
//          SessionStart hook, not only after it returns. #1363 assumed
//          otherwise and rendered every mid-flight upgrade as "interrupted".
//          In-flight vs. stranded is now decided by probing the launcher pid
//          recorded in the notice.
//
// These tests pin the #743 stale-file rejection, the completed contract, and
// the three liveness cases (live pid / dead pid / no pid).
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
  // Two issue #864 mitigations layered here:
  //
  // 1. GIT_CEILING_DIRECTORIES — temp roots live under <repo>/.testoutput/,
  //    inside the real moflo git tree. Without this, the statusline's git
  //    execs walk upward, find moflo's .git, and run `git status` /
  //    `git rev-list` against the live working tree — the dominant cost
  //    under maxForks=2 fork contention. Capping the walk at the tempRoot's
  //    parent makes every git exec exit immediately with "not a git
  //    repository", saving ~1–3 s per spawn on Windows.
  //
  // 2. 25 s spawn timeout (was 15 s) — even with git short-circuited, the
  //    cumulative cost of `generateJSON()` (file probes, FS walks, node
  //    startup) intermittently crosses 15 s under heavy fork contention,
  //    yielding empty stdout and a JSON.parse failure. 25 s sits 5 s under
  //    the vitest 30 s testTimeout, so the test still fails cleanly if the
  //    spawn truly hangs rather than masking a real bug.
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

// A pid that is guaranteed not to be running: spawn a trivial process, let it
// exit, then reuse its pid. Portable (no /proc, no tasklist) and far safer than
// picking an arbitrary high number, which can collide with a live process.
function makeDeadPid(): number {
  const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8', timeout: 25_000 });
  if (!probe.pid) throw new Error('could not spawn probe process to obtain a dead pid');
  return probe.pid;
}

function writeNotice(root: string, body: unknown) {
  const dir = join(root, '.moflo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'upgrade-notice.json'), JSON.stringify(body, null, 2));
}

describe('statusline upgrade-notice (#636 / #738 / #743)', () => {
  let root: string;
  let deadPid: number;
  beforeEach(() => {
    root = makeTempRoot();
    deadPid = makeDeadPid();
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

  // #1363 follow-up — #1363 asserted here that an in-progress UPGRADE notice
  // seen at render time always meant a dead launcher, on the premise that
  // Claude Code paints only AFTER the SessionStart hook returns. It does not:
  // it repaints DURING the hook, so a healthy upgrade is routinely observed
  // inside the launcher's in-progress window and #1363 painted a red "upgrade
  // interrupted (run /healer)" over it. Liveness now comes from probing the
  // pid the launcher stamps into the notice, not from the act of rendering.
  it('shows live progress while the launcher that wrote the notice is running', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'in-progress',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 5_000).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      changes: 0,
      pid: process.pid, // this test process stands in for a live launcher
    });

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toEqual({
      status: 'in-progress',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      pid: process.pid,
    });

    const compact = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = compact.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('upgraded to 4.8.80');
    expect(plain).toContain('updating');
    expect(plain).not.toContain('interrupted');
    expect(plain).not.toContain('/healer');
  });

  // A launcher killed before commitVersionStamp (5s hook-timeout SIGKILL,
  // Windows TerminateProcess — neither runs the cleanup handlers) strands the
  // notice. That is reported as a stall, but NOT as an error: the version
  // stamp was never written, so the next session re-detects the upgrade and
  // re-runs it idempotently. Nothing for the user to repair.
  it('reports a stranded notice as resuming, without raising an error', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'in-progress',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 5_000).toISOString(),
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      changes: 0,
      pid: deadPid,
    });

    const compact = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = compact.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('upgrade resumes next session');
    expect(plain).not.toContain('interrupted');
    expect(plain).not.toContain('/healer');
    expect(plain).not.toContain('updating');
    expect(plain).not.toContain('changes');
  });

  // Version skew (Rule #2): during the very upgrade that installs this
  // statusline, the notice on disk was written by the PREVIOUS launcher, which
  // records no pid. Unknown liveness must read as live — a pid-less notice
  // must never be reported as stalled.
  it('treats a pid-less notice from an older launcher as live, not stalled', () => {
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

    const compact = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = compact.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('upgraded to 4.8.80');
    expect(plain).toContain('updating');
    expect(plain).not.toContain('interrupted');
    expect(plain).not.toContain('resumes');
  });

  // The stall rendering must not swallow the version-bump case where the
  // launcher DID finish — that path writes 'completed' and keeps its wording.
  it('does not report a stall for a completed upgrade', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'completed',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 2 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout } = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).not.toContain('interrupted');
    expect(plain).toContain('upgraded to 4.8.80');
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

  // #1363 exempts 'repair' from the stalled-upgrade rendering: §0's bootstrap
  // sentinel deliberately holds an in-progress repair notice open to keep the
  // healer prompt in front of the user until §3h resolves it, so here the
  // in-flight state IS the intended signal rather than evidence of a dead
  // launcher. This test pins that exemption.
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
    expect(plain).not.toContain('interrupted');
  });

  it('renders a completed upgrade notice without the updating… indicator', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'completed',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      at: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 2 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout, status } = runStatusline(root);
    expect(status).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.upgradeNotice).toEqual({
      status: 'completed',
      kind: 'upgrade',
      from: '4.8.79',
      to: '4.8.80',
      // Notice written here without one; liveness is irrelevant once terminal.
      pid: null,
    });

    const compact = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = compact.stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('upgraded to 4.8.80');
    expect(plain).not.toContain('updating');
  });

  it('omits a completed notice past its TTL', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'completed',
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

  it('renders a completed "repair" notice without the updating… indicator', () => {
    const now = Date.now();
    writeNotice(root, {
      status: 'completed',
      kind: 'repair',
      from: '4.8.80',
      to: '4.8.80',
      at: new Date(now).toISOString(),
      expiresAt: new Date(now + 2 * 60_000).toISOString(),
      changes: 0,
    });

    const { stdout } = runStatusline(root, ['--compact']);
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\x1B\[[0-9;]*m/g, '');
    expect(plain).toContain('install repaired');
    expect(plain).not.toContain('updating');
  });
});
