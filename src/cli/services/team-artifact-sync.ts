/**
 * Git-tracked team learnings artifact (#1234, epic #1231).
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
 * Conflict policy: **first-write-wins**, applied two ways, both via the existing
 * `UNIQUE(namespace, key)` constraint:
 *   - on re-export, an entry already in the artifact keeps its original line
 *     (and original author/timestamp) — we never rewrite a teammate's row.
 *   - on import, `INSERT OR IGNORE` means a row already present locally wins,
 *     and within the file the first line for a key wins.
 *
 * Provenance: each exported entry is stamped with `author` (git user) + `source`
 * (hostname) so a learning's origin is visible in review and retained on import.
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
import { MEMORY_SCHEMA_V3 } from '../memory/memory-initializer.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../memory/daemon-backend.js';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { loadMofloConfig, type MofloConfig } from '../config/moflo-config.js';
import {
  DURABLE_NAMESPACES,
  DURABLE_INSERT_OR_IGNORE_SQL,
  hasMemoryEntriesTable,
  isDurableNamespace,
} from './cherry-pick-learnings.js';

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

/** Provenance stamped onto each shared entry so its origin survives review. */
export interface TeamProvenance {
  /** `git config user.name <user.email>`, or the OS user as a fallback. */
  author: string;
  /** Hostname of the machine that first shared the entry. */
  source: string;
  /** ISO timestamp the entry was first written to the artifact. */
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
  provenance: TeamProvenance;
}

export interface ExportReport {
  artifactPath: string;
  /** Entries newly added to the artifact this run (excludes ones already present). */
  added: number;
  /** Total entries in the artifact after the merge. */
  total: number;
}

export interface ImportReport {
  artifactPath: string;
  /** Rows actually inserted into the local DB (excludes duplicates). */
  imported: number;
  /** Durable rows read from the artifact (well-formed, durable-namespace lines). */
  considered: number;
  /** Malformed JSONL lines skipped (bad JSON or missing namespace/key). */
  skippedMalformed: number;
  /** Well-formed lines skipped for being outside the durable namespaces. */
  skippedNonDurable: number;
}

const KEY_SEP = String.fromCharCode(0); // in-memory dedup separator (collision-proof, kept out of source as a literal NUL)
const entryMapKey = (namespace: string, key: string): string => `${namespace}${KEY_SEP}${key}`;

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

/** Read + parse an existing artifact into a (namespace,key) → entry map. Missing file → empty. */
function readArtifact(artifactPath: string): { entries: Map<string, TeamArtifactEntry>; malformed: number } {
  const entries = new Map<string, TeamArtifactEntry>();
  let malformed = 0;
  if (!fs.existsSync(artifactPath)) return { entries, malformed };
  const raw = fs.readFileSync(artifactPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: TeamArtifactEntry | null = null;
    try {
      obj = JSON.parse(trimmed) as TeamArtifactEntry;
    } catch {
      malformed++;
      continue;
    }
    if (!obj || typeof obj.namespace !== 'string' || typeof obj.key !== 'string') {
      malformed++;
      continue;
    }
    const mapKey = entryMapKey(obj.namespace, obj.key);
    // First line for a key wins (first-write-wins inside the file).
    if (!entries.has(mapKey)) entries.set(mapKey, obj);
  }
  return { entries, malformed };
}

/** Serialise entries to JSONL, sorted by (namespace, key) for deterministic, reviewable diffs. */
function serializeArtifact(entries: Iterable<TeamArtifactEntry>): string {
  const sorted = [...entries].sort((a, b) =>
    a.namespace === b.namespace ? a.key.localeCompare(b.key) : a.namespace.localeCompare(b.namespace),
  );
  return sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length ? '\n' : '');
}

