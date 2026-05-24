/**
 * Retired-shipped-files prune helper (#948).
 *
 * Closes the gap that retired agents (#932) and retired skills (#945) leave
 * in consumer projects: the manifest cleanup at section 3 of the launcher
 * only knows about files moflo previously synced, but `.claude/agents/` and
 * `.claude/skills/` were not in the manifest before #948. So files retired
 * before #948 lands stay on disk forever — Claude Code keeps loading them as
 * subagents on every prompt, paying the per-prompt roster tokens we just
 * spent #932 fixing.
 *
 * This module reads `retired-files.json` (shipped at the moflo package
 * root) and, for each entry, only prunes the consumer-side path when the
 * file's sha256 matches one of `knownContentHashes` — i.e. the file matches
 * a version moflo actually shipped, so the consumer didn't customize it.
 * Customized files are preserved and a one-line notice is emitted so the
 * user can act.
 *
 * Manifest format:
 *
 *   {
 *     "version": 1,
 *     "retired": [
 *       {
 *         "path": ".claude/agents/v3/performance-engineer.md",
 *         "retiredIn": "4.9.22",
 *         "retiredBy": "#932",
 *         "knownContentHashes": ["sha256:abc...", "sha256:def..."]
 *       }
 *     ]
 *   }
 *
 * @module bin/lib/retired-files
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

/**
 * Compute sha256 of file content. Returns null on read errors so the caller
 * can decide what to do — we never want a transient stat/read failure to
 * trigger a prune of a file we couldn't actually verify.
 *
 * @param {string} absPath
 * @returns {string|null} `sha256:<hex>` or null
 */
export function fileSha256(absPath) {
  try {
    const buf = readFileSync(absPath);
    return 'sha256:' + createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compute sha256 of file content with line endings normalized to LF.
 *
 * moflo ships every text asset with LF endings, so `knownContentHashes` are LF
 * hashes. But Windows consumers routinely end up with CRLF copies (git
 * `core.autocrlf=true` on checkout, editors rewriting on save). A raw-byte hash
 * of a CRLF file never matches the LF manifest hash, so the hash-gated prune
 * would silently never fire on Windows — defeating the whole #948/#932 cleanup
 * for the platform where it's needed most. Normalizing CRLF (and lone CR) to LF
 * before hashing recovers those files. This is a Rule #1 (cross-platform)
 * requirement, not an optimization.
 *
 * latin1 round-trips bytes 1:1 (no UTF-8 multibyte corruption) so the digest is
 * byte-identical to hashing a genuinely-LF file.
 *
 * @param {string} absPath
 * @returns {string|null} `sha256:<hex>` of the LF-normalized content, or null
 */
export function fileSha256NormalizedEol(absPath) {
  try {
    const buf = readFileSync(absPath);
    const normalized = buf.toString('latin1').replace(/\r\n?/g, '\n');
    return 'sha256:' + createHash('sha256').update(normalized, 'latin1').digest('hex');
  } catch {
    return null;
  }
}

/**
 * Load + validate the retired-files manifest. Returns `{ entries: [] }` for
 * any failure mode (missing file, invalid JSON, wrong shape) — the launcher
 * must never block on a corrupt manifest.
 *
 * @param {string} manifestPath - absolute path to retired-files.json
 * @returns {{ entries: Array<{path:string, retiredIn?:string, retiredBy?:string, knownContentHashes:string[]}> }}
 */
export function loadRetiredManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { entries: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch { return { entries: [] }; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.retired)) {
    return { entries: [] };
  }
  // Filter out malformed entries — guards against a hand-edited file
  // dropping the wrong shape into a launcher that runs on N consumer
  // machines. A skipped entry never auto-prunes (safest default).
  const entries = parsed.retired.filter((entry) =>
    entry &&
    typeof entry.path === 'string' &&
    entry.path.length > 0 &&
    Array.isArray(entry.knownContentHashes) &&
    entry.knownContentHashes.length > 0 &&
    entry.knownContentHashes.every((h) => typeof h === 'string' && h.startsWith('sha256:'))
  );
  return { entries };
}

/**
 * Decide what to do with a consumer-side path against a retirement entry:
 *
 *   - 'absent'     — path doesn't exist on disk; nothing to do
 *   - 'prune'      — file exists and content hash matches a known-shipped
 *                    value; safe to delete (consumer didn't customize)
 *   - 'preserve'   — file exists but content differs from every known-shipped
 *                    hash; consumer customized, leave alone
 *   - 'unknown'    — file exists but its hash couldn't be read (transient
 *                    error); leave alone, retry next session
 *
 * @param {string} projectRoot
 * @param {{path:string, knownContentHashes:string[]}} entry
 * @returns {{ action: 'absent'|'prune'|'preserve'|'unknown', actualHash: string|null }}
 */
export function classifyRetiredFile(projectRoot, entry) {
  const abs = resolve(projectRoot, entry.path);
  if (!existsSync(abs)) return { action: 'absent', actualHash: null };
  const actualHash = fileSha256(abs);
  if (!actualHash) return { action: 'unknown', actualHash: null };
  if (entry.knownContentHashes.includes(actualHash)) {
    return { action: 'prune', actualHash };
  }
  // Raw bytes didn't match. Retry with LF-normalized content: a Windows
  // consumer's CRLF copy of a known-shipped (LF) file must still be recognized
  // as un-customized and pruned. Without this the prune never fires on Windows
  // (Rule #1 cross-platform). `actualHash` stays the raw on-disk hash so the
  // report reflects what's actually on disk.
  const normalizedHash = fileSha256NormalizedEol(abs);
  if (normalizedHash && entry.knownContentHashes.includes(normalizedHash)) {
    return { action: 'prune', actualHash };
  }
  return { action: 'preserve', actualHash };
}

/**
 * Walk the manifest and apply prune decisions. Returns a small report so
 * the caller can emit one summary line (the launcher pattern) instead of
 * forcing it to track per-entry state.
 *
 * Failures are non-fatal — a single un-deletable file (Windows AV hold,
 * EBUSY) must not stop pruning the rest. The caller surfaces the report.
 *
 * @param {string} projectRoot
 * @param {string} manifestPath
 * @returns {{ pruned: string[], preserved: string[], unknown: string[], failed: Array<{path:string, message:string}> }}
 */
export function applyRetiredPrune(projectRoot, manifestPath) {
  const { entries } = loadRetiredManifest(manifestPath);
  const report = { pruned: [], preserved: [], unknown: [], failed: [] };
  for (const entry of entries) {
    const { action } = classifyRetiredFile(projectRoot, entry);
    if (action === 'absent') continue;
    if (action === 'preserve') { report.preserved.push(entry.path); continue; }
    if (action === 'unknown') { report.unknown.push(entry.path); continue; }
    // action === 'prune'
    try {
      unlinkSync(resolve(projectRoot, entry.path));
      report.pruned.push(entry.path);
    } catch (err) {
      report.failed.push({
        path: entry.path,
        message: err && err.message ? err.message : String(err),
      });
    }
  }
  return report;
}
