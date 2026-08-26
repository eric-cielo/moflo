/**
 * Git-tracked team learnings artifact (#1234, epic #1231; reconciling since #1463).
 *
 * Story 1 (#1232) shared a durable SQLite store between worktrees; Story 2
 * (#1233) carried a durable SQLite artifact between one user's machines. This
 * story shares durable learnings across a *team*: a **git-tracked JSONL file**
 * (default `.moflo/shared/learnings.jsonl`, explicitly NOT gitignored) that the
 * team commits. Each teammate's session-start import-merges it into their local
 * DB, so the whole team accumulates each other's learnings about the same repo.
 *
 * Why JSONL (not the SQLite artifact from #1233): a committed team file must be
 * **diff-reviewable** and **merge-friendly**. One JSON object per line, sorted
 * by `(namespace, key)`, makes git diffs line-local and human-readable, and a
 * git merge of two divergent artifacts is conflict-free for distinct keys.
 * Embeddings are deliberately omitted from the file — 384 floats per row would
 * make every diff unreadable — so imported rows are re-embedded by the daemon's
 * normal index pass (or `flo memory rebuild-index`), exactly as any other
 * unembedded row.
 *
 * ## Conflict policy: last-writer-wins on `updated_at` (#1463)
 *
 * This **replaces** the original first-write-wins policy, which was the #1463
 * bug rather than a design: export skipped any key already in the artifact and
 * import ran `INSERT OR IGNORE`, so a correction and a deletion were silently
 * dropped in both directions. The artifact is the effective source of truth
 * across machines, which made the two operations that most need to propagate
 * the two the pair could not do.
 *
 * Both directions now run the same {@link planReconcile} rule with source and
 * target swapped. Ties change nothing, and a key present only in the target is
 * never touched — that is what protects work authored locally and not yet
 * shared. See `durable-reconcile.ts` for the full matrix.
 *
 * ## Tombstones
 *
 * A deletion travels as its own line, marked with a namespace that is not
 * durable:
 *
 * ```json
 * {"namespace":"__moflo_tombstone__","key":"purged-key",
 *  "deleted":{"namespace":"learnings","key":"purged-key","at":1787751507635},
 *  "provenance":{...}}
 * ```
 *
 * That marker buys backward compatibility for free. `importTeamArtifact` has
 * always routed non-durable namespaces to `skippedNonDurable`, so 4.12.11 and
 * every earlier version silently ignore tombstones — they do not act on
 * deletions, which is exactly their behaviour today. An old client's *export*
 * also preserves the lines verbatim, since it re-serialises whatever it read.
 * No version gate and no artifact-schema field are required.
 *
 * Provenance now records who wrote a line **last** rather than first, because a
 * line can now be rewritten. That is the more useful fact when reviewing a diff
 * that changes an entry.
 *
 * Opt-in: inert unless `memory.team_artifact` (or `MOFLO_TEAM_ARTIFACT`) points
 * at a path. Solo users see byte-identical behaviour to today.
 *
 * @module cli/services/team-artifact-sync
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { findProjectRoot } from './project-root.js';
import { memoryDbPath } from './moflo-paths.js';
import { openDaemonDatabase } from '../memory/daemon-backend.js';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { loadMofloConfig, type MofloConfig } from '../config/moflo-config.js';
import { isDurableNamespace } from './cherry-pick-learnings.js';
import {
  planReconcile,
  reconcileId,
  splitReconcileId,
  isPrunableTombstone,
  recordStamp,
  TOMBSTONE_TTL_MS,
  type ReconcileRecord,
} from './durable-reconcile.js';
import {
  readDurableSnapshot,
  applyDurableActions,
  type DurablePayload,
} from './durable-store-io.js';

/** Allowed `type` values — the schema CHECK set. An out-of-set value would make
 *  INSERT OR IGNORE silently drop a hand-edited artifact row, so we coerce. */
const VALID_TYPES: ReadonlySet<string> = new Set([
  'semantic',
  'episodic',
  'procedural',
  'working',
  'pattern',
]);
const coerceType = (t: string | undefined): string => (t && VALID_TYPES.has(t) ? t : 'semantic');

/** Default artifact path, relative to the project root. POSIX-joined parts. */
export const DEFAULT_TEAM_ARTIFACT_REL = path.join('.moflo', 'shared', 'learnings.jsonl');

