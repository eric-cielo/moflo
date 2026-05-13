/**
 * TS bridge for `flo healer --fix -c memory-db-integrity` and any other
 * caller that wants the tiered repair (REINDEX → VACUUM INTO → row-level
 * salvage) implemented in {@link
 * "../../../bin/lib/db-repair.mjs".repairMemoryDbIfCorrupt} but with the
 * caller-side daemon coordination that the launcher path gets for free.
 *
 * The launcher (bin/session-start-launcher.mjs § 0c) runs the same repair
 * at session start after the daemon is already stopped. A mid-session
 * healer call needs to stop the daemon itself first — a live writer would
 * race the atomic swap on Windows (EBUSY on `renameSync`) and leak
 * corruption back through stale POSIX inodes elsewhere.
 *
 * Cross-platform notes:
 *  - `process.kill(pid, 'SIGTERM')` maps to `TerminateProcess` on Windows
 *    (Node maps every signal name to immediate termination on win32);
 *    behaves like POSIX SIGTERM on Linux/macOS. Either way the daemon
 *    exits before we touch the DB file.
 *  - Path resolution uses `import.meta.url` so dist/ and bin/ stay
 *    siblings whether moflo is running from a dogfood checkout or from a
 *    consumer's `node_modules/moflo/` install.
 *  - The MCP server (spawned by Claude Code per `.mcp.json`, not by moflo)
 *    is out of our process tree and cannot be stopped here. We surface
 *    explicit guidance to restart Claude Code in the caller's UX.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDaemonLockHolder, getDaemonLockPayload } from './daemon-lock.js';

export interface IntegrityRepairResult {
  /** True when the post-repair DB passes `PRAGMA integrity_check`. */
  repaired: boolean;
  /** Number of integrity_check violations on the pre-repair probe. */
  errors: number;
  /** Which tier of recovery succeeded (undefined when no repair ran). */
  tier?: 'reindex' | 'vacuum' | 'salvage';
  /** True when corruption survived every recovery tier. */
  persistent?: boolean;
  /** True when the live daemon was stopped to enable the repair (informational). */
  daemonStopped?: boolean;
  /** Path to the pre-repair backup retained for forensics (`.corrupt.<TS>` suffix). */
  corruptBackup?: string;
  /** Per-table read/written/error counts when the salvage tier ran. */
  lossStats?: Record<string, { read: number; written: number; errors: number }>;
}

type JsRepairFn = (projectRoot: string) => Promise<{
  repaired: boolean;
  errors: number;
  tier?: 'reindex' | 'vacuum' | 'salvage';
  persistent?: boolean;
  corruptBackup?: string;
  lossStats?: Record<string, { read: number; written: number; errors: number }>;
}>;

async function loadJsRepair(): Promise<JsRepairFn> {
  // Compiled location: dist/src/cli/services/this.js → up 4 → package root,
  // then bin/lib/db-repair.mjs. Identical relative layout in dogfood and
  // node_modules/moflo/ installs.
  const repairUrl = new URL('../../../../bin/lib/db-repair.mjs', import.meta.url);
  const mod = (await import(repairUrl.href)) as { repairMemoryDbIfCorrupt: JsRepairFn };
  return mod.repairMemoryDbIfCorrupt;
}

/**
 * Send a SIGTERM-equivalent to the daemon PID and clear the lockfile.
 * Returns true if a live daemon was actually stopped. Cross-platform:
 * `process.kill` accepts the signal name on all platforms; Node treats it
 * as an immediate terminate on Windows.
 */
function stopDaemon(projectRoot: string): boolean {
  const payload = getDaemonLockPayload(projectRoot);
  if (!payload?.pid || payload.pid <= 0) return false;
  try {
    process.kill(payload.pid, 'SIGTERM');
  } catch {
    // ESRCH (already dead) or EPERM — treat both as "nothing to stop".
    return false;
  }
  const lockFile = join(projectRoot, '.moflo', 'daemon.lock');
  try { if (existsSync(lockFile)) unlinkSync(lockFile); } catch { /* */ }
  return true;
}

export interface RepairOptions {
  /** Default true. When the daemon is alive, stop it before the repair. */
  stopDaemonFirst?: boolean;
}

/**
 * Run the tiered repair against the project's `.moflo/moflo.db`.
 *
 * Default behavior is to stop the daemon if alive (cross-platform via
 * `process.kill('SIGTERM')`) so the atomic swap doesn't race a live writer.
 * Pass `stopDaemonFirst: false` to suppress that — the launcher path uses
 * this because its own daemon-stop already ran before § 0c.
 *
 * Never throws; any internal error surfaces as
 * `{ repaired: false, errors: 0, persistent: true }`.
 */
export async function repairMemoryDbIntegrity(
  projectRoot: string = process.cwd(),
  options: RepairOptions = {},
): Promise<IntegrityRepairResult> {
  const root = resolve(projectRoot);
  const stopFirst = options.stopDaemonFirst !== false;

  let daemonStopped = false;
  if (stopFirst && getDaemonLockHolder(root) !== null) {
    daemonStopped = stopDaemon(root);
  }

  try {
    const repair = await loadJsRepair();
    const result = await repair(root);
    return { ...(result as IntegrityRepairResult), daemonStopped };
  } catch {
    return { repaired: false, errors: 0, persistent: true, daemonStopped };
  }
}
