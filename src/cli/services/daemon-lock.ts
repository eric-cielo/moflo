/**
 * Atomic daemon lock — prevents duplicate daemon processes.
 *
 * Uses fs.writeFileSync with { flag: 'wx' } (O_CREAT | O_EXCL) which is
 * atomic on all platforms: the write fails immediately if the file exists,
 * eliminating the TOCTOU race in the old PID-file approach.
 *
 * Also solves Windows PID recycling by storing a label in the lock payload
 * and verifying the process command line before trusting a "live" PID.
 */

import * as fs from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { normalizeProjectRoot } from './daemon-port.js';

export interface DaemonLockPayload {
  pid: number;
  startedAt: number;
  label: string;
  /**
   * Moflo package version the daemon was launched from. Added in epic #1054
   * to detect daemons that survived an `npm install moflo@<new>` and are now
   * running pre-upgrade code against post-upgrade on-disk state. Missing on
   * locks written by pre-#1054 daemons; the launcher treats absent version
   * the same as a mismatch (recycle).
   */
  version?: string;
  /**
   * Actual port the daemon's HTTP server bound to. Added in #1145 so clients
   * can discover the bound port from the lock file rather than guessing the
   * fixed default (which produced silent cross-project routing when two
   * moflo daemons collided). Stamped by `writeLockPort()` after a successful
   * bind. Missing on locks written by pre-#1145 daemons; clients fall back
   * to `resolveProjectPort()` then `LEGACY_DEFAULT_PORT`.
   */
  port?: number;
}

const LOCK_FILENAME = 'daemon.lock';
const LOCK_LABEL = 'moflo-daemon';

/** Resolve the lock file path for a project root. */
export function lockPath(projectRoot: string): string {
  return join(projectRoot, '.moflo', LOCK_FILENAME);
}

/**
 * Read this daemon's own moflo package version by walking up from the
 * compiled module location until a `package.json` with `"name": "moflo"`
 * is found. Mirrors the pattern in `mcp-server.ts:260-279`. Returns
 * `undefined` if the package.json can't be located — the launcher treats
 * an undefined version the same as a mismatch, so this stays safe.
 */
export function readOwnMofloVersion(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      try {
        const pkg = JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === 'moflo' && typeof pkg.version === 'string') return pkg.version;
      } catch { /* ignore — keep walking */ }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/**
 * Try to acquire the daemon lock atomically.
 *
 * Before the EEXIST atomic write, runs a same-project orphan scan (#1150):
 * enumerates moflo daemon processes whose command line is rooted at THIS
 * project's CLI binary. If any are found that the lock doesn't account for,
 * they get SIGTERM'd (3s graceful → SIGKILL) before we try to acquire.
 * Catches the failure mode where the lock was unlinked (e.g. by an old
 * doctor-fix or a crashed shutdown handler) but the daemon process is still
 * alive — without this scan, a fresh daemon would spawn alongside it.
 *
 * Tests can opt out of the scan via `MOFLO_TEST_SKIP_ORPHAN_SCAN=1` (the same
 * env-var also disables the post-spawn fallback in #1086 so vitest workers
 * don't pay the 8s Windows introspection cost on every acquire).
 *
 * @returns `{ acquired: true }` on success,
 *          `{ acquired: false, holder: pid }` if another daemon owns the lock.
 */
