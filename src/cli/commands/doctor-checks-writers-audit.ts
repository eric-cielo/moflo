/**
 * Writers Audit runtime doctor check (epic #1054.S5 / #1059).
 *
 * Runtime sibling of S1's static lint (`tests/system/moflo-db-writer-audit.test.ts`).
 * Enumerates running node processes whose command line invokes one of the
 * known cross-process writers (build-embeddings, migrations) and fails if any
 * are alive while the daemon owns the lock.
 *
 * Why not lsof / handle.exe?
 *   - `lsof` not installed on every Linux distro and not on Windows.
 *   - `handle.exe` (Sysinternals) requires manual install.
 *   - `openfiles.exe` is disabled by default on Windows and requires a reboot to
 *     enable.
 *
 * Command-line signature scan is cross-platform, dependency-free, and matches
 * the writers we actually care about — S3 ported them all to the daemon-offline
 * pattern, so any of them being alive concurrently with the daemon is a
 * regression of S3's wrapper logic.
 *
 * @module cli/commands/doctor-checks-writers-audit
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDaemonLockHolder } from '../services/daemon-lock.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

const SCAN_TIMEOUT_MS_WIN = 10_000;
const SCAN_TIMEOUT_MS_POSIX = 5_000;
const CMDLINE_CAPTURE_LEN = 300;

/**
 * Command-line fragments that identify a CROSS-PROCESS moflo.db writer.
 * These should never run while the daemon owns the lock (S3 wraps every
 * invocation in an explicit daemon-stop). Indexer scripts (index-guidance,
 * index-tests, etc.) are daemon-spawned children — they appear in
 * `background-pids.json` and are filtered out below.
 */
const FOREIGN_WRITER_PATTERNS: ReadonlyArray<RegExp> = [
  /build-embeddings\.mjs/i,
  /bin[\\\/]migrations[\\\/][^\s"']+\.mjs/i,
  /lib[\\\/]db-repair\.mjs/i,
];

interface ProcRecord {
  pid: number;
  cmdline: string;
}

function readTrackedBackgroundPids(cwd: string): Set<number> {
  const result = new Set<number>();
  const registryFile = join(cwd, '.moflo', 'background-pids.json');
  try {
    if (!existsSync(registryFile)) return result;
    const entries = JSON.parse(readFileSync(registryFile, 'utf-8'));
    if (!Array.isArray(entries)) return result;
    for (const entry of entries) {
      if (entry && typeof entry.pid === 'number' && entry.pid > 0) {
        result.add(entry.pid);
      }
    }
  } catch { /* unreadable — treat as empty */ }
  return result;
}

function enumerateNodeProcesses(): ProcRecord[] {
  try {
    if (process.platform === 'win32') {
      const csv = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"',
        { encoding: 'utf-8', timeout: SCAN_TIMEOUT_MS_WIN, windowsHide: true },
      );
      const out: ProcRecord[] = [];
      for (const line of csv.split(/\r?\n/)) {
        const m = line.match(/^"(\d+)","?(.*?)"?$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        out.push({ pid, cmdline: m[2].replace(/""/g, '"').slice(0, CMDLINE_CAPTURE_LEN) });
      }
      return out;
    }
    // POSIX
    const ps = execSync('ps -ww -eo pid,command', { encoding: 'utf-8', timeout: SCAN_TIMEOUT_MS_POSIX });
    const out: ProcRecord[] = [];
    for (const line of ps.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      if (!/\bnode\b/.test(cmd)) continue;
      const pid = parseInt(m[1], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      out.push({ pid, cmdline: cmd.slice(0, CMDLINE_CAPTURE_LEN) });
    }
    return out;
  } catch {
    return [];
  }
}

function formatCmdline(raw: string, max = 80): string {
  const cleaned = raw.replace(/^"?[^"\s]*node(?:\.exe)?"?\s+/i, '').trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

export interface ForeignWriterRecord extends ProcRecord {
  matchedPattern: string;
}

export function findForeignWriters(
  procs: ProcRecord[],
  daemonPid: number | null,
  trackedPids: Set<number>,
  selfPid: number,
): ForeignWriterRecord[] {
  const out: ForeignWriterRecord[] = [];
  for (const p of procs) {
    if (p.pid === selfPid) continue;
    if (p.pid === daemonPid) continue;
    if (trackedPids.has(p.pid)) continue;
    for (const re of FOREIGN_WRITER_PATTERNS) {
      const m = p.cmdline.match(re);
      if (m) {
        out.push({ ...p, matchedPattern: m[0] });
        break;
      }
    }
  }
  return out;
}

/**
 * Pass: daemon down (single-writer invariant has nothing to enforce) OR no
 * foreign writers detected.
 *
 * Fail: daemon owns the lock AND a non-daemon, non-tracked node process is
 * running a known cross-process writer. Lists every offender so the user can
 * SIGKILL them by PID.
 */
export async function checkWritersAudit(cwd: string = process.cwd()): Promise<HealthCheck> {
  const name = 'Writers Audit';
  try {
    const daemonPid = getDaemonLockHolder(cwd);
    if (daemonPid === null) {
      return {
        name,
        status: 'pass',
        message: 'Daemon not running — single-writer invariant trivially satisfied',
      };
    }

    const procs = enumerateNodeProcesses();
    const trackedPids = readTrackedBackgroundPids(cwd);
    const foreign = findForeignWriters(procs, daemonPid, trackedPids, process.pid);

    if (foreign.length === 0) {
      return {
        name,
        status: 'pass',
        message: `Daemon PID ${daemonPid} is sole writer; no foreign writers detected`,
      };
    }

    const detail = foreign
      .map((p) => `pid=${p.pid} (${p.matchedPattern}): ${formatCmdline(p.cmdline)}`)
      .join(' | ');
    return {
      name,
      status: 'fail',
      message:
        `${foreign.length} non-daemon writer(s) running concurrently with daemon (PID ${daemonPid}): ${detail}. ` +
        `Each bypasses the daemon's single-writer routing (#981): under node:sqlite+WAL they no longer clobber ` +
        `the DB file (the sql.js whole-snapshot flush #1054 guarded against is gone), but concurrent writes leave ` +
        `the daemon's in-memory HNSW index stale, so search returns outdated results until it reindexes.`,
      fix: process.platform === 'win32'
        ? `taskkill /F /PID ${foreign.map((p) => p.pid).join(' /PID ')}`
        : `kill ${foreign.map((p) => p.pid).join(' ')}`,
    };
  } catch (e) {
    return {
      name,
      status: 'warn',
      message: `Unable to audit writers: ${errorDetail(e, { firstLineOnly: true })}`,
    };
  }
}
