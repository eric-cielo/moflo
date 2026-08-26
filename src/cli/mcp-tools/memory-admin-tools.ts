/**
 * Memory administration MCP Tools for CLI
 *
 * `memory_export` / `memory_import` / `memory_cleanup` / `memory_compress` /
 * `memory_detailed-stats` were called by `flo memory export|import|cleanup|
 * compress` and `flo status memory` but never registered, so each command
 * printed its progress banner and then died with `MCP tool not found` (#1349).
 *
 * Every number these handlers report is measured, not modelled: byte counts
 * come from `statSync` on the real artifact, entry counts from the rows
 * actually written, and search latency from a timed query. Deletes route
 * through `deleteEntry` so they honour the daemon single-writer path (#981)
 * rather than issuing raw SQL against a database another process may own.
 *
 * @module v3/cli/mcp-tools/memory-admin-tools
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MCPTool } from './types.js';
import { BACKEND_LABEL } from '../memory/database-provider.js';
// Every handler here reads or writes the store, so each must pass through the
// same init/migration gate the core memory tools use. Without it, a project
// whose DB has not been created yet has no `memory_entries` table and writes
// silently no-op — which is how an import "succeeded" against nothing.
import { ensureInitialized } from './memory-tools.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { resolveStateRoot } from '../services/project-root.js';
import { DURABLE_NAMESPACES } from '../services/cherry-pick-learnings.js';

interface ExportedEntry {
  key: string;
  namespace: string;
  content: string;
  tags: string[];
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  embedding: string | null;
}

function dbPath(): string {
  return memoryDbPath(resolveStateRoot());
}

function dbSizeBytes(): number {
  const path = dbPath();
  return existsSync(path) ? statSync(path).size : 0;
}

// NOTE: a fourth copy of this (commands/status.ts:71, commands/embeddings.ts:503,
// plugins/store/ipfs-client.ts:385 — the last already exported). Consolidating
// them is a cross-cutting change with its own output-format risk, so it is left
// for a follow-up rather than folded into this fix.
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function openDb() {
  const { openDaemonDatabase } = await import('../memory/daemon-backend.js');
  return openDaemonDatabase(dbPath());
}

/** Run a read-only query and return rows as arrays of primitives. */
async function query(sql: string): Promise<unknown[][]> {
  if (!existsSync(dbPath())) return [];
  const db = await openDb();
  try {
    const result = db.exec(sql);
    return result[0]?.values ?? [];
  } finally {
    db.close();
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Read active entries for export.
 *
 * `withEmbeddings` is a cost lever, not a formatting one: a 384-dim vector
 * serializes to ~8 KB, so selecting the column for a CSV or a
 * `includeVectors:false` export would materialize hundreds of MB on a large
 * store purely to discard it.
 */
async function readAllEntries(namespace?: string, withEmbeddings = true): Promise<ExportedEntry[]> {
  const where = namespace
    ? `WHERE status = 'active' AND namespace = ${sqlString(namespace)}`
    : `WHERE status = 'active'`;
  const embeddingCol = withEmbeddings ? 'embedding' : 'NULL AS embedding';
  const rows = await query(
    `SELECT key, namespace, content, tags, metadata, created_at, updated_at, expires_at, ${embeddingCol} ` +
    `FROM memory_entries ${where} ORDER BY namespace, key`
  );
  return rows.map(r => ({
    key: String(r[0]),
    namespace: String(r[1]),
    content: String(r[2] ?? ''),
    tags: parseTags(r[3]),
    metadata: r[4] == null ? null : String(r[4]),
    createdAt: Number(r[5] ?? 0),
    updatedAt: Number(r[6] ?? 0),
    expiresAt: r[7] == null ? null : Number(r[7]),
    embedding: r[8] == null ? null : String(r[8]),
  }));
}

function parseTags(raw: unknown): string[] {
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toCsv(entries: ExportedEntry[]): string {
  const cell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['key', 'namespace', 'content', 'tags', 'createdAt', 'updatedAt'];
  const lines = [header.join(',')];
  for (const e of entries) {
    lines.push([
      cell(e.key), cell(e.namespace), cell(e.content),
      cell(e.tags.join('|')), cell(e.createdAt), cell(e.updatedAt),
    ].join(','));
  }
  // LF on every platform, deliberately (Rule #1 item 4): a fixed terminator
  // keeps an export byte-identical across Windows/macOS/Linux, and every CSV
  // reader accepts LF. Platform EOL here would make the same store hash
  // differently per OS.
  return lines.join('\n') + '\n';
}

/** `30d`, `12h`, `90m` → milliseconds. Returns null when unparseable. */
function parseDuration(raw: unknown): number | null {
  if (raw == null) return null;
  const m = /^(\d+)\s*([smhdw])$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const scale: Record<string, number> = {
    s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  };
  return n * scale[unit];
}

export const memoryAdminTools: MCPTool[] = [
  {
    name: 'memory_export',
    description: 'Export memory entries to a JSON or CSV file on disk',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'File to write' },
        format: { type: 'string', description: 'json (default) or csv' },
        namespace: { type: 'string', description: 'Export only this namespace' },
        includeVectors: { type: 'boolean', description: 'Include embeddings in a JSON export (default true)' },
      },
      required: ['outputPath'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const outputPath = resolve(String(input.outputPath ?? ''));
      const format = String(input.format ?? 'json').toLowerCase();
      const includeVectors = input.includeVectors !== false;
      const namespace = input.namespace ? String(input.namespace) : undefined;

      // CSV has no column for a vector, so neither path needs the bytes.
      const wantVectors = includeVectors && format !== 'csv';
      const entries = await readAllEntries(namespace, wantVectors);
      const vectors = entries.filter(e => e.embedding != null).length;

      const dir = dirname(outputPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      if (format === 'csv') {
        writeFileSync(outputPath, toCsv(entries), 'utf8');
      } else {
        const payload = {
          version: 1,
          backend: BACKEND_LABEL,
          exportedAt: new Date().toISOString(),
          namespace: namespace ?? null,
          entries,
        };
        writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
      }

      return {
        outputPath,
        format,
        exported: {
          entries: entries.length,
          // Counted from the rows actually written, so a CSV or a
          // vector-less export reports 0 because 0 landed.
          vectors,
        },
        fileSize: formatBytes(statSync(outputPath).size),
      };
    },
  },
  {
    name: 'memory_import',
    description: 'Import memory entries from a file written by memory_export',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'File to read' },
        merge: { type: 'boolean', description: 'Skip keys that already exist instead of overwriting (default true)' },
        namespace: { type: 'string', description: 'Override the namespace every entry is imported into' },
      },
      required: ['inputPath'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const started = Date.now();
      const inputPath = resolve(String(input.inputPath ?? ''));
      if (!existsSync(inputPath)) {
        throw new Error(`Import file not found: ${inputPath}`);
      }
      const merge = input.merge !== false;
      const overrideNs = input.namespace ? String(input.namespace) : undefined;

      const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as {
        entries?: Array<Partial<ExportedEntry>>;
      };
      const incoming = Array.isArray(parsed.entries) ? parsed.entries : [];

      const { storeEntry, getEntry } = await import('../memory/memory-initializer.js');

      let entries = 0;
      let vectors = 0;
      let skipped = 0;
      // Kept apart from `skipped` on purpose: an entry the store refused is
      // not a duplicate, and folding the two together is how a wholly failed
      // import reads as "3 duplicates skipped" (#1349).
      let failed = 0;
      const errors: string[] = [];

      for (const e of incoming) {
        if (!e.key) {
          failed++;
          errors.push('entry with no key');
          continue;
        }
        const namespace = overrideNs ?? e.namespace ?? 'default';

        if (merge) {
          const existing = await getEntry({ key: e.key, namespace });
          if (existing.found) { skipped++; continue; }
        }

        let precomputedEmbedding: number[] | undefined;
        if (e.embedding) {
          try {
            const vec = JSON.parse(e.embedding);
            if (Array.isArray(vec) && vec.length > 0) precomputedEmbedding = vec.map(Number);
          } catch {
            // Corrupt vector in the dump — import the text, regenerate later.
          }
        }

        const result = await storeEntry({
          key: e.key,
          value: String(e.content ?? ''),
          namespace,
          tags: e.tags,
          metadata: e.metadata ?? undefined,
          precomputedEmbedding,
          // `generateEmbeddingFlag` gates the whole embedding branch, not just
          // the generate-vs-reuse choice: with it false, storeEntry writes a
          // NULL embedding and ignores `precomputedEmbedding` entirely. It
          // must stay true for a dumped vector to survive the round trip.
          generateEmbeddingFlag: true,
          upsert: true,
        });

        if (result.success) {
          entries++;
          // Count what storeEntry reports it persisted, never what we sent.
          if (result.embedding) vectors++;
        } else {
          failed++;
          if (errors.length < 5) {
            errors.push(`${namespace}/${e.key}: ${result.error ?? 'store failed'}`);
          }
        }
      }

      return {
        inputPath,
        imported: { entries, vectors },
        skipped,
        failed,
        errors,
        duration: Date.now() - started,
      };
    },
  },
  {
    name: 'memory_cleanup',
    description: 'Find and optionally delete expired, stale, or unusable memory entries. Durable namespaces (learnings, knowledge) are exempt from the age-based buckets unless named via `namespace`; TTL-expired rows are collected everywhere.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', description: 'Actually delete. Omit (the default) to report candidates only.' },
        dryRun: { type: 'boolean', description: 'Ignored. Cleanup is dry unless apply:true is passed; accepted only so older callers do not error.' },
        olderThan: { type: 'string', description: 'Age cutoff for stale/unusable entries, e.g. "30d"' },
        expiredOnly: { type: 'boolean', description: 'Only consider TTL-expired entries' },
        namespace: { type: 'string', description: 'Restrict cleanup to one namespace. Naming a durable namespace (learnings, knowledge) also opts it back into the age-based buckets it is exempt from by default.' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const started = Date.now();
      // Deleting is opt-IN. The caller must ask for it explicitly: the CLI
      // computes candidates, prompts, and only then re-calls with apply:true.
      // Previously this deleted on the same call that counted candidates, so
      // answering "no" at the prompt printed "Cleanup cancelled" after the
      // rows were already gone (#1349).
      const dryRun = input.apply !== true;
      const expiredOnly = input.expiredOnly === true;
      const namespace = input.namespace ? String(input.namespace) : undefined;
      const staleMs = parseDuration(input.olderThan);
      const now = Date.now();

      const nsClause = namespace ? ` AND namespace = ${sqlString(namespace)}` : '';
      const select = (cond: string): string =>
        `SELECT key, namespace FROM memory_entries WHERE status = 'active' AND ${cond}${nsClause}`;

      // #1464 — durable namespaces are exempt from the two AGE-based buckets
      // unless the caller names one explicitly.
      //
      // Age is not evidence of worthlessness for a learning: a two-year-old
      // architectural decision is routinely the most valuable row in the store.
      // Worse, `COALESCE(last_accessed_at, updated_at, created_at)` collapses to
      // `created_at` for any row nothing has ever bumped — and until #1464 the
      // search path, which is how learnings are actually read, bumped nothing.
      // So "stale (unused)" silently meant "old", and the only purge surface
      // moflo ships hit the most-consulted learnings exactly as hard as the dead
      // ones.
      //
      // A DEFAULT, not a prohibition — `--namespace learnings` still collects
      // them. TTL-expired rows stay in scope in every namespace; durable rows
      // never set a TTL, so nothing durable is lost through that bucket.
      const exemptDurable = !namespace;
      const durableIn = DURABLE_NAMESPACES.map(sqlString).join(', ');
      const durableClause = exemptDurable ? ` AND namespace NOT IN (${durableIn})` : '';

      const expired = await query(select(`expires_at IS NOT NULL AND expires_at < ${now}`));

      const ageCutoff = staleMs != null ? now - staleMs : null;
      const staleCond = ageCutoff == null ? null
        : `expires_at IS NULL AND COALESCE(last_accessed_at, updated_at, created_at) < ${ageCutoff}`;

      // "Unusable" = no embedding (so invisible to semantic search), never
      // read back, AND older than the caller's cutoff.
      //
      // The age gate is a safety interlock, not a refinement. A NULL embedding
      // means "the embedding model did not run", which on a project where the
      // model never loaded is EVERY row — without `olderThan` this rule
      // selected the entire store for deletion by default. Requiring an
      // explicit cutoff means an unqualified cleanup can only ever remove
      // TTL-expired rows.
      const lowQualityCond = ageCutoff == null ? null
        : `embedding IS NULL AND COALESCE(access_count, 0) = 0 `
          + `AND COALESCE(last_accessed_at, updated_at, created_at) < ${ageCutoff}`;

      const ageBuckets = !expiredOnly && staleCond != null && lowQualityCond != null;

      const stale = ageBuckets ? await query(select(staleCond + durableClause)) : [];
      const lowQuality = ageBuckets ? await query(select(lowQualityCond + durableClause)) : [];

      // Count what the exemption withheld. Without this the operator reads a
      // clean result as "learnings are already tidy" rather than "learnings were
      // not examined" — the same class of quiet lie the missing usage signal was.
      //
      // The TTL exclusion is not cosmetic: `lowQualityCond` does not test
      // `expires_at`, so without it a durable row with an elapsed TTL would be
      // reported as held back in the same call that deletes it through the
      // expired bucket.
      const heldBackRows = ageBuckets && exemptDurable
        ? await query(
            `SELECT COUNT(*) FROM memory_entries WHERE status = 'active'`
            + ` AND namespace IN (${durableIn})`
            + ` AND NOT (expires_at IS NOT NULL AND expires_at < ${now})`
            + ` AND ((${staleCond}) OR (${lowQualityCond}))`
          )
        : [];
      const durableHeldBack = heldBackRows.length ? Number(heldBackRows[0][0] ?? 0) : 0;

      const seen = new Set<string>();
      const targets: Array<{ key: string; namespace: string }> = [];
      for (const rows of [expired, stale, lowQuality]) {
        for (const row of rows) {
          const key = String(row[0]);
          const ns = String(row[1]);
          const id = `${ns} ${key}`;
          if (seen.has(id)) continue;
          seen.add(id);
          targets.push({ key, namespace: ns });
        }
      }

      const candidates = {
        expired: expired.length,
        stale: stale.length,
        lowQuality: lowQuality.length,
        total: targets.length,
      };

      if (dryRun) {
        return {
          dryRun: true,
          candidates,
          durableHeldBack,
          deleted: { entries: 0 },
          freed: { bytes: 0, formatted: '0 B' },
          duration: Date.now() - started,
        };
      }

      const sizeBefore = dbSizeBytes();
      const { deleteEntry } = await import('../memory/memory-initializer.js');
      let deleted = 0;
      for (const target of targets) {
        const result = await deleteEntry(target);
        if (result.deleted) deleted++;
      }
      const freedBytes = Math.max(0, sizeBefore - dbSizeBytes());

      return {
        dryRun: false,
        candidates,
        durableHeldBack,
        deleted: { entries: deleted },
        freed: { bytes: freedBytes, formatted: formatBytes(freedBytes) },
        duration: Date.now() - started,
      };
    },
  },
  {
    name: 'memory_compress',
    description: 'Reclaim memory database space (SQLite VACUUM) and optionally rebuild the HNSW index',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'fast | balanced | max — max also runs an incremental integrity pass' },
        target: { type: 'string', description: 'Reserved; VACUUM compacts the whole store' },
        rebuildIndex: { type: 'boolean', description: 'Drop and rebuild the in-process HNSW index (default true)' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const started = Date.now();
      const rebuildIndex = input.rebuildIndex !== false;
      const level = String(input.level ?? 'balanced');

      if (!existsSync(dbPath())) {
        throw new Error(`No memory database at ${dbPath()} — run "flo memory init" first`);
      }

      // VACUUM needs an exclusive lock and is the one mutation here that does
      // NOT route through the storeEntry/deleteEntry chokepoint. Epic #1054's
      // single-writer invariant says a CLI process must not write moflo.db
      // while the daemon owns it, so refuse loudly instead of racing it — a
      // blocked VACUUM would otherwise stall or fail as SQLITE_BUSY.
      // getDaemonLockHolder already ran isProcessAlive + isDaemonProcess before
      // returning a PID, so re-checking cannot change the answer — and on
      // Windows it would re-run the tasklist/powershell probe (up to 8s per
      // daemon-lock.ts) for nothing.
      const { getDaemonLockHolder } = await import('../services/daemon-lock.js');
      const { findProjectRoot } = await import('../services/project-root.js');
      const holder = getDaemonLockHolder(findProjectRoot());
      if (holder !== null && holder !== process.pid) {
        throw new Error(
          `The moflo daemon (PID ${holder}) currently owns the memory database. ` +
          `Compression needs exclusive access — stop it first with "flo daemon stop", ` +
          `then re-run "flo memory compress".`
        );
      }

      const { searchEntries, clearHNSWIndex, getHNSWStatus } = await import('../memory/memory-initializer.js');

      const timeSearch = async (): Promise<number> => {
        const t0 = performance.now();
        try {
          await searchEntries({ query: 'compression latency probe', limit: 5 });
        } catch {
          // A failed probe must not be reported as a fast one.
          return -1;
        }
        return performance.now() - t0;
      };

      // Warm up first. The very first search in a process pays embedding-model
      // load (tens of ms); timing that as the "before" sample and a warm query
      // as the "after" reports a 30x speedup that compression did not produce.
      await timeSearch();

      const bytesBefore = dbSizeBytes();
      const latencyBefore = await timeSearch();

      const db = await openDb();
      try {
        if (level === 'max') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.exec('VACUUM');
      } finally {
        db.close();
      }

      let indexRebuilt = false;
      if (rebuildIndex) {
        clearHNSWIndex();
        // The index is lazily rebuilt on next search; time that rebuild as
        // part of the "after" latency rather than claiming it was free.
        indexRebuilt = true;
      }

      const bytesAfter = dbSizeBytes();
      const latencyAfter = await timeSearch();
      const bytesSaved = Math.max(0, bytesBefore - bytesAfter);

      const speedup = latencyBefore > 0 && latencyAfter > 0
        ? `${(latencyBefore / latencyAfter).toFixed(2)}x`
        : 'n/a';

      const sizes = (total: number) => ({
        totalSize: formatBytes(total),
        vectorsSize: 'n/a',
        textSize: 'n/a',
        patternsSize: 'n/a',
        indexSize: 'n/a',
      });

      return {
        before: sizes(bytesBefore),
        after: sizes(bytesAfter),
        compression: {
          // before/after — a store compacted 100MB->80MB is 1.25x smaller.
          // after/before yielded 0.8 and printed as "0.80x", reading as growth.
          ratio: bytesAfter > 0 ? Number((bytesBefore / bytesAfter).toFixed(4)) : 1,
          bytesSaved,
          formattedSaved: formatBytes(bytesSaved),
          // Embedding quantization is not applied to stored rows — the CLI no
          // longer advertises a --quantize flag, and this stays honest.
          quantizationApplied: false,
          indexRebuilt,
        },
        performance: {
          // null, not 0 — a probe that threw is unknown latency, and 0.00ms
          // renders as infinitely fast (the exact inversion #1349 is about).
          searchLatencyBefore: latencyBefore < 0 ? null : Number(latencyBefore.toFixed(2)),
          searchLatencyAfter: latencyAfter < 0 ? null : Number(latencyAfter.toFixed(2)),
          searchSpeedup: speedup,
        },
        hnsw: getHNSWStatus(),
        duration: Date.now() - started,
      };
    },
  },
  {
    name: 'memory_detailed-stats',
    description: 'Memory store statistics with per-namespace counts, on-disk size, and measured search latency',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        measureLatency: {
          type: 'boolean',
          description: 'Run a timed search to measure latency. Off by default — the probe loads the embedding model.',
        },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const { getNamespaceCounts, getEffectiveHNSWStatus, searchEntries } =
        await import('../memory/memory-initializer.js');

      const counts = await getNamespaceCounts();

      // Opt-in: the first search in a process loads the embedding model and
      // lazily builds the HNSW index — hundreds of ms to seconds. `flo status`
      // is expected to be instant, so it does not ask for this; `flo status
      // memory` does. null means "not measured", never 0.
      let avgSearchTime: number | null = null;
      if (input.measureLatency === true) {
        const t0 = performance.now();
        try {
          await searchEntries({ query: 'status probe', limit: 5 });
          avgSearchTime = Number((performance.now() - t0).toFixed(2));
        } catch {
          avgSearchTime = null;
        }
      }

      // The index that will serve the search, not this process's own singleton.
      // Reporting the singleton was true until #1058 routed reads through the
      // daemon; after that it read "not built" precisely when the daemon was
      // healthy, because a routed read never builds a local index (#1387).
      // `hnswSource` tells the caller which one answered.
      const hnsw = getEffectiveHNSWStatus();

      return {
        backend: BACKEND_LABEL,
        entries: counts.total,
        entriesWithEmbeddings: counts.withEmbeddings,
        size: dbSizeBytes(),
        namespaces: Object.entries(counts.namespaces)
          .map(([name, entries]) => ({ name, entries }))
          .sort((a, b) => b.entries - a.entries),
        performance: {
          avgSearchTime,
          hnswEnabled: hnsw.available && hnsw.initialized,
          // null, not 0 — a sidecar with no readable manifest has an unknown
          // vector count, and 0 renders as an empty index (the same inversion
          // this field already avoids for `avgSearchTime`).
          indexedVectors: hnsw.entryCount,
          hnswSource: hnsw.source,
        },
      };
    },
  },
];

export default memoryAdminTools;
