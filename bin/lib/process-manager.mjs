/**
 * Shared background process manager for moflo.
 *
 * All background spawn paths (hooks.mjs, hook-handler.cjs, session-start-launcher.mjs)
 * delegate here so that PID tracking, dedup, and cleanup happen in one place.
 *
 * API:
 *   spawn(cmd, args, label)  — spawn with label-based dedup + PID tracking
 *   killAll()                — SIGTERM every tracked process, prune registry
 *   getActive()              — list currently alive tracked processes
 *   prune()                  — remove dead entries from registry
 *
 * Registry: .claude-flow/background-pids.json
 * Lock:     .claude-flow/spawn.lock  (30 s TTL — prevents thundering-herd)
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, statSync, openSync, closeSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOCK_TTL_MS = 30_000;

/** Resolve the project root (two levels up from bin/lib/). */
function defaultRoot() {
  return resolve(__dirname, '../..');
}

/** Ensure .claude-flow/ directory exists. */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Check if a PID is alive (cross-platform). */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Registry I/O ────────────────────────────────────────────────────────────

function registryPath(root) {
  return resolve(root, '.claude-flow', 'background-pids.json');
}

function lockPath(root) {
  return resolve(root, '.claude-flow', 'spawn.lock');
}

function readRegistry(root) {
  const p = registryPath(root);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Atomic write: write to tmp file then rename to avoid torn reads. */
function writeRegistry(root, entries) {
  const p = registryPath(root);
  const tmp = p + '.tmp.' + process.pid;
  ensureDir(dirname(p));
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, p);
}

// ── Lock (30 s TTL) ────────────────────────────────────────────────────────

function checkLock(root) {
  const lp = lockPath(root);
  if (!existsSync(lp)) return false;
  try {
    const age = Date.now() - statSync(lp).mtimeMs;
    return age < LOCK_TTL_MS;
  } catch {
    return false;
  }
}

/** Atomic lock acquisition using exclusive-create flag. */
function writeLock(root) {
  const lp = lockPath(root);
  ensureDir(dirname(lp));
  try {
    writeFileSync(lp, String(Date.now()), { flag: 'wx' });
  } catch {
    // File already exists — overwrite if stale, otherwise skip
    try {
      const age = Date.now() - statSync(lp).mtimeMs;
      if (age >= LOCK_TTL_MS) {
        unlinkSync(lp);
        writeFileSync(lp, String(Date.now()), { flag: 'wx' });
      }
    } catch { /* lost race on stale cleanup — non-fatal */ }
  }
}

function clearLock(root) {
  const lp = lockPath(root);
  try {
    if (existsSync(lp)) unlinkSync(lp);
  } catch { /* non-fatal */ }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a ProcessManager bound to a project root.
 * @param {string} [root] — project root (defaults to two levels above bin/lib/)
 */
export function createProcessManager(root) {
  const projectRoot = root || defaultRoot();

  return {
    /**
     * Spawn a background process with label-based dedup and PID tracking.
     *
     * If a process with the same `label` is already alive, the spawn is skipped.
     *
     * @param {string} cmd   — executable (e.g. 'node')
     * @param {string[]} args — arguments
     * @param {string} label — unique label for dedup (e.g. 'index-guidance')
     * @returns {{ pid: number|null, skipped: boolean }}
     */
    spawn(cmd, args, label) {
      // Dedup: skip if same label is already alive
      const entries = readRegistry(projectRoot);
      const existing = entries.find(e => e.label === label);
      if (existing && isAlive(existing.pid)) {
        return { pid: existing.pid, skipped: true };
      }

      try {
        // Redirect background process output to log file instead of /dev/null
        // This ensures errors from background indexers/pretrain are captured
        let stdio = 'ignore';
        try {
          const swarmDir = resolve(projectRoot, '.swarm');
          ensureDir(swarmDir);
          const logPath = resolve(swarmDir, 'background.log');
          const fd = openSync(logPath, 'a');
          stdio = ['ignore', fd, fd];
        } catch {
          // Fall back to ignore if log file can't be opened
        }

        const proc = spawn(cmd, args, {
          cwd: projectRoot,
          stdio,
          detached: true,
          shell: false,
          windowsHide: true,
        });

        // Swallow async spawn errors (e.g. ENOENT for bad command)
        proc.on('error', () => {});
        proc.unref();

        if (proc.pid) {
          // Remove any stale entry with the same label, then append new
          const fresh = entries.filter(e => e.label !== label);
          fresh.push({
            pid: proc.pid,
            label,
            cmd: `${cmd} ${args.join(' ')}`.substring(0, 200),
            startedAt: new Date().toISOString(),
          });
          writeRegistry(projectRoot, fresh);
        }

        return { pid: proc.pid || null, skipped: false };
      } catch {
        return { pid: null, skipped: false };
      }
    },

    /**
     * Kill all tracked background processes.
     * @returns {{ killed: number, total: number }}
     */
    killAll() {
      const entries = readRegistry(projectRoot);
      let killed = 0;

      for (const entry of entries) {
        if (!isAlive(entry.pid)) continue;
        try {
          process.kill(entry.pid, 'SIGTERM');
          killed++;
        } catch { /* already gone */ }
      }

      // Clear registry and lock
      writeRegistry(projectRoot, []);
      clearLock(projectRoot);

      return { killed, total: entries.length };
    },

    /**
     * Return list of currently alive tracked processes.
     * @returns {Array<{ pid: number, label: string, cmd: string, startedAt: string }>}
     */
    getActive() {
      const entries = readRegistry(projectRoot);
      return entries.filter(e => isAlive(e.pid));
    },

    /**
     * Remove dead entries from the registry.
     * @returns {{ pruned: number, remaining: number }}
     */
    prune() {
      const entries = readRegistry(projectRoot);
      const alive = entries.filter(e => isAlive(e.pid));
      writeRegistry(projectRoot, alive);
      return { pruned: entries.length - alive.length, remaining: alive.length };
    },

    /**
     * Check if the spawn lock is held (another session-restore spawned recently).
     */
    isLocked() {
      return checkLock(projectRoot);
    },

    /**
     * Acquire the spawn lock (30 s TTL).
     */
    acquireLock() {
      writeLock(projectRoot);
    },

    /**
     * Release the spawn lock.
     */
    releaseLock() {
      clearLock(projectRoot);
    },

    /** Expose the project root for callers that need it. */
    get root() {
      return projectRoot;
    },
  };
}
