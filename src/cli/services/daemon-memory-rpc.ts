/**
 * Daemon HTTP RPC for memory writes + reads (#981 / #1058 — single-writer
 * architecture and its read-side symmetry).
 *
 * Adds POST /api/memory/{store,delete,batch,get,search,list} to the existing
 * daemon HTTP server. The daemon becomes the single authoritative writer AND
 * the single source-of-truth for reads when reachable; other processes (CLI,
 * MCP server) route through the daemon-write-client (Story #984 / #1058) so
 * they never serve stale rows from a per-process sql.js snapshot.
 *
 * Read endpoints (#1058): bridgeGetEntry/Search/List in a non-daemon process
 * queries the bridge's in-memory snapshot loaded at process start. sql.js
 * never re-reads disk, so any write by the daemon is invisible to that
 * process until restart. Routing reads here lets every process see the
 * daemon's authoritative state in real time.
 *
 * Loopback-only: the parent server binds 127.0.0.1, so no auth/CSRF.
 *
 * @module daemon-memory-rpc
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryAccessor } from '../spells/types/step-command.types.js';
import { errorDetail } from '../shared/utils/error-detail.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum POST body size for memory RPC. Larger bodies → 413.
 * 1 MiB is well above any reasonable single entry while bounding
 * pathological loopback writes (defense-in-depth even on 127.0.0.1).
 */
export const MEMORY_RPC_MAX_BODY_BYTES = 1024 * 1024;

/** Conservative namespace pattern: alphanumerics, dot, dash, underscore. ≤64 chars. */
const NAMESPACE_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/** Max key length. Aligns with the existing memory_entries TEXT column conventions. */
const KEY_MAX_LENGTH = 256;

/** Max ops per batch. Bounds memory + write time per request. */
export const BATCH_MAX_OPS = 100;

/** Cap on serialised `metadata` per op (#1064); 64 KB leaves room for a 100-op batch under {@link MEMORY_RPC_MAX_BODY_BYTES}. */
const METADATA_MAX_BYTES = 64 * 1024;

// ============================================================================
// Op shapes (validated; not exported as the wire-format contract is HTTP)
// ============================================================================

interface StoreOp {
  op?: 'store';
  namespace: string;
  key: string;
  value: unknown;
  tags?: string[];
  ttl?: number;
  /** Pre-serialised JSON for the `metadata` TEXT column; capped at METADATA_MAX_BYTES (#1064). */
  metadata?: string;
}

interface DeleteOp {
  op?: 'delete';
  namespace: string;
  key: string;
}

interface GetOp {
  namespace: string;
  key: string;
}

interface SearchOp {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
}

interface ListOp {
  namespace?: string;
  limit?: number;
  offset?: number;
}

type BatchOp =
  | (StoreOp & { op: 'store' })
  | (DeleteOp & { op: 'delete' });

// ============================================================================
// JSON body reader (size-capped, never throws)
// ============================================================================

/**
 * Read a JSON request body with a hard byte cap. Returns null on:
 *   - body exceeds {@link MEMORY_RPC_MAX_BODY_BYTES}
 *   - body is not valid JSON
 *   - request errors before completion
 *
 * Never throws. Caller maps null → 400.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (result: unknown | null): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MEMORY_RPC_MAX_BODY_BYTES) {
        // Stop accumulating; let the request finish but discard.
        chunks.length = 0;
        finish(null);
        return;
      }
      if (!done) chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        finish(raw.length === 0 ? null : JSON.parse(raw));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

// ============================================================================
// Validation
// ============================================================================

function isNamespace(ns: unknown): ns is string {
  return typeof ns === 'string' && NAMESPACE_PATTERN.test(ns);
}

function isKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= KEY_MAX_LENGTH;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/** Validate optional `metadata` and return the already-serialised string so the INSERT site doesn't re-stringify (#1064). */
function validateMetadata(value: unknown): { ok: true; metadata: string | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, metadata: undefined };
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > METADATA_MAX_BYTES) {
      return { ok: false, error: `metadata exceeds ${METADATA_MAX_BYTES} bytes` };
    }
    try { JSON.parse(value); }
    catch { return { ok: false, error: 'metadata string is not valid JSON' }; }
    return { ok: true, metadata: value };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'metadata must be a JSON object or stringified JSON' };
  }
  let serialised: string;
  try { serialised = JSON.stringify(value); }
  catch { return { ok: false, error: 'metadata is not serialisable' }; }
  if (Buffer.byteLength(serialised, 'utf8') > METADATA_MAX_BYTES) {
    return { ok: false, error: `metadata exceeds ${METADATA_MAX_BYTES} bytes` };
  }
  return { ok: true, metadata: serialised };
}

