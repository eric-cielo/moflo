#!/usr/bin/env node
/**
 * Detached recycler for §2a of session-start-launcher.mjs.
 *
 * The launcher used to inline the kill-and-restart synchronously, which kept
 * up to 500ms of liveness-polling in the foreground — fine on Linux, but on
 * Windows under the SessionStart hook's 3000ms timeout it eroded the budget
 * that's supposed to be spent on real work. Per the launcher's contract
 * ("spawns background tasks via spawn(detached + unref) and exits
 * immediately"), the daemon recycle belongs in a detached worker.
 *
 * Invocation (from §2a, via fireAndForget):
 *   node bin/lib/daemon-recycler.mjs <projectRoot> <pid> <installedVersion>
 *
 * Steps:
 *   1. Force-kill <pid> (Windows: taskkill /F /T, Unix: SIGKILL). Skip
 *      graceful — by this point the launcher has already decided the daemon
 *      is running stale code and its shutdown handlers are stale too.
 *   2. Poll liveness up to 5s. Unlink the lockfile only once the PID is gone,
 *      so a surviving daemon can't re-attach to the unlinked path.
 *   3. Spawn `node node_modules/moflo/bin/cli.js daemon start --quiet`
 *      detached + unref so this recycler can exit immediately.
 *
 * Output is intentionally silent — there's no parent to read it. Failures are
 * surfaced via `.moflo/daemon-recycle.last.json` for `flo doctor` to read.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , projectRootArg, pidArg, installedVersion] = process.argv;

if (!projectRootArg || !pidArg) {
  // No way to surface this — the launcher fire-and-forgets us, no parent
  // captures stderr. Bail silently.
  process.exit(2);
}

const projectRoot = resolve(projectRootArg);
const pid = Number.parseInt(pidArg, 10);
const lockFile = join(projectRoot, '.moflo', 'daemon.lock');

function isAlive(p) {
  if (!p || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function sleepSyncMs(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function writeOutcome(status, detail) {
  try {
    writeFileSync(
      join(projectRoot, '.moflo', 'daemon-recycle.last.json'),
      JSON.stringify(
        {
          status,
          detail,
          pid,
          installedVersion: installedVersion ?? null,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch { /* best-effort — doctor reads this file optionally */ }
}

// ── 1. Force-kill ───────────────────────────────────────────────────────────
if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* dead or unreachable — liveness poll below confirms */ }
}

// ── 2. Wait for death, then unlink the lockfile ─────────────────────────────
const deadline = Date.now() + 5000;
let killed = !isAlive(pid);
while (!killed && Date.now() < deadline) {
  sleepSyncMs(100);
  killed = !isAlive(pid);
}

if (!killed) {
  writeOutcome('kill-failed', `PID ${pid} survived 5s force-kill window`);
  process.exit(1);
}

// Only unlink once we know nothing's holding the lock file's old identity.
// A surviving daemon would re-write a lockfile with its stale PID + version
// and defeat the whole purpose of the recycle.
try {
  if (existsSync(lockFile)) {
    // Defensive: if the lockfile has been re-written under us (another
    // recycler raced), only unlink if the PID still matches what we killed.
    try {
      const current = JSON.parse(readFileSync(lockFile, 'utf-8'));
      if (typeof current?.pid === 'number' && current.pid !== pid) {
        writeOutcome('lock-changed', `another daemon (PID ${current.pid}) wrote the lock; leaving it alone`);
        process.exit(0);
      }
    } catch { /* unreadable / malformed — fall through and unlink */ }
    unlinkSync(lockFile);
  }
} catch { /* non-fatal */ }

// ── 3. Spawn fresh daemon, detached + unref ─────────────────────────────────
const cliPath = join(projectRoot, 'node_modules', 'moflo', 'bin', 'cli.js');
if (existsSync(cliPath)) {
  try {
    const child = spawn('node', [cliPath, 'daemon', 'start', '--quiet'], {
      cwd: projectRoot,
      stdio: 'ignore',
      detached: true,
      shell: false,
      windowsHide: true,
    });
    child.unref();
    writeOutcome('ok', 'fresh daemon spawn requested');
  } catch (err) {
    writeOutcome('spawn-failed', err && err.message ? err.message : String(err));
    process.exit(1);
  }
} else {
  writeOutcome('cli-missing', `node_modules/moflo/bin/cli.js not present at ${cliPath}`);
  process.exit(1);
}

// Recycler's job is done. Exit fast.
process.exit(0);
