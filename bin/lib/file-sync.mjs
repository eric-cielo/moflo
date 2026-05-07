/**
 * Shared file-sync helper for the launcher (#854 §3) and the postinstall
 * bootstrap (#857 / #975).
 *
 * Both layers used to inline the same retry/breaker + copy logic. They drifted
 * once already (the bootstrap added hash-skip + atomic tmp+rename for #975
 * while the launcher kept the bare copyFileSync), so this module is the single
 * source of truth.
 *
 * Responsibilities:
 *   - hash-skip when src and dest are byte-identical (eliminates the dominant
 *     failure class — overwriting an unchanged file open by Claude/indexer).
 *   - atomic tmp + rename so concurrent readers never see a torn write.
 *   - post-write size verify to catch torn writes from AV mid-stream and
 *     partial DrvFs writes that returned success codes.
 *   - retry the transient error class (EBUSY/EPERM/EACCES + EVERIFY) with
 *     exponential backoff [50,200,800]ms.
 *   - circuit-break after CIRCUIT_BREAK_THRESHOLD distinct exhausted-retry
 *     failures so a sick host (AV mid-scan over node_modules) doesn't compound
 *     wall-clock cost.
 *
 * Ships at `bin/lib/file-sync.mjs`. Bootstrap imports via relative path from
 * `scripts/`; launcher imports via `./lib/file-sync.mjs` after sync to
 * `<consumer>/.claude/scripts/lib/`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
export const RETRY_BACKOFF_MS = [50, 200, 800];
export const CIRCUIT_BREAK_THRESHOLD = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fileHash(path) {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export function contentEqual(srcPath, destPath) {
  if (!existsSync(destPath)) return false;
  const srcHash = fileHash(srcPath);
  if (!srcHash) return false;
  const destHash = fileHash(destPath);
  return destHash !== null && srcHash === destHash;
}

/**
 * Atomic copy via tmp + rename with post-write size verify.
 *
 * Steps:
 *   1. copyFileSync(src, dest.tmp)
 *   2. Verify dest.tmp size matches src size (catches torn writes from AV
 *      mid-stream and partial DrvFs writes that returned success codes).
 *      Mismatch unlinks the tmp and throws { code: 'EVERIFY' }, which the
 *      retry loop treats as transient.
 *   3. renameSync(dest.tmp, dest) — atomic on Win/macOS/Linux/WSL/DrvFs.
 *
 * If rename fails, the .tmp sidecar persists as a recovery breadcrumb — next
 * session-start can complete the swap once the original lock has cleared.
 *
 * `deps` is dependency injection for tests (#976 fault injection of the
 * truncated-tmp / partial-DrvFs scenario). Production callers omit it.
 */
export function atomicCopy(src, dest, deps = {}) {
  const _copyFile = deps.copyFile || copyFileSync;
  const _stat = deps.stat || statSync;
  const _rename = deps.rename || renameSync;
  const _unlink = deps.unlink || unlinkSync;

  const tmp = `${dest}.tmp`;
  _copyFile(src, tmp);
  let srcSize, tmpSize;
  try {
    srcSize = _stat(src).size;
    tmpSize = _stat(tmp).size;
  } catch (statErr) {
    try { _unlink(tmp); } catch { /* best-effort cleanup */ }
    const err = new Error(`atomicCopy verify stat failed: ${statErr.message || statErr}`);
    err.code = statErr.code || 'EVERIFY';
    throw err;
  }
  if (srcSize !== tmpSize) {
    try { _unlink(tmp); } catch { /* best-effort cleanup */ }
    const err = new Error(
      `atomicCopy size mismatch (src=${srcSize} tmp=${tmpSize}) for ${dest}`,
    );
    err.code = 'EVERIFY';
    throw err;
  }
  _rename(tmp, dest);
}

export function errMessage(err) {
  if (!err) return 'unknown error';
  return err.code ? `${err.code} ${err.message || ''}`.trim() : (err.message || String(err));
}

/**
 * Build a retry-aware syncer.
 *
 * @param {object} [options]
 * @param {(key: string, dest: string) => void} [options.onSuccess]
 *   Fires after every successful syncFile (including hash-skip identical
 *   paths). Use it to record manifest entries from the launcher; bootstrap
 *   ignores it.
 *
 * @returns {{
 *   syncFile: (src: string, dest: string, key: string) => Promise<{ok?: boolean, skipped?: true | 'identical'}>,
 *   failures: Array<{key: string, message: string, src?: string, dest?: string}>,
 *   isCircuitOpen: () => boolean,
 * }}
 */
export function makeSyncer({ onSuccess } = {}) {
  let circuitOpen = false;
  const failures = [];

  async function syncWithRetry(operation) {
    const maxAttempts = circuitOpen ? 1 : RETRY_BACKOFF_MS.length + 1;
    let lastErr = null;
    let lastCode = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1]);
      try {
        operation();
        return { ok: true };
      } catch (err) {
        lastErr = err;
        lastCode = err && err.code ? err.code : null;
        const transient = TRANSIENT_CODES.has(lastCode) || lastCode === 'EVERIFY';
        if (!transient) break;
      }
    }
    if (!circuitOpen && failures.length + 1 >= CIRCUIT_BREAK_THRESHOLD) {
      circuitOpen = true;
    }
    return { ok: false, err: lastErr, code: lastCode };
  }

  async function syncFile(src, dest, key) {
    if (!existsSync(src)) return { skipped: true };
    try {
      mkdirSync(dirname(dest), { recursive: true });
    } catch (err) {
      failures.push({ key, message: errMessage(err), src, dest });
      return { ok: false };
    }
    if (contentEqual(src, dest)) {
      try { onSuccess?.(key, dest); } catch { /* non-fatal */ }
      return { ok: true, skipped: 'identical' };
    }
    const result = await syncWithRetry(() => atomicCopy(src, dest));
    if (result.ok) {
      try { onSuccess?.(key, dest); } catch { /* non-fatal */ }
      return { ok: true };
    }
    const transient = TRANSIENT_CODES.has(result.code) || result.code === 'EVERIFY';
    const tail = transient
      ? ` (retried ${RETRY_BACKOFF_MS.length}× after ${result.code}${circuitOpen ? '; circuit open' : ''})`
      : '';
    failures.push({ key, message: `${errMessage(result.err)}${tail}`, src, dest });
    return { ok: false };
  }

  return {
    syncFile,
    failures,
    isCircuitOpen: () => circuitOpen,
  };
}
