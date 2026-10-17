/**
 * On-disk storage for the git-tracked team learnings artifact (#1234, #1506).
 *
 * `team-artifact-sync.ts` owns the merge rule; this module owns only how the
 * merged `Map<id, line>` is read from and written to disk.
 *
 * ## Layout: one file per entry (#1506)
 *
 * `<dir>/<namespace-dir>/<sha256(namespace \0 key)>.json`. Two branches that
 * each add an entry create two new files, so they cannot conflict — whatever
 * the merge settings, and on GitHub, which ignores merge drivers when it decides
 * whether a PR conflicts. The single sorted JSONL file this replaces put
 * concurrent adds on adjacent lines, which git reports as one conflicting hunk.
 *
 * A tombstone is written into the file of the entry it retires, so an edit on
 * one branch and a deletion on another touch the same file and conflict visibly
 * instead of one silently winning.
 *
 * File names are a hex hash of the exact namespace + key: fixed length, free of
 * key characters, and safe on case-insensitive filesystems (Rule #1). The
 * namespace directory is the namespace lower-cased and sanitised — purely for
 * human navigation; two namespaces differing only in case share a directory
 * but never a file.
 *
 * ## Moving off the JSONL file
 *
 * There is one layout. A configured path ending in `.jsonl` names the directory
 * beside it (`learnings.jsonl` → `learnings/`), so no consumer reconfigures
 * anything. The old file is only ever *read*: import treats it as one more
 * source, and the next export copies it into the directory and deletes it.
 *
 * @module cli/services/team-artifact-store
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import {
  reconcileId,
  splitReconcileId,
  recordStamp,
  type ReconcileRecord,
} from './durable-reconcile.js';
import { isMisfiledDurable } from './durable-key-rules.js';

/**
 * Namespace marker on a tombstone line. MUST stay outside `isDurableNamespace`
 * — that is the entire backward-compatibility mechanism (old clients skip it as
 * non-durable). Renaming it silently breaks deletion propagation for every
 * client that hasn't upgraded, which is why
 * `imports a tombstone-bearing artifact the way 4.12.11 does` pins it.
 */
export const TOMBSTONE_NAMESPACE = '__moflo_tombstone__';

/** Provenance stamped onto each shared entry so its origin survives review. */
export interface TeamProvenance {
  /** `git config user.name <user.email>`, or the OS user as a fallback. */
  author: string;
  /** Hostname of the machine that first shared the entry. */
  source: string;
  /** ISO timestamp the entry was last written to the artifact. */
  sharedAt: string;
}

/** One durable learning as stored in the artifact. Embeddings are intentionally omitted. */
export interface TeamArtifactEntry {
  namespace: string;
  key: string;
  content: string;
  type: string;
  tags?: string[];
  /** Epoch-ms creation time (the `created_at` column is INTEGER NOT NULL). */
  created_at?: number;
  /**
   * Epoch-ms of the last edit — the basis for last-writer-wins (#1463). Absent
   * on lines written before #1463; those are treated as timestamp 0 so they can
   * still seed a store that lacks the key but can never overwrite one that has
   * it. Export backfills the field on any such line this machine also holds
   * (timestamp only — provenance stays with the original author), so the
   * ambiguity retires after one export per line rather than persisting.
   */
  updated_at?: number;
  provenance: TeamProvenance;
}

/** A deletion, carried as a record so it can propagate. See the sync module header. */
export interface TeamTombstone {
  namespace: string;
  key: string;
  deleted: { namespace: string; key: string; at: number };
  provenance: TeamProvenance;
}

export type TeamArtifactLine = TeamArtifactEntry | TeamTombstone;

/** True when a parsed record is a tombstone rather than a live entry. */
export function isTombstoneLine(line: TeamArtifactLine): line is TeamTombstone {
  return line.namespace === TOMBSTONE_NAMESPACE;
}

/** The (namespace, key) a record is *about* — its inner target for a tombstone. */
export function lineId(line: TeamArtifactLine): string {
  return isTombstoneLine(line)
    ? reconcileId(line.deleted.namespace, line.deleted.key)
    : reconcileId(line.namespace, line.key);
}

/** A parsed record as the merge rule sees it. See {@link TeamArtifactEntry.updated_at}. */
export function lineToRecord(line: TeamArtifactLine): ReconcileRecord {
  if (isTombstoneLine(line)) {
    return {
      namespace: line.deleted.namespace,
      key: line.deleted.key,
      updatedAt: 0,
      deletedAt: line.deleted.at,
    };
  }
  return {
    namespace: line.namespace,
    key: line.key,
    updatedAt: typeof line.updated_at === 'number' ? line.updated_at : 0,
    content: line.content ?? '',
  };
}