export function acquireDaemonLock(
  projectRoot: string,
  pid: number = process.pid,
  /**
   * Pre-computed project-daemon PIDs for the pre-acquire reap. When supplied,
   * the reap skips the OS process scan (`findProjectDaemonPids`) and operates
   * on exactly these PIDs. A caller that already enumerated project daemons
   * passes them here to avoid a redundant scan; tests use it to make the reap
   * deterministic instead of depending on the contention-sensitive cold-shell
   * scan (mirrors the `pidsHint` seam on `reapSameProjectOrphans`).
   */
  opts: { pidsHint?: number[] } = {},
): { acquired: true } | { acquired: false; holder: number } {
  const lock = lockPath(projectRoot);
  const stateDir = join(projectRoot, '.moflo');

  // Ensure state directory exists
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // #1150 — same-project orphan scan. Runs BEFORE the atomic write because
  // (a) it lets us reclaim the lock after a crash that left the daemon
  //     running but the lock unlinked, and
  // (b) the second-spawn case (lock absent, prior daemon alive) is exactly
  //     the failure mode that produced two-daemons-per-project in #1145's
  //     waxstack audit.
  const lockHolderPid = readLockPayload(lock)?.pid;
  reapSameProjectOrphans(projectRoot, pid, lockHolderPid, opts.pidsHint);

  const payload: DaemonLockPayload = {
    pid,
    startedAt: Date.now(),
    label: LOCK_LABEL,
    version: readOwnMofloVersion(),
  };

  // Attempt 1: atomic exclusive create
  const result = tryExclusiveWrite(lock, payload);
  if (result === 'ok') {
    return { acquired: true };
  }

  // File already exists — check if the holder is still a live daemon
  const existing = readLockPayload(lock);
  if (!existing) {
    // Corrupt or unreadable — remove and retry once
    safeUnlink(lock);
    return tryExclusiveWrite(lock, payload) === 'ok'
      ? { acquired: true }
      : { acquired: false, holder: -1 };
  }

  // Same PID as us? We already hold it (re-entrant).
  if (existing.pid === pid) {
    return { acquired: true };
  }

  // Is the process alive AND actually a moflo daemon?
  if (isProcessAlive(existing.pid) && isDaemonProcess(existing.pid)) {
    return { acquired: false, holder: existing.pid };
  }

  // Stale lock (dead process or recycled PID) — remove and retry once
  safeUnlink(lock);
  return tryExclusiveWrite(lock, payload) === 'ok'
    ? { acquired: true }
    : { acquired: false, holder: -1 };
}

/**
 * Release the daemon lock. Only removes if we own it (or force = true).
 */
export function releaseDaemonLock(projectRoot: string, pid: number = process.pid, force = false): void {
  const lock = lockPath(projectRoot);
  if (!fs.existsSync(lock)) return;

  if (force) {
    safeUnlink(lock);
    return;
  }

  const existing = readLockPayload(lock);
  if (existing && existing.pid === pid) {
    safeUnlink(lock);
  }
}

/**
 * Stamp the daemon's bound HTTP port into the lock file (#1145).
 *
 * Called by `daemon-dashboard.startDashboard()` after a successful bind so
 * clients can read the actual port (vs. guessing the fixed default and
 * silently hitting another project's daemon).
 *
 * Best-effort by design:
 *   - Missing lock → no-op (the daemon didn't acquire the lock; this is
 *     a test or unusual startup path).
 *   - Lock owned by a different PID → no-op (we don't overwrite locks we
 *     don't own).
 *   - Write failure → swallowed (the daemon still serves; clients fall
 *     back to the deterministic port resolution).
 *
 * Returns `true` on a successful stamp, `false` otherwise. The boolean is
 * informational — production callers don't branch on it.
 */
