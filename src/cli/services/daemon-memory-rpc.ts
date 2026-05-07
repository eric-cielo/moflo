/**
 * Daemon HTTP RPC for memory writes (#981 — single-writer architecture).
 *
 * Adds POST /api/memory/{store,delete,batch} to the existing daemon HTTP
 * server. The daemon process becomes the single authoritative writer when
 * these endpoints are called; other processes (CLI, MCP server) route
 * writes here via the daemon-write-client (Story #984).
 *
 * Story #983 ships these endpoints purely additively — nothing in the
 * codebase calls them yet. Stories #985 / #986 wire consumer callers.
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
}

interface DeleteOp {
  op?: 'delete';
  namespace: string;
  key: string;
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
  return {
    ok: true,
    op: {
      namespace: b.namespace,
      key: b.key,
      value: b.value,
      tags: b.tags as string[] | undefined,
      ttl: b.ttl as number | undefined,
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
}> {
  const mod = await import('../memory/memory-initializer.js');
  return { storeEntry: mod.storeEntry, deleteEntry: mod.deleteEntry };
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
      upsert: true,
    });
    if (!result.success) {
      sendJson(res, 500, { error: 'Store failed', message: result.error ?? 'unknown' });
      return;
    }
    sendJson(res, 200, { ok: true, stored: true, id: result.id });
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
  const results: Array<{ ok: boolean; id?: string; deleted?: boolean; error?: string }> = [];
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
          upsert: true,
        });
        if (r.success) {
          results.push({ ok: true, id: r.id });
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

// ============================================================================
// URL match — tight whitelist; any other /api/memory/* falls through.
// ============================================================================

export type MemoryRpcRoute = 'store' | 'delete' | 'batch';

export function matchMemoryRpcRoute(url: string | undefined): MemoryRpcRoute | null {
  if (!url) return null;
  const path = url.split('?')[0];
  if (path === '/api/memory/store') return 'store';
  if (path === '/api/memory/delete') return 'delete';
  if (path === '/api/memory/batch') return 'batch';
  return null;
}