/** Parse one JSONL line (or one entry file's text), or `null` when malformed. */
function parseLine(text: string): TeamArtifactLine | null {
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj.namespace !== 'string' || typeof obj.key !== 'string') return null;

  if (obj.namespace === TOMBSTONE_NAMESPACE) {
    const deleted = obj.deleted as { namespace?: unknown; key?: unknown; at?: unknown } | undefined;
    // A marker line whose payload is unusable is malformed, NOT a silent
    // no-op: swallowing it would drop a deletion with no diagnostic.
    if (
      !deleted ||
      typeof deleted.namespace !== 'string' ||
      typeof deleted.key !== 'string' ||
      typeof deleted.at !== 'number'
    ) {
      return null;
    }
    return obj as unknown as TeamTombstone;
  }
  return obj as unknown as TeamArtifactEntry;
}

export interface TeamArtifactPaths {
  /** The per-entry directory — the only thing ever written. */
  dir: string;
  /** The single JSONL file the directory replaced; read until export removes it. */
  legacy: string;
}

/**
 * Split a configured artifact path into the directory to use and the old JSONL
 * file to migrate from. `.moflo/shared/learnings.jsonl` (the old default, still
 * in many consumers' `moflo.yaml`) and `.moflo/shared/learnings/` both resolve
 * to the same pair. An existing file under some other name is an old artifact
 * too, and moves to the directory named by its stem.
 */
export function teamArtifactPaths(configured: string): TeamArtifactPaths {
  const p = configured.replace(/[\\/]+$/, '');
  if (path.extname(p).toLowerCase() === '.jsonl') {
    return { dir: p.slice(0, -'.jsonl'.length), legacy: p };
  }
  let isFile = false;
  try {
    isFile = fs.statSync(p).isFile();
  } catch {
    /* absent — the common case */
  }
  if (isFile) {
    const ext = path.extname(p);
    return { dir: ext ? p.slice(0, -ext.length) : `${p}.d`, legacy: p };
  }
  return { dir: p, legacy: `${p}.jsonl` };
}

/** True when there is anything to import — the directory or a not-yet-migrated file. */
export function teamArtifactExists(configured: string): boolean {
  const { dir, legacy } = teamArtifactPaths(configured);
  return fs.existsSync(dir) || fs.existsSync(legacy);
}

/** Directory name a namespace's entry files live under. See the module header. */
function namespaceDirName(namespace: string): string {
  const safe = namespace.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return safe === '' || /^\.+$/.test(safe) ? '_' : safe;
}

/** Absolute path of the file that holds the entry (or tombstone) for `id`. */
export function entryFilePath(dir: string, id: string): string {
  const { namespace } = splitReconcileId(id);
  const name = `${createHash('sha256').update(id).digest('hex')}.json`;
  return path.join(dir, namespaceDirName(namespace), name);
}

/** One entry file's bytes: stable key order, two-space indent, trailing newline. */
function serializeEntryFile(line: TeamArtifactLine): string {
  return `${JSON.stringify(line, null, 2)}\n`;
}

/**
 * Path identity for "is this the same file". macOS and Windows filesystems fold
 * case, so `Patterns/x.json` and `patterns/x.json` are one file there — deleting
 * the "other" one would delete the entry just written (Rule #1).
 */
const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';
const pathKey = (p: string): string => (caseInsensitiveFs ? p.toLowerCase() : p);

export interface ArtifactSnapshot {
  dir: string;
  lines: Map<string, TeamArtifactLine>;
  records: Map<string, ReconcileRecord>;
  /** Malformed entry files and JSONL lines skipped. */
  malformed: number;
  /** Records about a misfiled row (#1495), dropped here so no caller ever sees one. */
  misfiled: number;
  /** True when the directory or the old JSONL file exists. */
  existed: boolean;
  /**
   * Every well-formed entry file read, with its raw text, so the writer can
   * skip unchanged files and remove ones no longer wanted.
   */
  files: Map<string, string>;
  /** Entry files that would not parse. The writer never overwrites or removes one. */
  malformedFiles: Set<string>;
  /** Well-formed files not at their canonical name (hand-copied); a write tidies them. */
  misplaced: number;
  /** The old JSONL file, when one is still present — export migrates and deletes it. */
  legacyPath: string | null;
  /** Records the old JSONL file contributed that the directory did not already hold. */
  fromLegacy: number;
}

/**
 * Fold one parsed record into a snapshot: misfiled drop + newest-wins dedupe.
 * Returns true when the record was kept.
 */
function addLine(snapshot: ArtifactSnapshot, parsed: TeamArtifactLine): boolean {
  const id = lineId(parsed);
  const record = lineToRecord(parsed);
  // Dropped at the read both directions share, so import never applies one
  // and export rewrites the artifact without it — the artifact shrinks instead
  // of re-seeding every teammate's `learnings` on their next session (#1495).
  if (isMisfiledDurable(record.namespace, record.key)) {
    snapshot.misfiled++;
    return false;
  }
  const existing = snapshot.records.get(id);
  // Newest wins, ties keep the first. Built on the merge rule's own comparison
  // basis so the two cannot disagree about which of a live record and a
  // tombstone is later.
  if (existing && recordStamp(existing) >= recordStamp(record)) return false;
  snapshot.lines.set(id, parsed);
  snapshot.records.set(id, record);
  return true;
}

