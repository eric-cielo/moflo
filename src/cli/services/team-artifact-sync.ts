/**
 * Git-tracked team learnings artifact (#1234, epic #1231; reconciling since #1463).
 *
 * Story 1 (#1232) shared a durable SQLite store between worktrees; Story 2
 * (#1233) carried a durable SQLite artifact between one user's machines. This
 * story shares durable learnings across a *team*: a **git-tracked directory**
 * (default `.moflo/shared/learnings/`, one JSON file per entry, explicitly NOT
 * gitignored) that the team commits. Each teammate's session-start import-merges it into their local
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
 * Sorted lines still conflicted whenever two branches added keys that sort next
 * to each other, and GitHub ignores merge drivers when it judges a PR
 * mergeable. So the artifact is now a directory of one file per entry (#1506),
 * and a configured `.jsonl` path migrates to it on the next export — see
 * `team-artifact-store.ts`, which owns the on-disk format. Everything below
 * operates on the parsed `Map<id, line>`.
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
  isPrunableTombstone,
  TOMBSTONE_TTL_MS,
  type ReconcileRecord,
} from './durable-reconcile.js';
import {
  readDurableSnapshot,
  applyDurableActions,
  type DurablePayload,
} from './durable-store-io.js';
import { detectToolCallMarkup } from '../memory/tool-call-markup.js';
import {
  TOMBSTONE_NAMESPACE,
  isTombstoneLine,
  lineToRecord,
  readArtifact,
  writeArtifact,
  teamArtifactPaths,
  type TeamProvenance,
  type TeamArtifactEntry,
  type TeamTombstone,
} from './team-artifact-store.js';

// The line shapes moved to the storage module with #1506; re-exported so every
// existing importer of this module keeps compiling.
export {
  TOMBSTONE_NAMESPACE,
  isTombstoneLine,
  teamArtifactPaths,
  teamArtifactExists,
  type TeamProvenance,
  type TeamArtifactEntry,
  type TeamTombstone,
  type TeamArtifactLine,
} from './team-artifact-store.js';

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

/**
 * Default artifact directory, relative to the project root. The pre-#1506
 * default `learnings.jsonl` beside it is migrated by the next export.
 */
