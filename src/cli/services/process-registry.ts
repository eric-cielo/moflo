/**
 * Shared write side of the moflo background-process registry.
 *
 * Mirrors `bin/lib/process-manager.mjs`'s atomic write logic so TS spawn
 * sites (auto-start daemon in src/cli/index.ts and daemon-readiness.ts) can
 * register their PIDs alongside the ones written by bin/hooks.mjs's
 * spawnWindowless helper. Without registry parity, doctor's zombie scan
 * (src/cli/commands/doctor.ts) flags every TS-spawned background process as
 * an orphan, because they are detached:true so their immediate parent dies.
 *
 * The .mjs module remains the canonical reader/writer with full read+killAll
 * semantics; this TS helper only covers the registration we need from compiled
 * paths. Both write to the same JSON file (`<projectRoot>/.moflo/background-pids.json`),
 * so a process registered here is reapable via pm.killAll() at session-end.
 */

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';

export interface BackgroundPidEntry {
  pid: number;
  label: string;
  cmd: string;
  startedAt: string;
}

const REGISTRY_FILENAME = 'background-pids.json';

function registryPath(projectRoot: string): string {
  return join(projectRoot, '.moflo', REGISTRY_FILENAME);
}

function readRegistry(projectRoot: string): BackgroundPidEntry[] {
  const path = registryPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(projectRoot: string, entries: BackgroundPidEntry[]): void {
  const path = registryPath(projectRoot);
  mkdirSync(join(projectRoot, '.moflo'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, path);
}

/**
 * Register a spawned background PID under the given label. Replaces any
 * pre-existing entry with the same label so a stale dead-PID row doesn't
 * accumulate when a daemon crashes and is restarted.
 */
export function registerBackgroundPid(
  projectRoot: string,
  pid: number,
  label: string,
  cmd: string,
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const fresh = readRegistry(projectRoot).filter(e => e && e.label !== label);
  fresh.push({
    pid,
    label,
    cmd: cmd.slice(0, 200),
    startedAt: new Date().toISOString(),
  });
  writeRegistry(projectRoot, fresh);
}
