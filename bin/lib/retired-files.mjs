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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createHash } from 'crypto';

/**
 * Consumer-relative path of the retained-files record written by
 * `writeRetainedRecord`. Exported so tests and `flo healer` resolve the same
 * location instead of re-deriving the string.
 */
export const RETAINED_RECORD_REL = join('.moflo', 'retired-retained.json');

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
 *   - 'shipped'    — the installed package STILL ships this path, so the
 *                    manifest entry contradicts the package; skip it entirely
 *   - 'absent'     — path doesn't exist on disk; nothing to do
 *   - 'prune'      — file exists and content hash matches a known-shipped
 *                    value; safe to delete (consumer didn't customize)
 *   - 'preserve'   — file exists but content differs from every known-shipped
 *                    hash; consumer customized, leave alone
 *   - 'unknown'    — file exists but its hash couldn't be read (transient
 *                    error); leave alone, retry next session
 *
 * The `shipped` check exists because a path can be retired and later RESTORED
 * under the same name (#1414). The stale entry then holds only pre-deletion
 * hashes, so the consumer's copy — which moflo itself just synced from the
 * package — matches nothing and is reported as a customized retired file every
 * session. Asking the package what it ships is the only source that cannot
 * drift from the manifest, so it wins.
 *
 * `packageRoot` is optional and defaults to no cross-check: callers that don't
 * know where the package lives keep exactly the pre-#1414 semantics.
 *
 * Order matters. The consumer-path check runs FIRST because most entries are
 * `absent` on a typical install (already pruned, or never had the file), and
 * those need no package stat at all — this runs on every consumer's session
 * start, where a doubled stat count is 10-40ms on Windows with a scanner or a
 * network `node_modules`. Entries that are absent locally are also exactly the
 * ones a contradiction cannot hurt: there is nothing to delete or report.
 *
 * @param {string} projectRoot
 * @param {{path:string, knownContentHashes:string[]}} entry
 * @param {string|null} [packageRoot] - root of the installed moflo package
 * @returns {{ action: 'shipped'|'absent'|'prune'|'preserve'|'unknown', actualHash: string|null }}
 */
export function classifyRetiredFile(projectRoot, entry, packageRoot = null) {
  const abs = resolve(projectRoot, entry.path);
  if (!existsSync(abs)) return { action: 'absent', actualHash: null };
  if (packageRoot && existsSync(resolve(packageRoot, entry.path))) {
    return { action: 'shipped', actualHash: null };
  }
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
 * `preserved` is the flat path list the launcher banner samples from;
 * `preservedDetails` carries the same set with the manifest's retirement
 * provenance attached, for the machine-readable record (#1307 finding 3).
 *
 * `shipped` collects entries the installed package still ships (#1414). They
 * are neither pruned nor preserved — the manifest is simply wrong about them,
 * and reporting them as retained is what produced the false banner. Nothing
 * reads it today; it is here so the return value is a complete accounting of
 * every entry's disposition rather than silently dropping one class, and so
 * tests can assert the skip happened instead of inferring it from an absence.
 *
 * @param {string} projectRoot
 * @param {string} manifestPath
 * @param {string|null} [packageRoot] - root of the installed moflo package
 * @returns {{ pruned: string[], preserved: string[], preservedDetails: Array<{path:string, retiredIn?:string, retiredBy?:string}>, shipped: string[], unknown: string[], failed: Array<{path:string, message:string}> }}
 */
export function applyRetiredPrune(projectRoot, manifestPath, packageRoot = null) {
  const { entries } = loadRetiredManifest(manifestPath);
  const report = { pruned: [], preserved: [], preservedDetails: [], shipped: [], unknown: [], failed: [] };
  for (const entry of entries) {
    const { action } = classifyRetiredFile(projectRoot, entry, packageRoot);
    if (action === 'shipped') { report.shipped.push(entry.path); continue; }
    if (action === 'absent') continue;
    if (action === 'preserve') {
      report.preserved.push(entry.path);
      report.preservedDetails.push({
        path: entry.path,
        ...(entry.retiredIn ? { retiredIn: entry.retiredIn } : {}),
        ...(entry.retiredBy ? { retiredBy: entry.retiredBy } : {}),
      });
      continue;
    }
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

/**
 * Reconcile an existing retained record against what is actually on disk.
 *
 * `writeRetainedRecord` only runs inside the launcher's UPGRADE branch (that
 * is where `applyRetiredPrune` lives), so on its own it cannot keep the record
 * honest: a user who reads the record and deletes the files would keep a
 * record naming those files until their next moflo upgrade — the record would
 * outlive what it describes, which is the same "not actionable" complaint
 * #1307 raised about the truncated banner.
 *
 * This runs on EVERY session start instead, and is written to cost nothing in
 * the common case: one `existsSync` when no record is present (overwhelmingly
 * the norm), and only then a stat per retained entry.
 *
 * Never throws — advisory bookkeeping must not break session start.
 *
 * @param {string} projectRoot
 * @returns {{ changed: boolean, removed: string[], remaining: number }}
 */
export function reconcileRetainedRecord(projectRoot) {
  const result = { changed: false, removed: [], remaining: 0 };
  const abs = resolve(projectRoot, RETAINED_RECORD_REL);
  try {
    if (!existsSync(abs)) return result;               // fast path — no record
    // Corrupt/hand-edited record: drop it rather than reason about it. Parsed
    // in its own try so a JSON error lands here and the bad file is actually
    // removed, instead of falling to the outer catch and lingering forever.
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf-8'));
    } catch { /* handled below */ }
    if (!parsed || !Array.isArray(parsed.retained)) {
      unlinkSync(abs);
      result.changed = true;
      return result;
    }
    const stillPresent = [];
    for (const entry of parsed.retained) {
      if (entry && typeof entry.path === 'string' && existsSync(resolve(projectRoot, entry.path))) {
        stillPresent.push(entry);
      } else if (entry && typeof entry.path === 'string') {
        result.removed.push(entry.path);
      }
    }
    result.remaining = stillPresent.length;
    if (result.removed.length === 0) return result;    // nothing to do
    result.changed = true;
    if (stillPresent.length === 0) {
      unlinkSync(abs);
      return result;
    }
    writeFileSync(abs, JSON.stringify({ ...parsed, retained: stillPresent }, null, 2) + '\n', 'utf-8');
    return result;
  } catch {
    return result;
  }
}

/**
 * Persist the retained (customized-and-therefore-preserved) retired files to
 * `.moflo/retired-retained.json` (#1307 finding 3).
 *
 * Before this, the only place the retained set appeared was a launcher stdout
 * banner truncated to 5 entries — so "delete manually if unwanted" was not
 * actionable for the remainder, and nothing on disk let you reconstruct the
 * set (`installed-files.json` doesn't track pre-#948 agents/skills).
 *
 * The record is advisory state, not a manifest: it is rewritten from scratch
 * on every launcher run, and deleted when nothing is retained so a stale file
 * never claims paths the consumer has since removed.
 *
 * Never throws — a failure to write an advisory record must not break session
 * start on any consumer. Returns the absolute path written, or null.
 *
 * @param {string} projectRoot
 * @param {Array<{path:string, retiredIn?:string, retiredBy?:string}>} preservedDetails
 * @param {string} [mofloVersion] - version that produced this record, if known
 * @returns {string|null} absolute path written, or null if nothing was written
 */
export function writeRetainedRecord(projectRoot, preservedDetails, mofloVersion) {
  const abs = resolve(projectRoot, RETAINED_RECORD_REL);
  try {
    if (!Array.isArray(preservedDetails) || preservedDetails.length === 0) {
      // Nothing retained — drop any record from a previous run.
      if (existsSync(abs)) unlinkSync(abs);
      return null;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const payload = {
      version: 1,
      note: 'Retired moflo files preserved because they were customized locally. Safe to delete manually if unwanted; moflo will not remove them.',
      ...(mofloVersion ? { mofloVersion } : {}),
      retained: preservedDetails,
    };
    writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    return abs;
  } catch {
    return null;
  }
}
