/**
 * Zombie process detection + cleanup for `flo doctor`.
 *
 * "Orphaned" means the parent is no longer alive — nothing will clean it up.
 * MCP servers spawned by a live Claude Code session have a live parent
 * (claude.exe) and must NOT be flagged. The shared ProcessManager registry
 * (.moflo/background-pids.json) is treated as an allowlist for legitimate
 * detached background tasks (sequential indexer chain, daemon, MCP servers).
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDaemonLockHolder, isDaemonProcess, releaseDaemonLock } from '../services/daemon-lock.js';
import type { HealthCheck } from './doctor-types.js';

// Cmdline capture/display caps + scan timeouts. Hoisted so the values
// used to size buffers and format messages are visible in one place.
const ZOMBIE_CMDLINE_CAPTURE_LEN = 200;
const ZOMBIE_CMDLINE_DISPLAY_LEN = 100;
const ZOMBIE_SCAN_TIMEOUT_MS_WIN = 10_000;
const ZOMBIE_SCAN_TIMEOUT_MS_POSIX = 5_000;
const ZOMBIE_KILL_TIMEOUT_MS = 5_000;
const NODE_PREFIX_RE = /^"?[^"\s]*node(?:\.exe)?"?\s+/i;

export function formatCmdline(raw: string): string {
  const cleaned = raw.replace(NODE_PREFIX_RE, '').trim();
  return cleaned.length > ZOMBIE_CMDLINE_DISPLAY_LEN
    ? cleaned.slice(0, ZOMBIE_CMDLINE_DISPLAY_LEN - 1) + '…'
    : cleaned;
}

export interface ZombieDetail {
  pid: number;
  ppid: number;
  cmdline: string;
}

export function formatZombieDetail(d: ZombieDetail): string {
  return `pid=${d.pid} ppid=${d.ppid} cmd=${formatCmdline(d.cmdline)}`;
}

export interface ZombieScanResult {
  killed: number;
  details: ZombieDetail[];
}

// Cross-platform liveness probe via signal 0 — Node abstracts the platform.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Fast path: kill processes tracked in the shared ProcessManager registry.
// This avoids the expensive OS-level process scan for known background tasks.
export function killTrackedProcesses(): number {
  const registryFile = join(process.cwd(), '.moflo', 'background-pids.json');
  const lockFile = join(process.cwd(), '.moflo', 'spawn.lock');
  let killed = 0;
  try {
    if (existsSync(registryFile)) {
      const entries = JSON.parse(readFileSync(registryFile, 'utf-8'));
      for (const entry of entries) {
        if (!isProcessAlive(entry.pid)) continue;
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /F /PID ${entry.pid}`, { timeout: 5000, windowsHide: true });
          } else {
            process.kill(entry.pid, 'SIGKILL');
          }
          killed++;
        } catch { /* already gone */ }
      }
      writeFileSync(registryFile, '[]');
    }
  } catch { /* non-fatal */ }
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch { /* ok */ }
  return killed;
}

// Read the set of moflo background PIDs registered with the shared
// ProcessManager (.moflo/background-pids.json). These are legitimate tracked
// background tasks (sequential indexer chain, daemon, MCP servers spawned by
// session-start) — they are detached:true by design so their parents have
// already exited, but they are NOT orphans. Without this allow-set,
// findZombieProcesses() flags every running indexer step as a zombie.
function readTrackedBackgroundPids(): Set<number> {
  const result = new Set<number>();
  const registryFile = join(process.cwd(), '.moflo', 'background-pids.json');
  try {
    if (!existsSync(registryFile)) return result;
    const entries = JSON.parse(readFileSync(registryFile, 'utf-8'));
    if (!Array.isArray(entries)) return result;
    for (const entry of entries) {
      if (entry && typeof entry.pid === 'number' && entry.pid > 0) {
        result.add(entry.pid);
      }
    }
  } catch { /* malformed or unreadable — treat as empty */ }
  return result;
}

// Find and optionally kill orphaned moflo/claude-flow node processes.
export async function findZombieProcesses(kill = false): Promise<ZombieScanResult> {
  const legitimatePid = getDaemonLockHolder(process.cwd());
  const trackedPids = readTrackedBackgroundPids();
  const currentPid = process.pid;
  const parentPid = process.ppid;
  const details: ZombieDetail[] = [];
  let killed = 0;

  const candidates: ZombieDetail[] = [];

  try {
    if (process.platform === 'win32') {
      // CSV output preserves full CommandLine; Format-Table truncates to console width.
      const result = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"',
        { encoding: 'utf-8', timeout: ZOMBIE_SCAN_TIMEOUT_MS_WIN, windowsHide: true },
      );
      const lines = result.split(/\r?\n/);
      for (const line of lines) {
        if (!/moflo|claude-flow|flo\s+(hooks|gate|mcp|daemon)/i.test(line)) continue;
        const m = line.match(/^"(\d+)","(\d+)","?(.*?)"?$/);
        if (m) {
          candidates.push({
            pid: parseInt(m[1], 10),
            ppid: parseInt(m[2], 10),
            cmdline: m[3].replace(/""/g, '"').slice(0, ZOMBIE_CMDLINE_CAPTURE_LEN),
          });
        }
      }
    } else {
      // ps -ww disables width truncation so cmdline is captured intact.
      const result = execSync(
        'ps -ww -eo pid,ppid,command | grep -E "node.*(moflo|claude-flow)" | grep -v grep',
        { encoding: 'utf-8', timeout: ZOMBIE_SCAN_TIMEOUT_MS_POSIX },
      );
      const lines = result.trim().split(/\r?\n/);
      for (const line of lines) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (m) {
          candidates.push({
            pid: parseInt(m[1], 10),
            ppid: parseInt(m[2], 10),
            cmdline: m[3].slice(0, ZOMBIE_CMDLINE_CAPTURE_LEN),
          });
        }
      }
    }
  } catch {
    // No matches (grep exits non-zero) or scan command failed.
  }

  for (const cand of candidates) {
    const { pid, ppid } = cand;
    if (pid === currentPid || pid === parentPid || pid === legitimatePid) continue;
    if (trackedPids.has(pid)) continue;
    if (isProcessAlive(ppid)) continue;
    // Defense-in-depth: detached daemons have dead parents by design even
    // when the lock file is missing/corrupted.
    if (isDaemonProcess(pid)) continue;
    details.push(cand);
  }

  if (kill && details.length > 0) {
    for (const { pid } of details) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /F /PID ${pid}`, { timeout: ZOMBIE_KILL_TIMEOUT_MS, windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
        killed++;
      } catch {
        // Already exited.
      }
    }

    if (legitimatePid && details.some(d => d.pid === legitimatePid)) {
      releaseDaemonLock(process.cwd(), legitimatePid, true);
    }
  }

  return { killed, details };
}

// HealthCheck wrapper around findZombieProcesses for the orchestrated check list.
// Surfaces each orphan's cmdline so spawn-discipline regressions are diagnosable
// from a single doctor run.
export async function checkZombieProcesses(): Promise<HealthCheck> {
  try {
    const scan = await findZombieProcesses(false);
    if (scan.details.length === 0) {
      return { name: 'Zombie Processes', status: 'pass', message: 'No orphaned processes' };
    }
    const detail = scan.details.map(formatZombieDetail).join(' | ');
    return {
      name: 'Zombie Processes',
      status: 'warn',
      message: `${scan.details.length} orphaned process(es): ${detail}`,
      fix: 'moflo doctor --kill-zombies',
    };
  } catch {
    return { name: 'Zombie Processes', status: 'pass', message: 'Check skipped' };
  }
}