/** SELECT the local durable rows (learnings, knowledge) to be shared. */
function readLocalDurableRows(localDbPath: string): TeamArtifactEntry[] {
  if (!fs.existsSync(localDbPath)) return [];
  let db: SqlJsLikeDatabase;
  try {
    db = openDaemonDatabase(localDbPath);
  } catch {
    return [];
  }
  try {
    if (!hasMemoryEntriesTable(db)) return [];
    const placeholders = DURABLE_NAMESPACES.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT namespace, key, content, type, tags, created_at FROM memory_entries ` +
        `WHERE namespace IN (${placeholders})`,
    );
    stmt.bind(DURABLE_NAMESPACES.slice());
    const rows: TeamArtifactEntry[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject();
      rows.push({
        namespace: String(r.namespace),
        key: String(r.key),
        content: r.content == null ? '' : String(r.content),
        type: r.type == null ? 'semantic' : String(r.type),
        tags: parseTags(r.tags),
        created_at: r.created_at == null ? undefined : Number(r.created_at),
        // Provenance is filled by the caller (export) — placeholder here.
        provenance: { author: '', source: '', sharedAt: '' },
      });
    }
    stmt.free();
    return rows;
  } finally {
    db.close();
  }
}

function parseTags(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Export the local durable slice into the team artifact (merge, not overwrite).
 * Existing artifact entries keep their original line/provenance (first-write-wins);
 * only local durable rows whose key is absent are appended, stamped with this
 * machine's provenance. The artifact is rewritten sorted + atomically.
 */
export function exportTeamArtifact(opts: {
  projectRoot?: string;
  artifactPath: string;
  sharedAt: string;
  config?: MofloConfig;
}): ExportReport {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const localDbPath = memoryDbPath(projectRoot);
  const { entries } = readArtifact(opts.artifactPath);
  const author = resolveAuthor(projectRoot);
  const source = resolveSource();

  let added = 0;
  for (const row of readLocalDurableRows(localDbPath)) {
    const mapKey = entryMapKey(row.namespace, row.key);
    if (entries.has(mapKey)) continue; // never rewrite an existing (teammate's) entry
    entries.set(mapKey, { ...row, provenance: { author, source, sharedAt: opts.sharedAt } });
    added++;
  }

  fs.mkdirSync(path.dirname(opts.artifactPath), { recursive: true });
  atomicWriteFileSync(opts.artifactPath, serializeArtifact(entries.values()));
  return { artifactPath: opts.artifactPath, added, total: entries.size };
}

/**
 * Import-merge the team artifact into the local durable namespaces. `INSERT OR
 * IGNORE` on `UNIQUE(namespace, key)` makes this idempotent and first-write-wins
 * (existing local rows survive). Embeddings are left null — the daemon's index
 * pass fills them. No-op (zero rows) when the artifact is absent. Never throws on
 * a malformed line; those are counted and skipped.
 */
export function importTeamArtifact(opts: { projectRoot?: string; artifactPath: string }): ImportReport {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const localDbPath = memoryDbPath(projectRoot);
  const report: ImportReport = {
    artifactPath: opts.artifactPath,
    imported: 0,
    considered: 0,
    skippedMalformed: 0,
    skippedNonDurable: 0,
  };

  const { entries, malformed } = readArtifact(opts.artifactPath);
  report.skippedMalformed = malformed;
  if (entries.size === 0) return report;

  fs.mkdirSync(path.dirname(localDbPath), { recursive: true });
  const db = openDaemonDatabase(localDbPath);
  let insertStmt: ReturnType<SqlJsLikeDatabase['prepare']> | null = null;
  try {
    db.run(MEMORY_SCHEMA_V3);
    // Shared column list with the cherry-pick writer — single source of truth so
    // the two can't drift (a mismatch would mis-bind under INSERT OR IGNORE).
    insertStmt = db.prepare(DURABLE_INSERT_OR_IGNORE_SQL);
    // One transaction for the whole batch → a single fsync instead of one per
    // row on the (enabled) session-start hot path.
    db.run('BEGIN');
    try {
      for (const entry of entries.values()) {
        // The artifact is hand-editable by design — only durable namespaces
        // belong in the local durable slice; skip anything else rather than
        // polluting the DB (and so it isn't mis-counted as a duplicate).
        if (!isDurableNamespace(entry.namespace)) {
          report.skippedNonDurable++;
          continue;
        }
        report.considered++;
        const id = createHash('sha1').update(entryMapKey(entry.namespace, entry.key)).digest('hex');
        const metadata = JSON.stringify({ provenance: entry.provenance, sharedFrom: 'team-artifact' });
        // created_at/updated_at are INTEGER NOT NULL — never bind null (INSERT OR
        // IGNORE would silently drop the row on the constraint violation).
        const ts = typeof entry.created_at === 'number' ? entry.created_at : Date.now();
        insertStmt.bind([
          id,
          entry.key,
          entry.namespace,
          entry.content ?? '',
          coerceType(entry.type), // out-of-CHECK-set type would be silently dropped otherwise
          null, // embedding — regenerated by the daemon's index pass
          null, // embedding_model
          null, // embedding_dimensions
          entry.tags ? JSON.stringify(entry.tags) : null,
          metadata,
          entry.provenance?.author || null,
          ts,
          ts,
          'active',
        ]);
        insertStmt.step();
        if (db.getRowsModified() > 0) report.imported++;
        insertStmt.reset();
      }
      db.run('COMMIT');
    } catch (e) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* best-effort — the close() below also discards an open transaction */
      }
      throw e;
    }
  } finally {
    if (insertStmt) {
      try {
        insertStmt.free();
      } catch {
        /* best-effort cleanup */
      }
    }
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