export const DEFAULT_TEAM_ARTIFACT_REL = path.join('.moflo', 'shared', 'learnings');

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
  /**
   * Entries copied in from the old single-file JSONL artifact this run (#1506).
   * Counted only when the file was then removed — see {@link migratedFrom}.
   */
  migrated: number;
  /** The old JSONL file this export migrated and deleted, or null. */
  migratedFrom: string | null;
  /**
   * Entries NOT written because their file will not parse — almost always
   * unresolved git conflict markers. Resolve the conflict and export again.
   */
  blocked: number;
  /** Malformed entry files or JSONL lines skipped while reading the artifact. */
  skippedMalformed: number;
  /**
   * Local entries NOT shared because their value carries captured tool-call
   * markup (#1467). Already-stored corruption stops propagating here, without
   * waiting for anyone to run a local cleanup pass first.
   */
  skippedCorrupt: number;
  /**
   * Lines dropped from the artifact because they are about a row no durable
   * store may hold — a `verify:*` record in `learnings` (#1495). Live and
   * tombstone lines alike: a tombstone for such a key has nothing to delete,
   * since every store's durable read already ignores it.
   */
  droppedMisfiled: number;
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
  /** Malformed entry files or JSONL lines skipped (bad JSON or missing namespace/key). */
  skippedMalformed: number;
  /** Well-formed lines skipped for being outside the durable namespaces. */
  skippedNonDurable: number;
  /**
   * Artifact lines skipped because their content carries captured tool-call
   * markup (#1467). The symmetric half of the export skip: a consumer whose
   * artifact is already polluted stops re-importing the corruption.
   */
  skippedCorrupt: number;
  /** Lines skipped as misfiled (#1495) — see {@link ExportReport.droppedMisfiled}. */
  skippedMisfiled: number;
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
    // created_at/updated_at are INTEGER NOT NULL — never bind null. A line with
    // no created_at falls back to its edit time, never the import time: stamping
    // now makes a re-imported old entry read as a new learning, which is what
    // inflated growth metrics after every re-seed (#1495).
    createdAt:
      typeof line.created_at === 'number'
        ? line.created_at
        : typeof line.updated_at === 'number'
          ? line.updated_at
          : Date.now(),
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

  const artifact = readArtifact(opts.artifactPath);
  const { lines, records: target, malformed, misfiled, existed } = artifact;
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

  // #1467 — a local row whose value carries captured tool-call markup is not
  // shared. Dropping it from the SOURCE (rather than the artifact) means it is
  // simply not propagated: `planReconcile` derives deletions from a local
  // tombstone, never from an absent key, so this can't publish a retraction of
  // someone else's line.
  //
  // Gated on `record.content`, which a tombstone does not have, NOT on the
  // payload: archiving leaves `content` intact, so a payload lookup would still
  // see the corrupt body of a row the user already deleted and would suppress
  // its tombstone — making a corrupt line already in the artifact permanently
  // unretractable. Deleting the current entry mid-iteration is well-defined for
  // a Map, so no copy is needed.
  let skippedCorrupt = 0;
  for (const [id, record] of records) {
    if (typeof record.content !== 'string' || !detectToolCallMarkup(record.content)) continue;
    records.delete(id);
    payloads.delete(id);
    skippedCorrupt++;
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

  // Skip the write when the merge changed nothing AND the artifact already
  // exists: a git-tracked artifact should not show up as modified after a
  // no-op run. A write also rewrites only the entry files that moved. An old
  // JSONL file still present always forces one, so it is migrated and removed.
  const changed =
    actions.length > 0 ||
    prunedTombstones > 0 ||
    backfilled > 0 ||
    misfiled > 0 ||
    artifact.misplaced > 0 ||
    artifact.legacyPath !== null;
  const wrote = changed || !existed;
  const written = wrote ? writeArtifact(lines, artifact) : null;

  return {
    artifactPath: artifact.dir,
    added: summary.inserted,
    updated: summary.updated,
    deleted: summary.deleted,
    resurrected: summary.resurrected,
    unchanged: summary.unchanged,
    keptRemote: summary.keptTargetNewer,
    prunedTombstones,
    backfilled,
    migrated: written?.removedLegacy ? artifact.fromLegacy : 0,
    migratedFrom: written?.removedLegacy ?? null,
    blocked: written?.blocked ?? 0,
    skippedMalformed: malformed,
    skippedCorrupt,
    droppedMisfiled: misfiled,
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
    skippedCorrupt: 0,
    skippedMisfiled: 0,
  };

  const { lines, records: parsed, malformed, misfiled } = readArtifact(opts.artifactPath);
  report.skippedMalformed = malformed;
  report.skippedMisfiled = misfiled;
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
    // #1467 — never write captured tool-call markup into the local store, even
    // when a teammate on an older moflo already shared it. Tombstones carry no
    // content and are always applied: a deletion must still propagate.
    if (!isTombstoneLine(line) && detectToolCallMarkup(line.content)) {
      report.skippedCorrupt++;
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
 * The dominant line ending already in a file. Both writers below rewrite whole
 * files they did not author, so they must hand back the style they were given —
 * splitting on `/\r?\n/` and re-joining with `\n` silently converts every
 * unrelated line in a CRLF checkout, which is the opposite of the narrow,
 * one-line edit these functions promise (Rule #1).
 */
function detectEol(raw: string): '\r\n' | '\n' {
  const newlines = (raw.match(/\n/g) ?? []).length;
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  return crlf > newlines - crlf ? '\r\n' : '\n';
}

/**
 * Render one path as a literal gitattributes pattern.
 *
 * The artifact path is caller-supplied (`flo memory team-export --to ...`), so
 * it can carry whitespace or glob metacharacters. Unescaped, `team notes.jsonl`
 * parses as the pattern `team` plus garbage, and a `*` in the name would match
 * files the user never named. Glob metacharacters are escaped first; the result
 * is then C-quoted if it contains whitespace, which doubles the backslashes the
 * escape pass added — that is correct, since git un-quotes before globbing.
 *
 * `suffix` is appended unescaped — it is how a directory artifact gets its
 * `/**` (a bare directory pattern does not apply to the files inside it).
 */
function gitattributesPattern(rel: string, suffix = ''): string {
  const pattern = `/${rel.replace(/([\\*?[\]])/g, '\\$1')}${suffix}`;
  if (!/[\s"]/.test(pattern)) return pattern;
  return `"${pattern.replace(/(["\\])/g, '\\$1')}"`;
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
  const raw = existed ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const eol = existed ? detectEol(raw) : '\n';
  const lines = existed ? raw.split(/\r?\n/) : [];

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
  const content = next.join(eol).replace(/(\r?\n)+$/, '') + eol;
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
  const rel = path.relative(projectRoot, teamArtifactPaths(artifactAbsPath).dir).split(path.sep).join('/');
  // Outside the project entirely (an absolute artifact on a shared drive) —
  // there is no repo of ours to annotate.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'unchanged';

  const attributesPath = path.join(projectRoot, '.gitattributes');
  // The artifact is a directory (#1506): pin its contents, not its own name —
  // a bare directory pattern does not apply to the files inside it.
  const suffix = '/**';
  const pattern = gitattributesPattern(rel, suffix);
  const existed = fs.existsSync(attributesPath);
  const raw = existed ? fs.readFileSync(attributesPath, 'utf-8') : '';
  const eol = existed ? detectEol(raw) : '\n';
  const lines = existed ? raw.split(/\r?\n/) : [];

  // macOS APFS and Windows NTFS are case-insensitive by default, so a rule
  // differing only in case there names the SAME file and must count as already
  // ruled. On a case-sensitive filesystem it names a different file, and
  // skipping ours would leave the artifact unpinned — so the fold is applied
  // only where the filesystem actually folds (Rule #1).
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (v: string): string => (caseInsensitive ? v.toLowerCase() : v);
  const candidates = [fold(pattern), fold(`/${rel}${suffix}`), fold(`${rel}${suffix}`)];

  // Any existing rule naming this path wins, whatever it says.
  const alreadyRuled = lines.some((line) => {
    const trimmed = fold(line.trim());
    if (!trimmed || trimmed.startsWith('#')) return false;
    return candidates.some(
      (c) => trimmed === c || trimmed.startsWith(`${c} `) || trimmed.startsWith(`${c}\t`),
    );
  });
  if (alreadyRuled) return 'unchanged';

  const next = [...lines];
  if (next.length && next[next.length - 1].trim() !== '') next.push('');
  next.push('# moflo team-shared learnings: LF so the artifact stays diffable and merge-friendly');
  next.push(`${pattern} text eol=lf`);

  const content = next.join(eol).replace(/(\r?\n)+$/, '') + eol;
  atomicWriteFileSync(attributesPath, content);
  return existed ? 'updated' : 'created';
}

/**
 * Stage the artifact in git when the team already tracks it, so a commit
 * carries the export it triggered.
 *
 * Pre-commit hooks written for the single-file artifact stage only
 * `learnings.jsonl`. After the migration (#1506) deletes that file they would
 * stage the deletion and miss the directory that replaced it — and after that,
 * nothing at all. Staging here keeps every existing hook working with no
 * reconfiguration. Only moflo's own artifact paths are touched, and only when
 * git already tracks one of them: an untracked artifact stays the user's call.
 *
 * Returns true when something was staged. Never throws.
 */
export function stageTeamArtifact(projectRoot: string, artifactPath: string): boolean {
  const { dir, legacy } = teamArtifactPaths(artifactPath);
  const git = (args: string[]): { ok: boolean; out: string } => {
    try {
      // spawnSync without a shell — paths are passed as argv, never interpolated (Rule #1).
      const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 });
      return { ok: r.status === 0, out: (r.stdout || '').trim() };
    } catch {
      return { ok: false, out: '' };
    }
  };
  const tracked = (p: string): boolean => {
    const r = git(['ls-files', '--', p]);
    return r.ok && r.out.length > 0;
  };
  // A tracked legacy path is staged too, so its deletion lands in the same commit.
  const paths = [dir, legacy].filter(tracked);
  if (paths.length === 0) return false;
  if (!paths.includes(dir) && fs.existsSync(dir)) paths.push(dir);
  return git(['add', '-A', '--', ...paths]).ok;
}