function validateStorePayload(body: unknown): { ok: true; op: StoreOp } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (!isNamespace(b.namespace)) return { ok: false, error: `invalid namespace (must match ${NAMESPACE_PATTERN}, ≤64 chars)` };
  if (!isKey(b.key)) return { ok: false, error: `invalid key (non-empty string ≤${KEY_MAX_LENGTH} chars)` };
  if (b.value === undefined) return { ok: false, error: 'value is required' };
  if (b.tags !== undefined && !isStringArray(b.tags)) return { ok: false, error: 'tags must be an array of strings' };
  if (b.ttl !== undefined && (typeof b.ttl !== 'number' || !Number.isFinite(b.ttl) || b.ttl <= 0)) {
    return { ok: false, error: 'ttl must be a positive finite number (seconds)' };
  }
  const metaResult = validateMetadata(b.metadata);
  if (!metaResult.ok) return { ok: false, error: metaResult.error };
  return {
    ok: true,
    op: {
      namespace: b.namespace,
      key: b.key,
      value: b.value,
      tags: b.tags as string[] | undefined,
      ttl: b.ttl as number | undefined,
      metadata: metaResult.metadata,
    },
  };
}

function validateDeletePayload(body: unknown): { ok: true; op: DeleteOp } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (!isNamespace(b.namespace)) return { ok: false, error: 'invalid namespace' };
  if (!isKey(b.key)) return { ok: false, error: 'invalid key' };
  return { ok: true, op: { namespace: b.namespace, key: b.key } };
}

function validateGetPayload(body: unknown): { ok: true; op: GetOp } | { ok: false; error: string } {
  // Get takes the same shape as delete.
  return validateDeletePayload(body) as { ok: true; op: GetOp } | { ok: false; error: string };
}

/** Max query length for /api/memory/search — matches the existing memory_search MCP tool bound. */
const MAX_SEARCH_QUERY_LENGTH = 4096;

function validateSearchPayload(body: unknown): { ok: true; op: SearchOp } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.query !== 'string' || b.query.length === 0) {
    return { ok: false, error: 'query must be a non-empty string' };
  }
  if (b.query.length > MAX_SEARCH_QUERY_LENGTH) {
    return { ok: false, error: `query exceeds ${MAX_SEARCH_QUERY_LENGTH} chars` };
  }
  // Namespace is optional; when provided must validate (allow 'all' for cross-NS search).
  if (b.namespace !== undefined && b.namespace !== 'all' && !isNamespace(b.namespace)) {
    return { ok: false, error: `invalid namespace (must match ${NAMESPACE_PATTERN}, 'all', or omitted)` };
  }
  if (b.limit !== undefined && (typeof b.limit !== 'number' || !Number.isInteger(b.limit) || b.limit <= 0 || b.limit > 1000)) {
    return { ok: false, error: 'limit must be a positive integer ≤1000' };
  }
  if (b.threshold !== undefined && (typeof b.threshold !== 'number' || b.threshold < 0 || b.threshold > 1)) {
    return { ok: false, error: 'threshold must be a number in [0, 1]' };
  }
  return {
    ok: true,
    op: {
      query: b.query,
      namespace: b.namespace as string | undefined,
      limit: b.limit as number | undefined,
      threshold: b.threshold as number | undefined,
    },
  };
}

