/**
 * Memory entry write path: store / bulk-store / delete.
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition). All writes
 * follow the #981 single-writer routing preamble (route through the daemon's
 * HTTP RPC when one is reachable), then fall back to the AgentDB v3 bridge,
 * then to a direct node:sqlite write via the unified `openDaemonDatabase`
 * factory.
 *
 * @module memory/entries-write
 */

import * as fs from 'fs';
import { errorDetail } from '../shared/utils/error-detail.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';
import { ensureSchemaColumns } from './schema.js';
import { generateEmbedding } from './embedding-model.js';
import { addToHNSWIndex } from './hnsw-singleton.js';
import { getBridge } from './bridge-loader.js';
import { tryDaemonStore, tryDaemonDelete } from './daemon-write-client.js';
import { EMBEDDING_MODEL_OPT_OUT, getBridgeEmbedder, isEphemeralNamespace } from './bridge-embedder.js';
import { toFloat32 } from './controllers/_shared.js';
import { serialiseMetadata } from './bridge-entries.js';
import { logRoutingFault, writeVectorStatsCache } from './entries-shared.js';

/**
 * Store an entry directly via node:sqlite.
 * This bypasses MCP and writes directly to the database.
 */
export async function storeEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  precomputedEmbedding?: Float32Array | number[];
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
  /** Per-row JSON for the `metadata` TEXT column; defaults to `'{}'` when omitted (#1064). */
  metadata?: Record<string, unknown> | string;
}): Promise<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  error?: string;
}> {
  // Soft-redirect: `knowledge` is a deprecated alias for `learnings`. Writes
  // are accepted but routed to learnings with provenance tags so future
  // decay/prune treats user-forced entries as locked. Old consumer DBs that
  // still have raw `knowledge` rows are migrated by
  // bin/migrate-knowledge-to-learnings.mjs at session start.
  if (options.namespace === 'knowledge') {
    const incoming = options.tags ?? [];
    const merged = new Set<string>(incoming);
    merged.add('source:user');
    merged.add('locked');
    options = { ...options, namespace: 'learnings', tags: [...merged] };
  }

  // #1203 — write-time provenance for the `learnings` namespace. Every learning
  // must carry a `source:<origin>` tag so the Luminarium "Learnings" panel can
  // show where each lesson came from. Specific writers stamp their own source
  // (auto-meditate's distill pass → `source:auto-meditate`; the /meditate skill
  // → `source:meditate-manual`; the knowledge redirect above → `source:user`).
  // Anything else that lands in `learnings` without a source tag is an ad-hoc
  // `memory_store`, tagged `source:manual`. Purely additive — rows that predate
  // this simply lack the tag and fall into the panel's "legacy/unknown" bucket.
  if (options.namespace === 'learnings') {
    const tags = options.tags ?? [];
    if (!tags.some((t) => typeof t === 'string' && t.startsWith('source:'))) {
      options = { ...options, tags: [...tags, 'source:manual'] };
    }
  }

  // #981 — single-writer routing. When an external daemon is reachable AND
  // we're not the daemon ourselves AND no custom dbPath was supplied, route
  // the write through the daemon's HTTP RPC so its in-memory handle stays
  // authoritative. Any failure path falls through to the existing bridge /
  // direct-write logic below — byte-identical behaviour to today.
  if (
    !options.dbPath
    && process.env.MOFLO_IS_DAEMON !== '1'
    && process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1'
  ) {
    try {
      const routed = await tryDaemonStore({
        namespace: options.namespace ?? 'default',
        key: options.key,
        value: options.value,
        tags: options.tags,
        ttl: options.ttl,
        metadata: options.metadata,
      });
      if (routed.routed && routed.ok) {
        // #1065 — surface the daemon's embedding metadata so the MCP
        // memory_store handler reports `hasEmbedding: true` on
        // daemon-routed writes (matching the bridge-direct shape).
        return { success: true, id: routed.id ?? '', embedding: routed.embedding };
      }
      // #1101 — daemon validated and rejected (4xx). Bridge-direct would
      // fail the same way; surface the daemon's error instead of silently
      // falling back.
      if (routed.routed && routed.ok === false) {
        return { success: false, id: '', error: routed.error ?? 'Daemon rejected store request' };
      }
    } catch (err) {
      logRoutingFault(err);
    }
  }

  // ADR-053: Try AgentDB v3 bridge first. The bridge calls
  // refreshVectorStatsCache() itself (bridge-entries.ts:191) — a second
  // write here was redundant and previously clobbered the correct count
  // with 0 (#639).
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeStoreEntry(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: direct node:sqlite write via the unified factory.
  const {
    key,
    value,
    namespace = 'default',
    generateEmbeddingFlag = true,
    tags = [],
    ttl,
    dbPath: customPath,
    upsert = false
  } = options;

  const dbPath = customPath || memoryDbPath(process.cwd());

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, id: '', error: 'Database not initialized. Run: flo memory init' };
    }

    // Ensure schema has all required columns (migration for older DBs)
    await ensureSchemaColumns(dbPath);

    const db = openDaemonDatabase(dbPath);

    const id = `entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = Date.now();

    // generateEmbedding() throws on embed failure; the outer try/catch returns
    // success:false rather than inserting a null-embedded row. Opt-out rows
    // (generateEmbeddingFlag=false) are tagged EMBEDDING_MODEL_OPT_OUT — see
    // the constant's docstring in bridge-embedder.ts for the rationale.
    // Ephemeral namespaces (#729) skip embedding entirely AND tag model NULL.
    let embeddingJson: string | null = null;
    let embeddingDimensions: number | null = null;
    let embeddingModel: string | null = EMBEDDING_MODEL_OPT_OUT;

    const isEphemeralNs = isEphemeralNamespace(namespace);
    if (isEphemeralNs) {
      embeddingModel = null;
    } else if (generateEmbeddingFlag && value.length > 0) {
      if (options.precomputedEmbedding) {
        // Tag with the bridge embedder's canonical model so precomputed rows
        // are indistinguishable from live single-embed rows downstream.
        const vec = toFloat32(options.precomputedEmbedding);
        embeddingJson = JSON.stringify(Array.from(vec));
        embeddingDimensions = vec.length;
        embeddingModel = getBridgeEmbedder().model;
      } else {
        const embResult = await generateEmbedding(value);
        embeddingJson = JSON.stringify(embResult.embedding);
        embeddingDimensions = embResult.dimensions;
        embeddingModel = embResult.model;
      }
    }

    // Idempotency guard. By the time we reach the direct-write fallback, an
    // earlier write attempt — daemon route via `tryDaemonStore`, or bridge
    // via `bridgeStoreEntry` — may have already persisted this exact row to
    // disk. If a post-persist throw escaped the bridge's inner guards (#994,
    // #982), `bridgeStoreEntry` returned null and we landed here. Re-running
    // a plain INSERT would then trip the UNIQUE constraint on `(namespace,
    // key)` and surface as `exit 1` even though the data is durable on disk
    // — exactly the cascade described in `bridge-entries.ts:205`. If the
    // existing row matches the value the caller asked us to write, treat
    // this as a successful no-op and propagate the existing id instead of
    // re-inserting. If the content differs, fall through to INSERT — the
    // UNIQUE error is then a real "key already taken with other content"
    // signal that the caller deserves to see.
    if (!upsert) {
      let existingRow: { id: string; content: string } | null = null;
      const probe = db.prepare(
        `SELECT id, content FROM memory_entries WHERE namespace = ? AND key = ? AND status = 'active' LIMIT 1`,
      );
      try {
        probe.bind([namespace, key]);
        if (probe.step()) {
          existingRow = probe.getAsObject() as { id: string; content: string };
        }
      } finally {
        probe.free();
      }
      if (existingRow && existingRow.content === value) {
        db.close();
        return {
          success: true,
          id: String(existingRow.id),
          embedding: embeddingJson
            ? { dimensions: embeddingDimensions!, model: embeddingModel! }
            : undefined,
        };
      }
    }

    // Insert or update entry (upsert mode uses REPLACE)
    const insertSql = upsert
      ? `INSERT OR REPLACE INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      : `INSERT INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`;

    db.run(insertSql, [
      id,
      key,
      namespace,
      value,
      embeddingJson,
      embeddingDimensions,
      embeddingModel,
      tags.length > 0 ? JSON.stringify(tags) : null,
      serialiseMetadata(options.metadata),
      now,
      now,
      ttl ? now + (ttl * 1000) : null
    ]);

    // node:sqlite + WAL persisted that INSERT on commit — the sql.js
    // whole-file `db.export()` + atomicWriteFileSync that lived here was
    // the multi-writer clobber vector epic #1078 killed structurally.

    // Query exact stats while DB is still open. `missing` is the active-rows-
    // with-NULL-embedding count, surfaced via vector-stats.json so the
    // statusline can warn on coverage holes (#648 / #649).
    let vecCount = 0, nsCount = 0, missingCount = 0;
    try {
      const vc = db.exec("SELECT COUNT(*) FROM memory_entries WHERE status='active' AND embedding IS NOT NULL");
      vecCount = vc[0]?.values?.[0]?.[0] as number ?? 0;
      const nc = db.exec("SELECT COUNT(DISTINCT namespace) FROM memory_entries WHERE status='active'");
      nsCount = nc[0]?.values?.[0]?.[0] as number ?? 0;
      const mc = db.exec("SELECT COUNT(*) FROM memory_entries WHERE status='active' AND embedding IS NULL");
      missingCount = mc[0]?.values?.[0]?.[0] as number ?? 0;
    } catch { /* table may not have status column in older DBs */ }

    db.close();

    // Add to HNSW index for faster future searches
    if (embeddingJson) {
      const embResult = JSON.parse(embeddingJson) as number[];
      await addToHNSWIndex(id, embResult, {
        id,
        key,
        namespace,
        content: value
      });
    }

    // Update statusline cache with exact counts
    writeVectorStatsCache(dbPath, { vectorCount: vecCount, namespaces: nsCount, missing: missingCount });

    return {
      success: true,
      id,
      embedding: embeddingJson ? { dimensions: embeddingDimensions!, model: embeddingModel! } : undefined
    };
  } catch (error) {
    return {
      success: false,
      id: '',
      error: errorDetail(error)
    };
  }
}

/**
 * Bulk-store entries — batches writes through the bridge in a single
 * persist-once transaction. Falls back to sequential `storeEntry()` calls
 * (each persisting independently) when the bridge is unavailable.
 */
export async function storeEntries(items: Array<{
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  precomputedEmbedding?: Float32Array | number[];
  tags?: string[];
  ttl?: number;
  upsert?: boolean;
  /** See {@link storeEntry} for the metadata contract (#1064). */
  metadata?: Record<string, unknown> | string;
}>, dbPath?: string): Promise<Array<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  error?: string;
}>> {
  if (items.length === 0) return [];
  const bridge = await getBridge();
  if (bridge && typeof bridge.bridgeStoreEntries === 'function') {
    const bridgeResult = await bridge.bridgeStoreEntries(items, dbPath);
    if (bridgeResult) return bridgeResult;
  }
  // Fallback: sequential single-entry writes (each persists). Slow but correct.
  const out: Array<{ success: boolean; id: string; embedding?: { dimensions: number; model: string }; error?: string }> = [];
  for (const item of items) {
    out.push(await storeEntry({ ...item, dbPath }));
  }
  return out;
}

/**
 * Delete a memory entry by key and namespace
 * Issue #980: Properly supports namespaced entries
 */
export async function deleteEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  key: string;
  namespace: string;
  remainingEntries: number;
  error?: string;
}> {
  // #981 — single-writer routing for deletes. Same gates as storeEntry:
  // not the daemon, no custom dbPath, routing not opted out. Failure paths
  // fall through to the existing bridge / direct-write logic below.
  if (
    !options.dbPath
    && process.env.MOFLO_IS_DAEMON !== '1'
    && process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1'
  ) {
    try {
      const routed = await tryDaemonDelete({
        namespace: options.namespace ?? 'default',
        key: options.key,
      });
      if (routed.routed && routed.ok) {
        return {
          success: true,
          deleted: routed.deleted ?? true,
          key: options.key,
          namespace: options.namespace ?? 'default',
          // Daemon doesn't surface remainingEntries; callers that depend on
          // this value (the `flo memory delete` CLI) read it from a
          // subsequent stat query, not this return shape.
          remainingEntries: 0,
        };
      }
      // #1101 — daemon rejected delete args (4xx); propagate.
      if (routed.routed && routed.ok === false) {
        return {
          success: false,
          deleted: false,
          key: options.key,
          namespace: options.namespace ?? 'default',
          remainingEntries: 0,
          error: routed.error ?? 'Daemon rejected delete request',
        };
      }
    } catch (err) {
      logRoutingFault(err);
    }
  }

  // ADR-053: Try AgentDB v3 bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeDeleteEntry(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: direct node:sqlite write via the unified factory.
  const {
    key,
    namespace = 'default',
    dbPath: customPath
  } = options;

  const dbPath = customPath || memoryDbPath(process.cwd());

  try {
    if (!fs.existsSync(dbPath)) {
      return {
        success: false,
        deleted: false,
        key,
        namespace,
        remainingEntries: 0,
        error: 'Database not found'
      };
    }

    // Ensure schema has all required columns (migration for older DBs)
    await ensureSchemaColumns(dbPath);

    const db = openDaemonDatabase(dbPath);

    // Check if entry exists first
    const checkResult = db.exec(`
      SELECT id FROM memory_entries
      WHERE status = 'active'
        AND key = '${key.replace(/'/g, "''")}'
        AND namespace = '${namespace.replace(/'/g, "''")}'
      LIMIT 1
    `);

    if (!checkResult[0]?.values?.[0]) {
      // Get remaining count before closing
      const countResult = db.exec(`SELECT COUNT(*) FROM memory_entries WHERE status = 'active'`);
      const remainingEntries = countResult[0]?.values?.[0]?.[0] as number || 0;
      db.close();
      return {
        success: true,
        deleted: false,
        key,
        namespace,
        remainingEntries,
        error: `Key '${key}' not found in namespace '${namespace}'`
      };
    }

    // Hard-delete the entry. Soft-delete was retired in story #728: tombstones
    // were write-only (no code ever restored from status='deleted') and bloated
    // the DB indefinitely.
    db.run(
      `DELETE FROM memory_entries WHERE key = ? AND namespace = ? AND status = 'active'`,
      [key, namespace],
    );

    // Get remaining count
    const countResult = db.exec(`SELECT COUNT(*) FROM memory_entries WHERE status = 'active'`);
    const remainingEntries = countResult[0]?.values?.[0]?.[0] as number || 0;

    // WAL persisted the DELETE incrementally — no whole-file dump needed.
    db.close();

    return {
      success: true,
      deleted: true,
      key,
      namespace,
      remainingEntries
    };
  } catch (error) {
    return {
      success: false,
      deleted: false,
      key,
      namespace,
      remainingEntries: 0,
      error: errorDetail(error)
    };
  }
}
