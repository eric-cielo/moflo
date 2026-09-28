/**
 * The verdict record `flo memory audit-learnings --apply` keeps between runs
 * (#1466), at `.moflo/learnings-audit.json`.
 *
 * Carved out of the command so the session-start purge can read it without
 * importing CLI command machinery: the purge's run-summary count (#1495) skips
 * keys a human already judged, so the notice clears once the store is curated.
 *
 * Local-only — never part of the shared artifact.
 *
 * @module memory/learnings-audit-state
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import type { DecidedEntry } from './learnings-audit.js';

/** Where recorded verdicts live, under `.moflo/`. */
export const AUDIT_STATE_FILE = 'learnings-audit.json';
/** Bump when the record shape changes; an older file is discarded, not migrated. */
const AUDIT_STATE_VERSION = 1;

interface AuditState {
  version: number;
  decided: Record<string, DecidedEntry>;
}

function stateFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.moflo', AUDIT_STATE_FILE);
}

/** Read recorded verdicts. Any unreadable or stale-version file reads as empty. */
export function readAuditState(projectRoot: string): Map<string, DecidedEntry> {
  try {
    const raw = fs.readFileSync(stateFilePath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as AuditState;
    if (parsed?.version !== AUDIT_STATE_VERSION || !parsed.decided) return new Map();
    return new Map(Object.entries(parsed.decided));
  } catch {
    // Absent, truncated, or hand-edited into invalid JSON. Losing the record
    // costs one re-judgement; refusing to run over it costs the command.
    return new Map();
  }
}

/**
 * Write the verdict record back.
 *
 * Read-modify-write with no lock: two `--apply` runs racing on the same project
 * would lose one run's verdicts. Not worth a lock — this is a hand-invoked
 * curation command, the loss costs one re-judgement, and `atomicWriteFileSync`
 * already rules out a torn file (its temp name is pid- and random-suffixed, so
 * concurrent writers cannot clobber each other's staging file either).
 */
export function writeAuditState(projectRoot: string, decided: ReadonlyMap<string, DecidedEntry>): void {
  const file = stateFilePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: AuditState = { version: AUDIT_STATE_VERSION, decided: Object.fromEntries(decided) };
  atomicWriteFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}