/**
 * Namespace marker on a tombstone line. MUST stay outside
 * {@link isDurableNamespace} — that is the entire backward-compatibility
 * mechanism (old clients skip it as non-durable). Renaming it silently breaks
 * deletion propagation for every client that hasn't upgraded, which is why
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

/** One durable learning as a single JSONL line. Embeddings are intentionally omitted. */
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

/** A deletion, carried as a line so it can propagate. See the module header. */
export interface TeamTombstone {
  namespace: string;
  key: string;
  deleted: { namespace: string; key: string; at: number };
  provenance: TeamProvenance;
}

export type TeamArtifactLine = TeamArtifactEntry | TeamTombstone;

/** True when a parsed line is a tombstone rather than a live entry. */
export function isTombstoneLine(line: TeamArtifactLine): line is TeamTombstone {
  return line.namespace === TOMBSTONE_NAMESPACE;
}

export interface ExportReport {
  artifactPath: string;
  /** Entries newly added to the artifact this run. */
  added: number;
  /** Entries whose artifact text was corrected from the local DB. */
  updated: number;
  /** Entries tombstoned this run because they were archived locally. */
  deleted: number;
  /** Entries re-created locally after a purge, restored over their tombstone. */
  resurrected: number;
  /** Entries already in agreement. */
  unchanged: number;
  /** Local changes NOT propagated because the artifact's version is newer. */
  keptRemote: number;
  /** Expired tombstones dropped from the artifact this run. */
  prunedTombstones: number;
  /** Pre-#1463 lines given an `updated_at` this run, so they stop stamping 0. */
  backfilled: number;
  /** Malformed JSONL lines skipped while reading the artifact. */
  skippedMalformed: number;
  /** Live entries in the artifact after the merge. */
  total: number;
  /** Tombstone lines retained in the artifact after the merge. */
  tombstones: number;
  /** False when nothing changed and the file was left untouched. */
  wrote: boolean;
}

export interface ImportReport {
  artifactPath: string;
  /** Rows newly inserted into the local DB. */
  imported: number;
  /** Local rows corrected from the artifact. */
  updated: number;
  /** Local rows archived because the artifact carries a newer tombstone. */
  deleted: number;
  /** Local rows restored from an archive because the artifact has a newer entry. */
  resurrected: number;
  /** Artifact changes NOT applied because the local row is newer. */
  keptLocal: number;
  /** Durable records read from the artifact (live entries + tombstones). */
  considered: number;
  /** Malformed JSONL lines skipped (bad JSON or missing namespace/key). */
  skippedMalformed: number;
  /** Well-formed lines skipped for being outside the durable namespaces. */
  skippedNonDurable: number;
}

/**
 * Resolve the configured team-artifact path to an absolute path, or `null` when
 * the feature is off (no env, no `memory.team_artifact`). Precedence:
 * `MOFLO_TEAM_ARTIFACT` env > `memory.team_artifact` (moflo.yaml). Relative
 * values resolve against the project root (Rule #1 — always `path.resolve`).
 */
export function resolveTeamArtifactPath(
  projectRoot: string = findProjectRoot(),
  config?: MofloConfig,
): string | null {
  const envRaw = process.env.MOFLO_TEAM_ARTIFACT?.trim();
  const cfgRaw = (config ?? loadMofloConfig(projectRoot)).memory.team_artifact?.trim();
  const raw = envRaw && envRaw.length > 0 ? envRaw : cfgRaw;
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
}