export function writeLockPort(
  projectRoot: string,
  port: number,
  pid: number = process.pid,
): boolean {
  if (!Number.isFinite(port) || port < 1 || port > 65535) return false;
  const lock = lockPath(projectRoot);
  const existing = readLockPayload(lock);
  if (!existing) return false;
  if (existing.pid !== pid) return false;
  if (existing.port === port) return true;

  const updated: DaemonLockPayload = { ...existing, port };
  try {
    // Atomic write-then-rename: a client reading mid-write never sees a
    // truncated JSON. The vulnerable window is precisely a re-stamp after
    // a daemon recycle on a different port, when clients are likeliest
    // to be probing the lock for the new port.
    atomicWriteFileSync(lock, JSON.stringify(updated));
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically transfer the daemon lock to a new PID (e.g. parent → child).
 *
 * Overwrites the lock file in-place so there is no window where the lock
 * is absent.  Only succeeds if the lock is currently held by `fromPid`.
 */
export function transferDaemonLock(
  projectRoot: string,
  newPid: number,
  fromPid: number = process.pid,
): boolean {
  const lock = lockPath(projectRoot);
  const existing = readLockPayload(lock);

  if (!existing || existing.pid !== fromPid) {
    return false; // We don't own the lock — can't transfer
  }

  const payload: DaemonLockPayload = {
    pid: newPid,
    startedAt: Date.now(),
    label: LOCK_LABEL,
    version: existing.version ?? readOwnMofloVersion(),
    // Preserve the port field across PID transfers (#1145) — the child
    // process inherits the parent's binding, so the port is still valid.
    ...(existing.port != null ? { port: existing.port } : {}),
  };

  try {
    // Atomic overwrite — no unlink/recreate gap
    fs.writeFileSync(lock, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the full daemon-lock payload (or null if no daemon, corrupt lock,
 * or the holder is dead). Used by the launcher to compare the daemon's
 * reported moflo version against the installed package.json version
 * (epic #1054 — kill stale daemons that survived `npm install moflo@new`).
 */
export function getDaemonLockPayload(projectRoot: string): DaemonLockPayload | null {
  const lock = lockPath(projectRoot);
  if (!fs.existsSync(lock)) return null;

  const existing = readLockPayload(lock);
  if (!existing) {
    safeUnlink(lock);
    return null;
  }

  if (isProcessAlive(existing.pid) && isDaemonProcess(existing.pid)) {
    return existing;
  }

  safeUnlink(lock);
  return null;
}

/**
 * Check if the daemon lock is currently held by a live daemon.
 * Returns the holder PID or null.
 */
export function getDaemonLockHolder(projectRoot: string): number | null {
  const lock = lockPath(projectRoot);

  if (!fs.existsSync(lock)) return null;

  const existing = readLockPayload(lock);
  if (!existing) {
    // Corrupt lock file — clean it up
    safeUnlink(lock);
    return null;
  }

  if (isProcessAlive(existing.pid) && isDaemonProcess(existing.pid)) {
    return existing.pid;
  }

  // Stale — clean it up opportunistically
  safeUnlink(lock);
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryExclusiveWrite(path: string, payload: DaemonLockPayload): 'ok' | 'exists' {
  try {
    fs.writeFileSync(path, JSON.stringify(payload), { flag: 'wx' });
    return 'ok';
  } catch (err: any) {
    if (err.code === 'EEXIST') return 'exists';
    // Other errors (permissions, disk full) — treat as failure to acquire
    return 'exists';
  }
}

function readLockPayload(path: string): DaemonLockPayload | null {
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (typeof data.pid === 'number' && typeof data.startedAt === 'number') {
      return data as DaemonLockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function safeUnlink(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch { /* ignore — file may already be gone */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Linux zombie handling: `kill(pid, 0)` succeeds for zombie processes
  // (exited but not yet reaped). A zombie can't write to the DB or hold
  // a lock, so treating it as alive exhausts the kill window polling a
  // corpse. Read /proc/<pid>/stat and treat 'Z' as dead — same logic as
  // bin/lib/daemon-recycler.mjs:51-69. The case surfaces in tests AND
  // in any production path where the daemon and our process share a
  // parent (foreground mode, vitest worker that spawned a child); on
  // standard detached-daemon production paths init reaps so this is a
  // no-op there.
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const lastParen = stat.lastIndexOf(')');
      if (lastParen !== -1 && stat.charAt(lastParen + 2) === 'Z') return false;
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return false;
      // /proc unavailable — fall through with the kill(0) verdict.
    }
  }
  return true;
}

/**
 * Cross-platform check: is this PID actually a moflo/claude-flow daemon?
 *
 * This prevents false positives from Windows PID recycling, where a dead
 * daemon's PID gets reused by an unrelated process (e.g. Chrome).
 *
 * - Windows: uses `tasklist /FI` to check the process image + command line
 * - Linux:   reads /proc/<pid>/cmdline
 * - macOS:   uses `ps -p <pid> -o command=`
 *
 * Falls back to `true` (trust process.kill) if the platform check fails,
 * to avoid accidentally allowing duplicates on exotic platforms.
 */
export function isDaemonProcess(pid: number): boolean {
  // #1086: Windows execSync introspection (8s worst-case: tasklist 3s +
  // powershell 5s) starves under parallel vitest workers and pushes tests
  // past the 5s budget. Production never sets this env var.
  if (process.env.MOFLO_TEST_TRUST_DAEMON_PID === '1') {
    return true;
  }
  try {
    if (process.platform === 'win32') {
      return isDaemonProcessWindows(pid);
    } else if (process.platform === 'linux') {
      return isDaemonProcessLinux(pid);
    } else {
      // macOS and others
      return isDaemonProcessUnix(pid);
    }
  } catch {
    // If platform check fails, trust the kill(0) result to avoid
    // accidentally allowing duplicates
    return true;
  }
}

function isDaemonProcessWindows(pid: number): boolean {
  try {
    const result = execSync(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    );
    // tasklist returns the image name + PID in CSV; check it's a node process
    // and then verify via wmic/powershell that the command line contains daemon keywords
    if (!result.includes('node')) return false;

    const cmdResult = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    );
    return /daemon\s+start|moflo|claude-flow/i.test(cmdResult);
  } catch {
    return true; // fallback: trust kill(0)
  }
}

function isDaemonProcessLinux(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return /daemon.*start|moflo|claude-flow/i.test(cmdline);
  } catch {
    return true; // fallback
  }
}

function isDaemonProcessUnix(pid: number): boolean {
  try {
    const result = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return /daemon.*start|moflo|claude-flow/i.test(result);
  } catch {
    return true; // fallback
  }
}

// ---------------------------------------------------------------------------
// Same-project orphan detection (#1150)
// ---------------------------------------------------------------------------

/**
 * Enumerate moflo daemon node processes whose command line is rooted at THIS
 * project's CLI binary (consumer install OR dogfood-source).
 *
 * Returns PIDs. Used by `acquireDaemonLock` (pre-acquire reap) and the
 * `daemon-orphan` doctor check/fix.
 *
 * Matching strategy: cmdline must contain BOTH a moflo daemon marker
 * (`daemon ... start` + `moflo`/`claude-flow`) AND one of the two
 * project-rooted cli.js paths. This keeps daemons for OTHER projects out of
 * scope — they have their own project root and (post-#1145) their own port.
 *
 * Cross-platform:
 *   - Windows: `Get-CimInstance Win32_Process` via PowerShell (single shell
 *     invocation that returns all node processes with command lines).
 *   - Linux:   `/proc/<pid>/cmdline` walk.
 *   - macOS:   `ps -axo pid,command` (no `/proc`).
 *
 * Falls back to `[]` if the platform probe fails — better to spawn an extra
 * daemon than to wrongly kill a foreign-project one.
 */
export function findProjectDaemonPids(
  projectRoot: string,
  opts: { pidsHint?: Array<{ pid: number; cmdline: string }> } = {},
): number[] {
  if (process.env.MOFLO_TEST_SKIP_ORPHAN_SCAN === '1') return [];

  const candidates = projectCliCandidates(projectRoot);
  if (candidates.length === 0) return [];

  let processes: Array<{ pid: number; cmdline: string }>;
  if (opts.pidsHint) {
    processes = opts.pidsHint;
  } else {
    try {
      if (process.platform === 'win32') processes = listMofloDaemonsWindows();
      else if (process.platform === 'linux') processes = listMofloDaemonsLinux();
      else processes = listMofloDaemonsUnix();
    } catch {
      return [];
    }
  }

  return processes.filter(p => cmdlineMatchesProject(p.cmdline, candidates)).map(p => p.pid);
}

/**
 * Candidate absolute paths for THIS project's daemon CLI binary.
 *
 * Returns the two layouts moflo ships with — consumer install
 * (`<root>/node_modules/moflo/bin/cli.js`) and dogfood-source
 * (`<root>/bin/cli.js`) — normalised for case-insensitive substring match
 * via the shared `normalizeProjectRoot` helper (which realpaths + lowercases
 * on Windows, matching the #1145 daemon-identity surface so the two checks
 * agree about which root a process belongs to).
 *
 * Never includes the bare `projectRoot` prefix as a match candidate: an
 * unrelated process (editor, npm script) whose cmdline happens to mention
 * the project path would otherwise false-positive once the daemon-marker
 * regex also incidentally matched.
 */
function projectCliCandidates(projectRoot: string): string[] {
  const cliRelatives = [
    join('node_modules', 'moflo', 'bin', 'cli.js'),
    join('bin', 'cli.js'),
  ];
  // realpath both the input AND each candidate path — on macOS the
  // command-line records the realpath'd form (`/private/var/folders/...`)
  // while the cwd-rooted candidate stays under `/var/folders/...`.
  const normRoot = normalizeProjectRoot(projectRoot);
  const out = new Set<string>();
  for (const rel of cliRelatives) {
    // Apply normalizeForMatch ON TOP of normalizeProjectRoot so the
    // substring match also tolerates mixed separators in the spawn-recorded
    // cmdline ("\\" vs "/"). `normalizeProjectRoot` realpaths + lowercases
    // on Windows; `normalizeForMatch` collapses slashes.
    out.add(normalizeForMatch(normalizeProjectRoot(join(projectRoot, rel))));
    out.add(normalizeForMatch(normalizeProjectRoot(join(normRoot, rel))));
  }
  return Array.from(out).filter(s => s.length > 0);
}

function cmdlineMatchesProject(cmdline: string, candidates: string[]): boolean {
  // Daemon marker — must look like a moflo daemon to even consider matching.
  if (!/daemon[\s\S]{0,40}start/i.test(cmdline)) return false;
  if (!/moflo|claude-flow/i.test(cmdline)) return false;

  // Substring match against case-folded, slash-normalised forms.
  const norm = normalizeForMatch(cmdline);
  return candidates.some(c => c.length > 0 && norm.includes(c));
}

function normalizeForMatch(p: string): string {
  // Collapse mixed slashes to the OS separator so the substring check works
  // regardless of how spawn quoted the path. Case-fold on Windows.
  const collapsed = p.replace(/[\\/]+/g, sep);
  return process.platform === 'win32' ? collapsed.toLowerCase() : collapsed;
}

function listMofloDaemonsWindows(): Array<{ pid: number; cmdline: string }> {
  // Use execFileSync so the PS command is passed as a single argument vector
  // (no cmd.exe quote-mangling). The `@($res)` array-cast handles the
  // single-result case (`ConvertTo-Json` emits a bare object otherwise, and
  // `-AsArray` is PS 6+ only). The `if ($res)` guard avoids emitting an
  // empty string that JSON.parse can't read.
  const script =
    "$res = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" " +
    "| Select-Object ProcessId, CommandLine; " +
    "if ($res) { @($res) | ConvertTo-Json -Compress -Depth 3 }";
  let raw: string;
  try {
    raw = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed
    .filter((p: any) => p && typeof p.CommandLine === 'string' && p.CommandLine.length > 0)
    .map((p: any) => ({ pid: Number(p.ProcessId), cmdline: String(p.CommandLine) }))
    .filter((p: any): p is { pid: number; cmdline: string } => Number.isFinite(p.pid) && p.pid > 0);
}

function listMofloDaemonsLinux(): Array<{ pid: number; cmdline: string }> {
  const out: Array<{ pid: number; cmdline: string }> = [];
  let entries: string[];
  try { entries = fs.readdirSync('/proc'); } catch { return []; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    try {
      // cmdline is NUL-separated argv. Replace NULs with spaces for matching.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      if (!raw) continue;
      const cmdline = raw.replace(/\0+$/, '').replace(/\0/g, ' ');
      if (!/\bnode\b/i.test(cmdline) && !/\.js\b/.test(cmdline)) continue;
      out.push({ pid, cmdline });
    } catch { /* process exited mid-scan / no perms — skip */ }
  }
  return out;
}

function listMofloDaemonsUnix(): Array<{ pid: number; cmdline: string }> {
  let raw: string;
  try {
    // -axww = all processes including session leaders (BSD form portable to
    // macOS/Linux), unlimited line width so long cmdlines don't truncate.
    // execFileSync (no shell) keeps quoting consistent with the rest of the
    // codebase.
    raw = execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out: Array<{ pid: number; cmdline: string }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf(' ');
    if (sepIdx === -1) continue;
    const pid = parseInt(trimmed.slice(0, sepIdx), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const cmdline = trimmed.slice(sepIdx + 1).trim();
    if (!/\bnode\b/i.test(cmdline) && !/\.js\b/.test(cmdline)) continue;
    out.push({ pid, cmdline });
  }
  return out;
}

/**
 * Same-project orphan reap. Called from `acquireDaemonLock` BEFORE the atomic
 * write. PIDs that match the lock-holder OR our own process are skipped.
 *
 * Best-effort: failures during kill are swallowed because the next step
 * (atomic exclusive write of the lock) is the source of truth — if the
 * orphan survives, the lock-acquire still fails cleanly and the caller
 * reports a stale lock-holder rather than spawning a duplicate.
 *
 * Exported for the `Daemon Orphan` healer fix which reuses the same logic.
 */
export function reapSameProjectOrphans(
  projectRoot: string,
  ownPid: number = process.pid,
  lockHolderPid?: number,
  /**
   * Pre-computed project-daemon PIDs. Skips re-running the OS process scan
   * when the caller already has them — the `Daemon Orphan` doctor-fix
   * computes them once via `findProjectDaemonPids` and then reuses the
   * same list here.
   */
  pidsHint?: number[],
): { reaped: number[]; survived: number[] } {
  const reaped: number[] = [];
  const survived: number[] = [];

  const allPids = pidsHint ?? findProjectDaemonPids(projectRoot);
  const foreignPids = allPids.filter(p => {
    if (p === ownPid) return false;
    if (lockHolderPid != null && p === lockHolderPid) return false;
    return true;
  });
  if (foreignPids.length === 0) return { reaped, survived };

  for (const pid of foreignPids) {
    if (terminateOrphan(pid)) reaped.push(pid);
    else survived.push(pid);
  }
  return { reaped, survived };
}

/**
 * Terminate a same-project daemon orphan: SIGTERM → 3s graceful poll →
 * SIGKILL (POSIX) / `taskkill /F /T` (Windows). Returns true once the PID
 * is no longer alive.
 */
function terminateOrphan(pid: number): boolean {
  if (!isProcessAlive(pid)) return true;

  try {
    if (process.platform === 'win32') {
      // No SIGTERM equivalent for our detached Node daemon on Windows — go
      // straight to /F /T (same shape as bin/lib/daemon-recycler.mjs and
      // killBackgroundDaemon). execFileSync keeps args un-shell-quoted.
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          timeout: 3000,
        });
      } catch { /* already exiting */ }
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
  } catch { /* fall through to liveness poll */ }

  // Graceful window
  const gracefulDeadline = Date.now() + 3000;
  while (Date.now() < gracefulDeadline && isProcessAlive(pid)) {
    sleepSyncMs(100);
  }

  if (!isProcessAlive(pid)) return true;

  // Escalate. The first kill can fail to land when spawning the OS helper is
  // starved under heavy fork contention — a cold `taskkill.exe` load on Windows
  // exceeding its exec timeout leaves the process alive with no second attempt.
  // Escalate with an IN-PROCESS kill that spawns nothing and is therefore immune
  // to that contention:
  //   - POSIX:   SIGKILL.
  //   - Windows: process.kill maps to TerminateProcess (libuv) for any same-user
  //     PID — no subprocess, unlike taskkill. The earlier taskkill /T already
  //     best-effort-killed the process tree; this guarantees the main PID dies.
  // (Production value: a transiently-failed reap is the exact #1150 failure mode
  // — a surviving orphan a fresh daemon then spawns alongside.)
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }

  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline && isProcessAlive(pid)) {
    sleepSyncMs(100);
  }
  return !isProcessAlive(pid);
}

function sleepSyncMs(ms: number): void {
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    // SharedArrayBuffer disabled (rare — exotic Node flags); fall back to a
    // tight loop. Caller's wait windows are bounded so this is safe.
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin */ }
  }
}