function validateListPayload(body: unknown): { ok: true; op: ListOp } | { ok: false; error: string } {
  // body may be empty for list-all; coerce null → {}.
  const b: Record<string, unknown> = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (b.namespace !== undefined && !isNamespace(b.namespace)) {
    return { ok: false, error: `invalid namespace (must match ${NAMESPACE_PATTERN} or be omitted)` };
  }
  if (b.limit !== undefined && (typeof b.limit !== 'number' || !Number.isInteger(b.limit) || b.limit <= 0 || b.limit > 10_000)) {
    return { ok: false, error: 'limit must be a positive integer ≤10000' };
  }
  if (b.offset !== undefined && (typeof b.offset !== 'number' || !Number.isInteger(b.offset) || b.offset < 0)) {
    return { ok: false, error: 'offset must be a non-negative integer' };
  }
  return {
    ok: true,
    op: {
      namespace: b.namespace as string | undefined,
      limit: b.limit as number | undefined,
      offset: b.offset as number | undefined,
    },
  };
}

function validateBatchPayload(body: unknown):
  | { ok: true; ops: BatchOp[] }
  | { ok: false; error: string; index?: number } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be a JSON object' };
  const ops = (body as { ops?: unknown }).ops;
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: 'ops must be a non-empty array' };
  }
  if (ops.length > BATCH_MAX_OPS) {
    return { ok: false, error: `batch too large (max ${BATCH_MAX_OPS} ops)` };
  }
  const validated: BatchOp[] = [];
  for (let i = 0; i < ops.length; i++) {
    const raw = ops[i] as Record<string, unknown> | null | undefined;
    const opType = raw?.op;
    if (opType === 'store') {
      const r = validateStorePayload(raw);
      if (!r.ok) return { ok: false, error: r.error, index: i };
      validated.push({ op: 'store', ...r.op });
    } else if (opType === 'delete') {
      const r = validateDeletePayload(raw);
      if (!r.ok) return { ok: false, error: r.error, index: i };
      validated.push({ op: 'delete', ...r.op });
    } else {
      return { ok: false, error: "op must be 'store' or 'delete'", index: i };
    }
  }
  return { ok: true, ops: validated };
}

// ============================================================================
// JSON response helper (intentionally duplicates daemon-dashboard's helper —
// keeping this module standalone simplifies testing and avoids a circular
// dep when daemon-dashboard imports the route handlers below).
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-cache',
  });
  res.end(json);
}

function valueToString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// ============================================================================
// Route handlers
// ============================================================================

/** Lazy import to avoid a circular dep with memory-initializer's heavy graph. */
async function getMemoryFns(): Promise<{
  storeEntry: typeof import('../memory/memory-initializer.js').storeEntry;
  deleteEntry: typeof import('../memory/memory-initializer.js').deleteEntry;
  getEntry: typeof import('../memory/memory-initializer.js').getEntry;
  searchEntries: typeof import('../memory/memory-initializer.js').searchEntries;
  listEntries: typeof import('../memory/memory-initializer.js').listEntries;
}> {
  const mod = await import('../memory/memory-initializer.js');
  return {
    storeEntry: mod.storeEntry,
    deleteEntry: mod.deleteEntry,
    getEntry: mod.getEntry,
    searchEntries: mod.searchEntries,
    listEntries: mod.listEntries,
  };
}

/**
 * POST /api/memory/store — write a single entry through the daemon's
 * authoritative sql.js path. Upsert semantics (matches `memory_store`
 * MCP tool default — see #962 for why this is required).
 */
