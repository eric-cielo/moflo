/**
 * #1315 — `daemon start` minted a `.moflo/` island at cwd instead of resolving
 * the project root, re-seeding the daemon-island failure mode #1174 closed.
 *
 * Two defects, both covered here:
 *   1. The daemon anchored on `process.cwd()`, so any sub-workspace invocation
 *      created a rival state dir (and a rival daemon, because the
 *      already-running check looked for a lock at that same wrong place).
 *   2. `CLAUDE_PROJECT_DIR` short-circuits `findProjectRoot()` before Pass A.
 *      Claude Code sets it to the SESSION directory and the spawned daemon
 *      inherits it, so even code that resolved "correctly" landed on the
 *      sub-workspace.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveStateRoot, _resetStateRootCacheForTest } from '../../services/project-root.js';
import { WorkerDaemon } from '../../services/worker-daemon.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Create `<dir>/.moflo/moflo.db` — the marker Pass A keys on. */
function seedMofloState(dir: string): void {
  mkdirSync(join(dir, '.moflo'), { recursive: true });
  writeFileSync(join(dir, '.moflo', 'moflo.db'), '');
}

describe('#1315 — daemon root resolution', () => {
  let root: string;
  let subWorkspace: string;
  let deepDir: string;
  const savedEnv = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(() => {
    // realpath both sides — macOS reports /var/folders but resolves to
    // /private/var/folders, which would break every comparison below.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-')));
    seedMofloState(root);

    // A sub-workspace with its own package.json but NO moflo state — exactly
    // the waxstak `back-office/ui` shape from the report.
    subWorkspace = join(root, 'back-office', 'ui');
    mkdirSync(subWorkspace, { recursive: true });
    writeFileSync(join(subWorkspace, 'package.json'), '{"name":"ui"}');

    // The seven-levels-deep case: a React component folder, self-evidently
    // not a project root.
    deepDir = join(subWorkspace, 'src', 'layout', 'Dashboard', 'Header', 'HeaderContent');
    mkdirSync(deepDir, { recursive: true });

    delete process.env.CLAUDE_PROJECT_DIR;
    // Each case builds a fresh tmp tree; drop any memoized anchor so results
    // are proven by a real walk rather than inherited from a prior case.
    _resetStateRootCacheForTest();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedEnv;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('resolves to the monorepo root from a sub-workspace cwd', () => {
    expect(resolveStateRoot({ cwd: subWorkspace })).toBe(root);
  });

  it('resolves to the root from a directory seven levels deep', () => {
    expect(resolveStateRoot({ cwd: deepDir })).toBe(root);
  });

  it('never climbs above an explicit CLAUDE_PROJECT_DIR', () => {
    // The anti-hijack property, and the reason the env is authoritative rather
    // than merely a starting point for the walk.
    //
    // Pass A has NO upper bound: it runs to the filesystem root and takes the
    // topmost `.moflo/moflo.db`. If the walk were allowed to climb past an
    // explicit anchor, one stray `flo init` in an ancestor — `$HOME`, or an
    // outer checkout a scratch project happens to live inside — would silently
    // capture every project beneath it and mutate the wrong tree.
    //
    // Here `root` is an initialized ancestor of `subWorkspace`. With the env
    // naming the sub-workspace, the sub-workspace is the answer.
    process.env.CLAUDE_PROJECT_DIR = subWorkspace;
    expect(resolveStateRoot({ cwd: subWorkspace })).toBe(subWorkspace);
    expect(resolveStateRoot({ cwd: subWorkspace })).not.toBe(root);
  });

  it('ignores a CLAUDE_PROJECT_DIR naming a directory that does not exist', () => {
    // Callers mkdir whatever this returns, so honoring a typo'd or stale value
    // would materialize `.moflo/` at the typo path. Fall back to the walk.
    process.env.CLAUDE_PROJECT_DIR = join(root, 'no-such-directory');
    expect(resolveStateRoot({ cwd: subWorkspace })).toBe(root);
  });

  it('honors CLAUDE_PROJECT_DIR when it does hold moflo state', () => {
    // A genuine override must still work — this is how a user legitimately
    // points moflo at a project other than the one cwd sits in.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-other-')));
    try {
      seedMofloState(other);
      process.env.CLAUDE_PROJECT_DIR = other;
      expect(resolveStateRoot({ cwd: subWorkspace })).toBe(other);
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('absolutizes a CLAUDE_PROJECT_DIR carrying a trailing separator', () => {
    // The env value is caller-supplied; an anchor with a trailing sep would
    // produce `<root>//.moflo` paths that compare unequal to the canonical one.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-sep-')));
    try {
      seedMofloState(other);
      process.env.CLAUDE_PROJECT_DIR = other + sep;
      expect(resolveStateRoot({ cwd: subWorkspace })).toBe(other);
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('never crosses a project boundary when CLAUDE_PROJECT_DIR names another tree', () => {
    // The dangerous shape. `CLAUDE_PROJECT_DIR` points at a project that is not
    // yet initialized (no `.moflo/moflo.db`), while cwd sits inside a DIFFERENT,
    // fully-initialized project. An "ignore the env unless it has moflo.db,
    // else walk from cwd" rule resolves to the STRANGER'S root — so the
    // uninitialized project silently reads and writes the other project's
    // database. That is strictly worse than the island bug being fixed.
    //
    // Correct behavior: the env var picks the tree, so an un-initialized
    // project resolves to itself and touches nobody else's state.
    const stranger = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-stranger-')));
    try {
      seedMofloState(stranger);                       // a fully-initialized project
      const strangerInner = join(stranger, 'src');
      mkdirSync(strangerInner, { recursive: true });

      const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-uninit-')));
      try {
        process.env.CLAUDE_PROJECT_DIR = fresh;       // named project, no moflo.db yet
        // cwd is inside the stranger — the boundary that must not be crossed.
        expect(resolveStateRoot({ cwd: strangerInner })).toBe(fresh);
        expect(resolveStateRoot({ cwd: strangerInner })).not.toBe(stranger);
      } finally {
        rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    } finally {
      rmSync(stranger, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('walks to the topmost marker when no env anchor is set — the #1315 fix', () => {
    // With CLAUDE_PROJECT_DIR unset (the CLI case — it is NOT exported to
    // Bash-tool subprocesses), every state site used to take `process.cwd()`
    // raw and mint an island wherever it stood. The walk lands on the
    // canonical root instead, however deep the invocation.
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(resolveStateRoot({ cwd: deepDir })).toBe(root);
    expect(resolveStateRoot({ cwd: subWorkspace })).toBe(root);
  });

  it('does not cache a fall-through result, so flo init is not shadowed', () => {
    // A tree with NO moflo state anywhere resolves via Pass B/C. Caching that
    // would mean the anchor computed before `flo init` outlived the `.moflo/`
    // it then created — the resolver handing back a stale root is the exact
    // failure class this whole change exists to remove.
    const fresh = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-fresh-')));
    try {
      const inner = join(fresh, 'pkg');
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(fresh, 'package.json'), '{"name":"fresh"}');

      const before = resolveStateRoot({ cwd: inner });
      expect(before).toBe(fresh); // Pass C — nearest package.json

      // Now the project gets initialized ABOVE the previously-resolved root.
      seedMofloState(fresh);
      const after = resolveStateRoot({ cwd: inner });
      expect(after).toBe(fresh);

      // And a marker-proven result IS reused: deleting the marker afterwards
      // must not change the answer, proving it came from the memo.
      rmSync(join(fresh, '.moflo'), { recursive: true, force: true });
      expect(resolveStateRoot({ cwd: inner })).toBe(fresh);
    } finally {
      rmSync(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('never creates a .moflo directory as a side effect of resolving', () => {
    resolveStateRoot({ cwd: deepDir });
    resolveStateRoot({ cwd: subWorkspace });
    // The whole point of the bug: resolution must be read-only.
    expect(existsSync(join(deepDir, '.moflo'))).toBe(false);
    expect(existsSync(join(subWorkspace, '.moflo'))).toBe(false);
  });
});

describe('#1315 — daemon subcommands anchor on the resolved root', () => {
  // `start` alone is not enough. `getDaemon()` builds a WorkerDaemon whose
  // constructor unconditionally mkdirs `<root>/.moflo` and `<root>/.moflo/logs`,
  // so a cwd-anchored `status`/`trigger`/`enable` mints an island too — a
  // creation path independent of `start`. And a cwd-anchored `stop` cannot find
  // the root daemon that `start` now correctly binds.
  const src = readFileSync(join(HERE, '..', '..', 'commands', 'daemon.ts'), 'utf-8');

  it('every subcommand resolves its root instead of using cwd', () => {
    // start, stop, status, trigger, enable, install, uninstall.
    const uses = src.match(/resolveStateRoot\(\)/g) ?? [];
    expect(uses.length, 'expected 7 resolveStateRoot() call sites').toBe(7);
    expect(src, 'getDaemon must never be handed raw cwd')
      .not.toMatch(/getDaemon\(process\.cwd\(\)\)/);
  });

  it('leaves no cwd-anchored projectRoot in the daemon command family', () => {
    // `install`/`uninstall` matter most: `installDaemonService` bakes the root
    // into a launchd plist / systemd unit / schtasks entry, so a cwd-anchored
    // install persists an island across reboots.
    const anchors = src.match(/^\s*const projectRoot = process\.cwd\(\);/gm) ?? [];
    expect(anchors.length, 'no subcommand may anchor on cwd').toBe(0);
  });
});

describe('#1315 — daemon exits when its project root is deleted', () => {
  let dir: string;
  let daemon: WorkerDaemon | null = null;
  const savedDaemonEnv = process.env.MOFLO_DAEMON;

  beforeEach(() => {
    // CRITICAL: shutdownIfRootVanished calls process.exit(0) when
    // MOFLO_DAEMON === '1'. Vitest workers inherit the ambient environment, so
    // leaving it set would kill the test runner rather than fail a test.
    delete process.env.MOFLO_DAEMON;
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1315-root-')));
  });

  afterEach(async () => {
    try { await daemon?.stop(); } catch { /* already stopped */ }
    daemon = null;
    if (savedDaemonEnv === undefined) delete process.env.MOFLO_DAEMON;
    else process.env.MOFLO_DAEMON = savedDaemonEnv;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('keeps running while the root exists', async () => {
    daemon = new WorkerDaemon(dir, { autoStart: false });
    await daemon.start();
    const vanished = await (daemon as any).shutdownIfRootVanished();
    expect(vanished).toBe(false);
  });

  it('shuts down instead of recreating a deleted root', async () => {
    daemon = new WorkerDaemon(dir, { autoStart: false });
    // MUST start(): `stop()` early-returns when `running === false`, so a
    // daemon that was never started never reaches saveState()/log() — the
    // very writers that could recreate the husk. Asserting on an unstarted
    // daemon would pass vacuously without exercising the path under test.
    await daemon.start();

    // Simulate `git worktree remove`: the whole tree goes, daemon still alive.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    const vanished = await (daemon as any).shutdownIfRootVanished();
    expect(vanished).toBe(true);
    // The defining symptom of the bug: the husk must NOT come back, even
    // though shutdown ran the state-persist and logging paths.
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dir, '.moflo'))).toBe(false);
  });

  it('distinguishes ENOENT from a transient stat failure', () => {
    // `existsSync` swallows EVERY error and returns false, so EACCES / EIO / a
    // disconnected SMB share / a sleeping network volume would be
    // indistinguishable from "deleted" — and the daemon would exit(0) on one
    // bad sample. `statSync` + an explicit ENOENT check is the difference
    // between "the project is gone" and "I couldn't tell".
    //
    // Asserted at the source rather than by mocking: `node:fs` is a frozen ESM
    // namespace so `vi.spyOn` cannot replace `statSync`, and mocking the whole
    // module would also intercept the daemon's own writes. This pins the
    // invariant that actually regressed.
    const src = readFileSync(join(HERE, '..', '..', 'services', 'worker-daemon.ts'), 'utf-8');
    const fn = src.indexOf('private async shutdownIfRootVanished');
    expect(fn, 'shutdownIfRootVanished not found — renamed?').toBeGreaterThan(-1);
    const body = src.slice(fn, fn + 2000);
    // Strip comments — the explanation below deliberately NAMES the banned
    // call, and a naive scan would match its own rationale.
    const code = body
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

    expect(code, 'must stat, not existsSync').toMatch(/statSync\(this\.projectRoot\)/);
    expect(code, 'existsSync cannot distinguish EACCES from ENOENT').not.toMatch(/existsSync/);
    expect(code, 'only ENOENT means the root is gone').toMatch(/ENOENT/);
    // The self-exit gate must honor the legacy env prefix too, or a daemon
    // started from an older OS service unit clears its timers but never exits.
    expect(code, 'gate on readMofloEnv, not raw process.env.MOFLO_DAEMON')
      .toMatch(/readMofloEnv\('DAEMON'\)/);
  });
});

describe('#1315 — no state-minting site anchors on process.cwd()', () => {
  // Repo-wide guard. The per-file assertions above only covered daemon.ts, and
  // that is exactly how `runtime/headless.ts:runDaemon` was missed on the first
  // pass: `startDaemon(process.cwd())` builds a WorkerDaemon, and that
  // constructor mkdirs the state dir it is handed. Anything that CREATES
  // `.moflo/` must resolve its root first.
  const MINTING_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
    { re: /getDaemon\(process\.cwd\(\)\)/, why: 'WorkerDaemon ctor mkdirs .moflo + .moflo/logs' },
    { re: /startDaemon\(process\.cwd\(\)\)/, why: 'delegates to the WorkerDaemon ctor' },
    { re: /new WorkerDaemon\(process\.cwd\(\)/, why: 'ctor mkdirs .moflo + .moflo/logs' },
    { re: /new HeadlessWorkerExecutor\(process\.cwd\(\)/, why: 'ctor mkdirs .moflo/reports + logs/headless' },
    { re: /(?:path\.)?join\(process\.cwd\(\), *['"]\.moflo['"]/, why: 'builds a .moflo path from cwd' },
  ];

  function collectSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true }) as any[]) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const parent: string = entry.parentPath ?? entry.path;
      if (parent.includes('__tests__')) continue;
      out.push(join(parent, entry.name));
    }
    return out;
  }

  it('finds no cwd-anchored .moflo creation anywhere under src/cli', () => {
    const cliRoot = join(HERE, '..', '..');
    const offenders: string[] = [];
    for (const file of collectSourceFiles(cliRoot)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        // Ignore comments — several of them quote the old pattern on purpose.
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        for (const { re, why } of MINTING_PATTERNS) {
          if (re.test(line)) {
            offenders.push(`${relative(cliRoot, file)}:${i + 1} — ${why}`);
          }
        }
      });
    }
    expect(offenders, `use resolveStateRoot() instead:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

describe('#1315 — auto-start must not mint state', () => {
  it('maybeAutoStartDaemon bails instead of mkdir-ing a missing state dir', () => {
    // Source-level guard, mirroring tests/system/no-leaked-daemons.test.ts.
    // A behavioural test would have to spawn a real daemon; this pins the
    // invariant that actually regressed without that cost.
    const src = readFileSync(join(HERE, '..', '..', 'index.ts'), 'utf-8');
    const fn = src.indexOf('private async maybeAutoStartDaemon');
    expect(fn, 'maybeAutoStartDaemon not found — renamed?').toBeGreaterThan(-1);
    const body = src.slice(fn, fn + 3500);

    expect(body, 'auto-start must not create .moflo').not.toMatch(/mkdirSync/);
    expect(body, 'auto-start must return when state dir is absent')
      .toMatch(/if \(!existsSync\(stateDir\)\) return;/);
    expect(body, 'auto-start must anchor on the resolved root, not cwd')
      .toMatch(/resolveStateRoot\(\)/);
    expect(body, 'no raw process.cwd() anchoring left').not.toMatch(/loadMofloConfig\(process\.cwd\(\)\)/);
    expect(body, 'lock check must use the resolved root')
      .not.toMatch(/getDaemonLockHolder\(process\.cwd\(\)\)/);
  });
});