/** Sorted directory listing; empty when the path is missing or not a directory. */
function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * Read + parse the artifact, keyed by the (namespace, key) each record is
 * *about* — so a tombstone and the entry it retires occupy one slot and cannot
 * both survive. Missing → empty.
 *
 * The directory is read first, then any old JSONL file beside it. Duplicates
 * are settled by timestamp, newest wins, ties keep the first (so the
 * directory's copy). In the old file that is not hypothetical: an old client
 * re-appends a live line for a key we tombstoned, with no `updated_at`, so it
 * stamps 0 and the tombstone stands — while a genuine re-creation carries a
 * real timestamp and wins. A file left with git conflict markers resolves the
 * same way: each side's lines parse, and the newer edit wins.
 */
export function readArtifact(configured: string): ArtifactSnapshot {
  const { dir, legacy } = teamArtifactPaths(configured);
  const snapshot: ArtifactSnapshot = {
    dir,
    lines: new Map(),
    records: new Map(),
    malformed: 0,
    misfiled: 0,
    existed: false,
    files: new Map(),
    malformedFiles: new Set(),
    misplaced: 0,
    legacyPath: null,
    fromLegacy: 0,
  };

  for (const nsDir of listDir(dir)) {
    snapshot.existed = true;
    if (!nsDir.isDirectory()) continue;
    const nsPath = path.join(dir, nsDir.name);
    for (const file of listDir(nsPath)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const filePath = path.join(nsPath, file.name);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch {
        snapshot.malformed++;
        continue;
      }
      const parsed = parseLine(raw);
      if (!parsed) {
        // Most likely unresolved git conflict markers — a human's call, never ours.
        snapshot.malformed++;
        snapshot.malformedFiles.add(pathKey(filePath));
        continue;
      }
      snapshot.files.set(filePath, raw);
      if (pathKey(filePath) !== pathKey(entryFilePath(dir, lineId(parsed)))) snapshot.misplaced++;
      addLine(snapshot, parsed);
    }
  }
  if (fs.existsSync(dir)) snapshot.existed = true;

  let raw: string | null = null;
  try {
    raw = fs.statSync(legacy).isFile() ? fs.readFileSync(legacy, 'utf-8') : null;
  } catch {
    /* no old file — the steady state */
  }
  if (raw !== null) {
    snapshot.existed = true;
    snapshot.legacyPath = legacy;
    // Ids, not lines: a file left mid-conflict carries both sides of one key.
    const won = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseLine(trimmed);
      if (!parsed) snapshot.malformed++;
      else if (addLine(snapshot, parsed)) won.add(lineId(parsed));
    }
    snapshot.fromLegacy = won.size;
  }
  return snapshot;
}

export interface WriteResult {
  /** Entry files written or removed. */
  touched: number;
  /** Entries left unwritten because their file is malformed (e.g. conflict markers). */
  blocked: number;
  /** The old JSONL file removed by this write, if there was one. */
  removedLegacy: string | null;
}

/**
 * Write `lines` as the whole artifact, touching only what changed: a file is
 * written when its bytes differ, a previously-read file whose id is gone (a
 * pruned tombstone, a dropped misfiled record, a hand-copied duplicate) is
 * removed, and the old JSONL file — fully folded into `lines` by
 * {@link readArtifact} — is deleted.
 *
 * A malformed file is never overwritten or removed: it usually holds unresolved
 * conflict markers, and writing over them would silently pick a side.
 */
export function writeArtifact(lines: Map<string, TeamArtifactLine>, prior: ArtifactSnapshot): WriteResult {
  const result: WriteResult = { touched: 0, blocked: 0, removedLegacy: null };
  fs.mkdirSync(prior.dir, { recursive: true });
  const madeDirs = new Set<string>();
  const wanted = new Set<string>();
  for (const [id, line] of lines) {
    const filePath = entryFilePath(prior.dir, id);
    wanted.add(pathKey(filePath));
    if (prior.malformedFiles.has(pathKey(filePath))) {
      result.blocked++;
      continue;
    }
    const content = serializeEntryFile(line);
    // A Windows checkout without the LF pin hands back CRLF; that is the same
    // entry, and rewriting it would churn every file on every export (Rule #1).
    if (prior.files.get(filePath)?.replace(/\r\n/g, '\n') === content) continue;
    const parent = path.dirname(filePath);
    if (!madeDirs.has(parent)) {
      fs.mkdirSync(parent, { recursive: true });
      madeDirs.add(parent);
    }
    atomicWriteFileSync(filePath, content);
    result.touched++;
  }
  for (const filePath of prior.files.keys()) {
    if (wanted.has(pathKey(filePath))) continue;
    try {
      fs.unlinkSync(filePath);
      result.touched++;
    } catch {
      /* already gone — nothing to remove */
    }
  }
  // A blocked entry may exist nowhere else but the old file — keep it until the
  // conflict is resolved and a later export can fold it in.
  if (prior.legacyPath && result.blocked === 0) {
    try {
      fs.unlinkSync(prior.legacyPath);
      result.removedLegacy = prior.legacyPath;
    } catch {
      /* already gone, or locked — the next export retries */
    }
  }
  return result;
}