export async function handleMemoryStore(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAccessor | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(res, 503, { error: 'Memory accessor not attached' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
    return;
  }
  const v = validateStorePayload(body);
  if (!v.ok) {
    sendJson(res, 400, { error: 'Invalid store request', message: v.error });
    return;
  }
  try {
    const { storeEntry } = await getMemoryFns();
    const result = await storeEntry({
      key: v.op.key,
      value: valueToString(v.op.value),
      namespace: v.op.namespace,
      tags: v.op.tags,
      ttl: v.op.ttl,
      metadata: v.op.metadata,
      upsert: true,
    });
    if (!result.success) {
      sendJson(res, 500, { error: 'Store failed', message: result.error ?? 'unknown' });
      return;
    }
    // #1065 — preserve the bridge's `embedding: { dimensions, model }` shape
    // through the wire boundary. Without this, MCP `memory_store` reports
    // `hasEmbedding: false` on every daemon-routed write that actually
    // succeeded, and the doctor Memory Access check fails.
    sendJson(res, 200, { ok: true, stored: true, id: result.id, embedding: result.embedding });
  } catch (err) {
    sendJson(res, 500, { error: 'Internal error', message: errorDetail(err) });
  }
}

/**
 * POST /api/memory/delete — remove an entry via the daemon's authoritative
 * write path.
 */
export async function handleMemoryDelete(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAccessor | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(res, 503, { error: 'Memory accessor not attached' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
    return;
  }
  const v = validateDeletePayload(body);
  if (!v.ok) {
    sendJson(res, 400, { error: 'Invalid delete request', message: v.error });
    return;
  }
  try {
    const { deleteEntry } = await getMemoryFns();
    const result = await deleteEntry({ key: v.op.key, namespace: v.op.namespace });
    if (!result.success) {
      sendJson(res, 500, { error: 'Delete failed', message: result.error ?? 'unknown' });
      return;
    }
    sendJson(res, 200, { ok: true, deleted: result.deleted });
  } catch (err) {
    sendJson(res, 500, { error: 'Internal error', message: errorDetail(err) });
  }
}

/**
 * POST /api/memory/batch — apply a sequence of store/delete ops.
 *
 * Validation is all-or-nothing: any invalid op fails the request with 400
 * and no application. Application is sequential: a failure mid-stream
 * returns 207 Multi-Status with structured per-op results so the caller
 * can retry only the failures.
 *
 * True transactional atomicity isn't possible without a long-lived
 * write-handle inside the daemon (a future evolution); for now this
 * mirrors the existing `storeEntries` fallback semantics.
 */
export async function handleMemoryBatch(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAccessor | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(res, 503, { error: 'Memory accessor not attached' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
    return;
  }
  const v = validateBatchPayload(body);
  if (!v.ok) {
    sendJson(res, 400, { error: 'Invalid batch request', message: v.error, index: v.index });
    return;
  }
  const { storeEntry, deleteEntry } = await getMemoryFns();
  const results: Array<{ ok: boolean; id?: string; deleted?: boolean; embedding?: { dimensions: number; model: string }; error?: string }> = [];
  let anyFailed = false;
  for (const op of v.ops) {
    try {
      if (op.op === 'store') {
        const r = await storeEntry({
          key: op.key,
          value: valueToString(op.value),
          namespace: op.namespace,
          tags: op.tags,
          ttl: op.ttl,
          metadata: op.metadata,
          upsert: true,
        });
        if (r.success) {
          // #1065 — same shape carry-through as /store: include embedding
          // so batch callers can report hasEmbedding accurately.
          results.push({ ok: true, id: r.id, embedding: r.embedding });
        } else {
          results.push({ ok: false, error: r.error ?? 'unknown' });
          anyFailed = true;
        }
      } else {
        const r = await deleteEntry({ key: op.key, namespace: op.namespace });
        if (r.success) {
          results.push({ ok: true, deleted: r.deleted });
        } else {
          results.push({ ok: false, error: r.error ?? 'unknown' });
          anyFailed = true;
        }
      }
    } catch (err) {
      results.push({ ok: false, error: errorDetail(err) });
      anyFailed = true;
    }
  }
  sendJson(res, anyFailed ? 207 : 200, { ok: !anyFailed, results });
}

/**
 * POST /api/memory/get — retrieve a single entry from the daemon's
 * authoritative bridge. In a non-daemon process the bridge holds a stale
 * sql.js snapshot from process-start time (#1058); routing the read here
 * lets the daemon serve the up-to-date row.
 */
export async function handleMemoryGet(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAccessor | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(res, 503, { error: 'Memory accessor not attached' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
    return;
  }
  const v = validateGetPayload(body);
  if (!v.ok) {
    sendJson(res, 400, { error: 'Invalid get request', message: v.error });
    return;
  }
  try {
    const { getEntry } = await getMemoryFns();
    const result = await getEntry({ key: v.op.key, namespace: v.op.namespace });
    if (!result.success) {
      sendJson(res, 500, { error: 'Get failed', message: result.error ?? 'unknown' });
      return;
    }
    sendJson(res, 200, { ok: true, found: result.found, entry: result.entry });
  } catch (err) {
    sendJson(res, 500, { error: 'Internal error', message: errorDetail(err) });
  }
}

/**
 * POST /api/memory/search — semantic vector search routed through the
 * daemon's authoritative bridge.
 */
export async function handleMemorySearch(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAccessor | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(res, 503, { error: 'Memory accessor not attached' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
    return;
  }
  const v = validateSearchPayload(body);
  if (!v.ok) {
    sendJson(res, 400, { error: 'Invalid search request', message: v.error });
    return;
  }
  try {
    const { searchEntries } = await getMemoryFns();
    const result = await searchEntries({
      query: v.op.query,
      namespace: v.op.namespace,
      limit: v.op.limit,
      threshold: v.op.threshold,
    });
    if (!result.success) {
      sendJson(res, 500, { error: 'Search failed', message: result.error ?? 'unknown' });
      return;
    }
    sendJson(res, 200, { ok: true, results: result.results, searchTime: result.searchTime });
  } catch (err) {
    sendJson(res, 500, { error: 'Internal error', message: errorDetail(err) });
  }
}

/**
 * POST /api/memory/list — list entries via the daemon's bridge with optional
 * namespace filter and pagination.
 */
export async function handleMemoryList(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAccessor | undefined,
): Promise<void> {
  if (!memory) {
    sendJson(res, 503, { error: 'Memory accessor not attached' });
    return;
  }
  const body = await readJsonBody(req);
  // List allows an empty body (list-all default); a JSON-parse failure on a
  // non-empty body is still a 400, but a literal empty body coerces to {}.
  let parsed: unknown = body;
  if (body === null) {
    // Distinguish "empty body" from "invalid JSON" — readJsonBody returns null
    // for both, so probe content-length to tell them apart.
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > 0) {
      sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
      return;
    }
    parsed = {};
  }
  const v = validateListPayload(parsed);
  if (!v.ok) {
    sendJson(res, 400, { error: 'Invalid list request', message: v.error });
    return;
  }
  try {
    const { listEntries } = await getMemoryFns();
    const result = await listEntries({
      namespace: v.op.namespace,
      limit: v.op.limit,
      offset: v.op.offset,
    });
    if (!result.success) {
      sendJson(res, 500, { error: 'List failed', message: result.error ?? 'unknown' });
      return;
    }
    sendJson(res, 200, { ok: true, entries: result.entries, total: result.total });
  } catch (err) {
    sendJson(res, 500, { error: 'Internal error', message: errorDetail(err) });
  }
}

// ============================================================================
// URL match — tight whitelist; any other /api/memory/* falls through.
// ============================================================================

export type MemoryRpcRoute = 'store' | 'delete' | 'batch' | 'get' | 'search' | 'list';

export function matchMemoryRpcRoute(url: string | undefined): MemoryRpcRoute | null {
  if (!url) return null;
  const path = url.split('?')[0];
  if (path === '/api/memory/store') return 'store';
  if (path === '/api/memory/delete') return 'delete';
  if (path === '/api/memory/batch') return 'batch';
  if (path === '/api/memory/get') return 'get';
  if (path === '/api/memory/search') return 'search';
  if (path === '/api/memory/list') return 'list';
  return null;
}
