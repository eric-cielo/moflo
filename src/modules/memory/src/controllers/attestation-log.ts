/**
 * AttestationLog — moflo-owned append-only audit log (epic #464 Phase C2).
 *
 * Replaces `agentdb.AttestationLog`. Writes observability records into a
 * sql.js-backed table with a hash chain so tampering can be detected.
 *
 * Consumer surface (from src/modules/cli/src/memory/memory-bridge.ts):
 *   - record({ operation, entryId, timestamp?, ...metadata })
 *   - log(operation, entryId, metadata?)   // alternate signature
 *   - count()
 *
 * Non-goals: this is observability, not authenticated provenance. Hashes
 * use SHA-256 so local tamper-detection is possible, but there is no
 * signature layer.
 */

import { createHash } from 'node:crypto';
import { parseJsonSafe } from './_shared.js';
import type { SqlJsDatabaseLike } from './types.js';

export interface AttestationEntry {
  operation: string;
  entryId: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

const TABLE = 'moflo_attestation_log';
const GENESIS_HASH = '0'.repeat(64);

export class AttestationLog {
  private db: SqlJsDatabaseLike;
  private lastHash: string = GENESIS_HASH;

  constructor(db: SqlJsDatabaseLike) {
    if (!db) throw new Error('AttestationLog requires a sql.js Database');
    this.db = db;
    this.ensureSchema();
    this.lastHash = this.fetchLastHash();
  }

  /**
   * Primary record API. memory-bridge.ts calls this with
   * `{ operation, entryId, timestamp, ...metadata }`.
   */
  record(entry: { operation: string; entryId: string; timestamp?: number; [key: string]: unknown }): void {
    const { operation, entryId, timestamp, ...metadata } = entry;
    this.append(operation, entryId, metadata, typeof timestamp === 'number' ? timestamp : Date.now());
  }

  /**
   * Alternate signature memory-bridge falls back to when `record` is absent.
   */
  log(operation: string, entryId: string, metadata?: Record<string, unknown>): void {
    this.append(operation, entryId, metadata ?? {}, Date.now());
  }

  /**
   * Count of attestation entries. Used by memory-bridge stats.
   */
  count(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    try {
      stmt.step();
      const row = stmt.getAsObject();
      return Number(row.n ?? 0);
    } finally {
      stmt.free();
    }
  }

  /**
   * Return recent entries (newest first). Primarily used by tests and
   * future admin tooling.
   */
  list(limit: number = 100): AttestationEntry[] {
    const safeLimit = Math.max(1, Math.min(limit, 10_000));
    const stmt = this.db.prepare(
      `SELECT operation, entry_id, ts, metadata, prev_hash, entry_hash
       FROM ${TABLE}
       ORDER BY id DESC
       LIMIT ${safeLimit}`,
    );
    const rows: AttestationEntry[] = [];
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        rows.push({
          operation: String(r.operation),
          entryId: String(r.entry_id),
          timestamp: Number(r.ts),
          metadata: parseJsonSafe(r.metadata),
          prevHash: String(r.prev_hash),
          entryHash: String(r.entry_hash),
        });
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  /**
   * Walk the hash chain in insertion order and return true if every link
   * matches. Lets callers detect tampering.
   */
  verify(): boolean {
    const stmt = this.db.prepare(
      `SELECT operation, entry_id, ts, metadata, prev_hash, entry_hash
       FROM ${TABLE}
       ORDER BY id ASC`,
    );
    let expectedPrev = GENESIS_HASH;
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        if (String(r.prev_hash) !== expectedPrev) return false;
        const recomputed = hashEntry(
          String(r.operation),
          String(r.entry_id),
          Number(r.ts),
          parseJsonSafe(r.metadata),
          expectedPrev,
        );
        if (recomputed !== String(r.entry_hash)) return false;
        expectedPrev = recomputed;
      }
    } finally {
      stmt.free();
    }
    return true;
  }

  // ----- private -----

  private append(
    operation: string,
    entryId: string,
    metadata: Record<string, unknown>,
    ts: number,
  ): void {
    const metaJson = JSON.stringify(metadata ?? {});
    const entryHash = hashEntry(operation, entryId, ts, metadata, this.lastHash);
    this.db.run(
      `INSERT INTO ${TABLE} (ts, operation, entry_id, metadata, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ts, operation, entryId, metaJson, this.lastHash, entryHash],
    );
    this.lastHash = entryHash;
  }

  private ensureSchema(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        operation TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        metadata TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_ts ON ${TABLE}(ts);
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_entry ON ${TABLE}(entry_id);`,
    );
  }

  private fetchLastHash(): string {
    const stmt = this.db.prepare(
      `SELECT entry_hash FROM ${TABLE} ORDER BY id DESC LIMIT 1`,
    );
    try {
      if (stmt.step()) {
        const row = stmt.getAsObject();
        return String(row.entry_hash ?? GENESIS_HASH);
      }
    } finally {
      stmt.free();
    }
    return GENESIS_HASH;
  }
}

function hashEntry(
  operation: string,
  entryId: string,
  ts: number,
  metadata: Record<string, unknown>,
  prevHash: string,
): string {
  const canonical = JSON.stringify({
    op: operation,
    id: entryId,
    ts,
    meta: metadata ?? {},
    prev: prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export default AttestationLog;