/** Best-effort author string: `git user.name <user.email>`, else OS user. */
function resolveAuthor(projectRoot: string): string {
  const git = (args: string[]): string => {
    try {
      // spawnSync without a shell — never interpolate into a shell string (Rule #1).
      const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf-8', timeout: 2000 });
      return r.status === 0 ? (r.stdout || '').trim() : '';
    } catch {
      return '';
    }
  };
  const name = git(['config', 'user.name']);
  const email = git(['config', 'user.email']);
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Stable host identifier for provenance; never throws. */
function resolveSource(): string {
  try {
    return os.hostname() || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

/** The (namespace, key) a line is *about* — its inner target for a tombstone. */
function lineId(line: TeamArtifactLine): string {
  return isTombstoneLine(line)
    ? reconcileId(line.deleted.namespace, line.deleted.key)
    : reconcileId(line.namespace, line.key);
}

/** A parsed line as the merge rule sees it. See {@link TeamArtifactEntry.updated_at}. */
function lineToRecord(line: TeamArtifactLine): ReconcileRecord {
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

/** Parse one JSONL line, or `null` when it is malformed. */
function parseLine(trimmed: string): TeamArtifactLine | null {
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
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

/**
 * Read + parse an existing artifact, keyed by the (namespace, key) each line is
 * *about* — so a tombstone and the entry it retires occupy one slot and cannot
 * both survive. Missing file → empty.
 *
 * Duplicates within one file are settled by timestamp, newest wins, ties keep
 * the first. That is not hypothetical: an old client re-appends a live line for
 * a key we tombstoned (it keys tombstones under the marker namespace, so the
 * live key looks absent to it). Those re-appended lines carry no `updated_at`,
 * so they stamp 0 and the tombstone stands — while a genuine re-creation from
 * an upgraded client carries a real timestamp and wins.
 */
function readArtifact(artifactPath: string): {
  lines: Map<string, TeamArtifactLine>;
  records: Map<string, ReconcileRecord>;
  malformed: number;
  existed: boolean;
} {
  const lines = new Map<string, TeamArtifactLine>();
  const records = new Map<string, ReconcileRecord>();
  let malformed = 0;
  if (!fs.existsSync(artifactPath)) return { lines, records, malformed, existed: false };
  const raw = fs.readFileSync(artifactPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseLine(trimmed);
    if (!parsed) {
      malformed++;
      continue;
    }
    const id = lineId(parsed);
    const record = lineToRecord(parsed);
    const existing = records.get(id);
    // Newest wins, ties keep the first. Built on the merge rule's own
    // comparison basis so the two cannot disagree about which of a live line
    // and a tombstone is later.
    if (existing && recordStamp(existing) >= recordStamp(record)) continue;
    lines.set(id, parsed);
    records.set(id, record);
  }
  return { lines, records, malformed, existed: true };
}

/**
 * Serialise lines to JSONL, sorted by the (namespace, key) each line is about —
 * so a tombstone sorts exactly where the entry it retires used to sit, keeping
 * the git diff line-local and reviewable.
 */
function serializeArtifact(lines: Iterable<[string, TeamArtifactLine]>): string {
  const sorted = [...lines].sort((a, b) => {
    const left = splitReconcileId(a[0]);
    const right = splitReconcileId(b[0]);
    return left.namespace === right.namespace
      ? left.key.localeCompare(right.key)
      : left.namespace.localeCompare(right.namespace);
  });
  return sorted.map(([, line]) => JSON.stringify(line)).join('\n') + (sorted.length ? '\n' : '');
}

/** Parse the DB's JSON-encoded tags column back to the artifact's array form. */
function parseTags(raw: string | null): string[] | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/** Build the artifact line for a local row that is winning the merge. */
function entryFromPayload(payload: DurablePayload, provenance: TeamProvenance): TeamArtifactEntry {
  return {
    namespace: payload.namespace,
    key: payload.key,
    content: payload.content,
    type: payload.type,
    tags: parseTags(payload.tags),
    created_at: payload.createdAt,
    updated_at: payload.updatedAt,
    provenance,
  };
}

/** Build the tombstone line for a locally archived row. */
function tombstoneFromRecord(record: ReconcileRecord, provenance: TeamProvenance): TeamTombstone {
  return {
    namespace: TOMBSTONE_NAMESPACE,
    // Informational for old clients, which key this line under the marker
    // namespace and skip it; the authoritative target is `deleted`.
    key: record.key,
    deleted: { namespace: record.namespace, key: record.key, at: record.deletedAt as number },
    provenance,
  };
}

/** Build the DB row an artifact line becomes. Embeddings are never carried. */
function payloadFromLine(id: string, line: TeamArtifactEntry): DurablePayload {
  return {
    id: createHash('sha1').update(id).digest('hex'),
    namespace: line.namespace,
    key: line.key,
    content: line.content ?? '',
    // An out-of-CHECK-set type would be silently dropped by INSERT OR IGNORE.
    type: coerceType(line.type),
    tags: line.tags ? JSON.stringify(line.tags) : null,
    metadata: JSON.stringify({ provenance: line.provenance, sharedFrom: 'team-artifact' }),
    ownerId: line.provenance?.author || null,
    // created_at/updated_at are INTEGER NOT NULL — never bind null.
    createdAt: typeof line.created_at === 'number' ? line.created_at : Date.now(),
    // The row gets the best timestamp available even when the RECORD compared
    // as 0 (a pre-#1463 line): 0 governs only who wins the merge, while the row
    // itself should carry the most accurate time we have.
    updatedAt:
      typeof line.updated_at === 'number'
        ? line.updated_at
        : typeof line.created_at === 'number'
          ? line.created_at
          : Date.now(),
    embedding: null,
    embeddingModel: null,
    embeddingDimensions: null,
  };
}

/**
 * Export the local durable slice into the team artifact by **reconciling**, not
 * appending: corrections overwrite the artifact line, local archives become
 * tombstones, and entries the artifact has but this machine does not are left
 * strictly alone (they may be a teammate's, or ours-not-yet-imported).
 *
 * The file is rewritten sorted + atomically, and only when something changed —
 * a git-tracked file should not churn its mtime for a no-op run.
 */
export function exportTeamArtifact(opts: {
  projectRoot?: string;
  artifactPath: string;
  sharedAt: string;
  config?: MofloConfig;
  /** Epoch-ms used for tombstone pruning. Defaults to `sharedAt`, then now. */
  now?: number;
  /** Tombstone retention window. Exposed for tests; see {@link TOMBSTONE_TTL_MS}. */
  tombstoneTtlMs?: number;
}): ExportReport {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const localDbPath = memoryDbPath(projectRoot);
  const parsedSharedAt = Date.parse(opts.sharedAt);
  const now = opts.now ?? (Number.isNaN(parsedSharedAt) ? Date.now() : parsedSharedAt);
  const ttlMs = opts.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;

  const { lines, records: target, malformed, existed } = readArtifact(opts.artifactPath);
  const provenance: TeamProvenance = {
    author: resolveAuthor(projectRoot),
    source: resolveSource(),
    sharedAt: opts.sharedAt,
  };

  // Local DB is the source, the artifact the target.
  let records = new Map<string, ReconcileRecord>();
  let payloads = new Map<string, DurablePayload>();
  if (fs.existsSync(localDbPath)) {
    let db;
    try {
      db = openDaemonDatabase(localDbPath);
    } catch {
      db = null;
    }
    if (db) {
      try {
        // The local DB is the SOURCE here, so it is the side that needs full
        // payloads. Archive retention is applied by the session-start sync, not
        // here: pruning before the artifact write could destroy the evidence
        // for a deletion the write then failed to publish.
        ({ records, payloads } = readDurableSnapshot(db, undefined, { withPayloads: true }));
      } finally {
        db.close();
      }
    }
  }

  const { actions, summary } = planReconcile(records, target);
  for (const action of actions) {
    if (action.op === 'delete') {
      lines.set(action.id, tombstoneFromRecord(action.record, provenance));
      continue;
    }
    const payload = payloads.get(action.id);
    if (payload) lines.set(action.id, entryFromPayload(payload, provenance));
  }

  // Backfill the timestamp on lines this machine holds but that predate #1463.
  // Content-equal lines are never rewritten, so without this they would keep a
  // stamp of 0 forever and lose every future comparison to any real timestamp.
  // Only the timestamp moves — provenance stays with whoever authored the line.
  let backfilled = 0;
  for (const [id, line] of lines) {
    if (isTombstoneLine(line) || typeof line.updated_at === 'number') continue;
    const payload = payloads.get(id);
    if (!payload) continue;
    lines.set(id, { ...line, updated_at: payload.updatedAt });
    backfilled++;
  }

  const expired: string[] = [];
  for (const [id, line] of lines) {
    if (isTombstoneLine(line) && isPrunableTombstone(lineToRecord(line), now, ttlMs)) expired.push(id);
  }
  for (const id of expired) lines.delete(id);
  const prunedTombstones = expired.length;

  let live = 0;
  let tombstones = 0;
  for (const line of lines.values()) {
    if (isTombstoneLine(line)) tombstones++;
    else live++;
  }

  // Skip the write when the merge changed nothing AND the file already exists:
  // a git-tracked artifact should not show up as modified after a no-op run.
  const changed = actions.length > 0 || prunedTombstones > 0 || backfilled > 0;
  const wrote = changed || !existed;
  if (wrote) {
    fs.mkdirSync(path.dirname(opts.artifactPath), { recursive: true });
    atomicWriteFileSync(opts.artifactPath, serializeArtifact(lines));
  }

  return {
    artifactPath: opts.artifactPath,
    added: summary.inserted,
    updated: summary.updated,
    deleted: summary.deleted,
    resurrected: summary.resurrected,
    unchanged: summary.unchanged,
    keptRemote: summary.keptTargetNewer,
    prunedTombstones,
    backfilled,
    skippedMalformed: malformed,
    total: live,
    tombstones,
    wrote,
  };
}

/**
 * Import-merge the team artifact into the local durable namespaces, applying
 * the same reconciliation rule with the artifact as source. Corrections update
 * the local row, tombstones archive it, and local-only rows are never touched.
 *
 * Embeddings are left null on insert and cleared on update — the artifact
 * carries no vectors, so keeping the old one would leave a corrected row
 * findable under its previous meaning. The daemon's index pass refills them.
 *
 * No-op (zero rows) when the artifact is absent. Never throws on a malformed
 * line; those are counted and skipped.
 */
export function importTeamArtifact(opts: { projectRoot?: string; artifactPath: string }): ImportReport {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const localDbPath = memoryDbPath(projectRoot);
  const report: ImportReport = {
    artifactPath: opts.artifactPath,
    imported: 0,
    updated: 0,
    deleted: 0,
    resurrected: 0,
    keptLocal: 0,
    considered: 0,
    skippedMalformed: 0,
    skippedNonDurable: 0,
  };

  const { lines, records: parsed, malformed } = readArtifact(opts.artifactPath);
  report.skippedMalformed = malformed;
  if (lines.size === 0) return report;

  const source = new Map<string, ReconcileRecord>();
  for (const [id, line] of lines) {
    const record = parsed.get(id) as ReconcileRecord;
    // The artifact is hand-editable by design — only durable namespaces belong
    // in the local durable slice. A tombstone resolves to its inner namespace,
    // so it passes this check while its marker namespace keeps old clients from
    // acting on it.
    if (!isDurableNamespace(record.namespace)) {
      report.skippedNonDurable++;
      continue;
    }
    report.considered++;
    source.set(id, record);
  }
  if (source.size === 0) return report;

  fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
  const db = openDaemonDatabase(localDbPath);
  try {
    const { records: target } = readDurableSnapshot(db);
    const { actions, summary } = planReconcile(source, target);
    // Payloads are built only for the actions that need one. In the steady
    // state the plan is empty, and hashing + re-encoding every line of a
    // 1,300-entry artifact on every session start would be pure waste.
    const payloads = new Map<string, DurablePayload>();
    for (const action of actions) {
      if (action.op === 'delete') continue;
      const line = lines.get(action.id);
      if (!line || isTombstoneLine(line)) continue;
      payloads.set(action.id, payloadFromLine(action.id, line));
    }
    const applied = applyDurableActions(db, actions, payloads);
    report.imported = applied.inserted;
    report.updated = applied.updated;
    report.deleted = applied.archived;
    report.resurrected = applied.resurrected;
    report.keptLocal = summary.keptTargetNewer;
  } finally {
    db.close();
  }
  return report;
}

/**
 * Ensure a git-tracked shared artifact is actually trackable. Once `.moflo/` is
 * gitignored, git won't descend into it to re-include a child — the canonical
 * fix is to ignore the *contents* (`.moflo/*`) and negate the shared subtree.
 * This rewrites a bare `.moflo/` rule to that pattern and adds the negation,
 * idempotently. Gitignore globs always use `/` regardless of OS (Rule #1), so
 * the artifact path is POSIX-normalised here.
 *
 * Returns the action taken so callers can report it.
 */
export function ensureSharedArtifactTracked(
  projectRoot: string,
  artifactAbsPath: string,
): 'created' | 'updated' | 'unchanged' {
  const rel = path.relative(projectRoot, artifactAbsPath).split(path.sep).join('/');
  // Only the `.moflo/` tree is gitignored-by-default and needs the re-include
  // dance. A custom artifact elsewhere is assumed already trackable — touching
  // an unrelated part of .gitignore would be surprising (and could inject a
  // spurious `.moflo/*` rule). Leave it alone.
  if (!rel.startsWith('.moflo/')) return 'unchanged';

  const gitignorePath = path.join(projectRoot, '.gitignore');
  // Negate the artifact's directory subtree (parent of the file), e.g. `.moflo/shared/`.
  const relDir = rel.slice(0, rel.lastIndexOf('/') + 1);
  const negation = `!/${relDir}`;

  const existed = fs.existsSync(gitignorePath);
  const lines = existed ? fs.readFileSync(gitignorePath, 'utf-8').split(/\r?\n/) : [];

  const isBareMoflo = (t: string): boolean =>
    t === '.moflo/' || t === '/.moflo/' || t === '.moflo' || t === '/.moflo';
  const isContentsRule = (t: string): boolean => t === '.moflo/*' || t === '/.moflo/*';

  let changed = false;
  let hasContentsRule = lines.some((l) => isContentsRule(l.trim()));

  // 1. Remove EVERY bare `.moflo/` rule (even when a contents rule also exists —
  //    git won't descend into an excluded dir, so the bare rule must go).
  //    Replace the first one with `.moflo/*` if no contents rule exists yet.
  const next: string[] = [];
  for (const line of lines) {
    if (isBareMoflo(line.trim())) {
      changed = true;
      if (!hasContentsRule) {
        next.push('.moflo/*');
        hasContentsRule = true;
      }
      continue; // drop the bare rule
    }
    next.push(line);
  }

  // 2. Ensure a `.moflo/*` contents rule exists at all (fresh file / no .moflo rule).
  if (!hasContentsRule) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('');
    next.push('# moflo team-shared learnings (tracked)');
    next.push('.moflo/*');
    hasContentsRule = true;
    changed = true;
  }

  // 3. Ensure the negation is present (after the contents rule).
  const hasNegation = next.some((l) => {
    const t = l.trim();
    return t === negation || t === `!${relDir}`;
  });
  if (!hasNegation) {
    next.push(negation);
    changed = true;
  }

  if (!changed) return 'unchanged';
  const content = next.join('\n').replace(/\n+$/, '') + '\n';
  atomicWriteFileSync(gitignorePath, content);
  return existed ? 'updated' : 'created';
}

/**
 * Pin the shared artifact to LF in the consumer's `.gitattributes`.
 *
 * The artifact is a git-tracked file in someone else's repo, and moflo always
 * writes it with `\n`. On a Windows checkout with `core.autocrlf=true` git
 * hands back CRLF, so every export rewrites the whole file and — far worse — a
 * git merge of two divergent artifacts conflicts on EVERY line. That destroys
 * the merge-friendliness that made JSONL the format in the first place, and it
 * only bites the platform least likely to be running CI.
 *
 * One narrowly-scoped line for one file; never touches unrelated patterns.
 * Idempotent — an existing rule for this path is left exactly as written, so a
 * consumer who tuned it keeps their version.
 *
 * Gitattributes patterns always use `/` regardless of OS (Rule #1), so the
 * path is POSIX-normalised here.
 */
export function ensureSharedArtifactEol(
  projectRoot: string,
  artifactAbsPath: string,
): 'created' | 'updated' | 'unchanged' {
  const rel = path.relative(projectRoot, artifactAbsPath).split(path.sep).join('/');
  // Outside the project entirely (an absolute artifact on a shared drive) —
  // there is no repo of ours to annotate.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'unchanged';

  const attributesPath = path.join(projectRoot, '.gitattributes');
  const rule = `/${rel} text eol=lf`;
  const existed = fs.existsSync(attributesPath);
  const lines = existed ? fs.readFileSync(attributesPath, 'utf-8').split(/\r?\n/) : [];

  // Any existing rule naming this exact path wins, whatever it says.
  const alreadyRuled = lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    const pattern = trimmed.split(/\s+/)[0];
    return pattern === `/${rel}` || pattern === rel;
  });
  if (alreadyRuled) return 'unchanged';

  const next = [...lines];
  if (next.length && next[next.length - 1].trim() !== '') next.push('');
  next.push('# moflo team-shared learnings: LF so the artifact stays diffable and merge-friendly');
  next.push(rule);

  const content = next.join('\n').replace(/\n+$/, '') + '\n';
  atomicWriteFileSync(attributesPath, content);
  return existed ? 'updated' : 'created';
}
