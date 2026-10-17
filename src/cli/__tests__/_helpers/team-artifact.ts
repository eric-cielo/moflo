/**
 * Test helpers for the team learnings artifact (#1234, #1506).
 *
 * The artifact is a directory of one JSON file per entry; a configured
 * `learnings.jsonl` path names the directory beside it and is migrated by the
 * next export. Tests may still SEED with a JSONL file — that is exactly the
 * migration input — but must READ results through the store, which resolves
 * either path shape to the same records.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  readArtifact,
  teamArtifactPaths,
  TOMBSTONE_NAMESPACE,
  type TeamArtifactLine,
  type TeamTombstone,
} from '../../services/team-artifact-store.js';

/** Seed an old-format JSONL artifact (one record per line); strings are written verbatim. */
export function writeJsonlArtifact(path: string, lines: Array<TeamArtifactLine | string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf-8');
}

/** Every record the artifact holds (directory + any unmigrated JSONL), sorted by key. */
export function readArtifactRecords(path: string): TeamArtifactLine[] {
  return [...readArtifact(path).lines.values()].sort((a, b) => {
    const ka = a.namespace === TOMBSTONE_NAMESPACE ? (a as TeamTombstone).deleted.key : a.key;
    const kb = b.namespace === TOMBSTONE_NAMESPACE ? (b as TeamTombstone).deleted.key : b.key;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Keys of the live entries, sorted. */
export function liveArtifactKeys(path: string): string[] {
  return readArtifactRecords(path)
    .filter((l) => l.namespace !== TOMBSTONE_NAMESPACE)
    .map((l) => l.key)
    .sort();
}

/** Keys the artifact's tombstones retire, sorted. */
export function tombstonedArtifactKeys(path: string): string[] {
  return readArtifactRecords(path)
    .filter((l): l is TeamTombstone => l.namespace === TOMBSTONE_NAMESPACE)
    .map((l) => l.deleted.key)
    .sort();
}

/** The directory a configured artifact path resolves to. */
export function artifactDir(path: string): string {
  return teamArtifactPaths(path).dir;
}
