/**
 * Passive session-continuity — pure logic + store helpers shared by the capture
 * orchestrator (`bin/session-continuity.mjs`, wired to the Stop hook) and the
 * injection path (`bin/session-start-launcher.mjs`). See issue #1185.
 *
 * DESIGN (owner-signed-off):
 *   - CAPTURE is default-on, silent, mechanical-first (no model call): assemble a
 *     digest from data we already have — git state, recent `learnings`, the
 *     session goal — scrub secrets, persist one record per session.
 *   - INJECTION is default-on but RELEVANCE-GATED: at session-start we score
 *     recent digests and inject only the single best one IF it clears a
 *     threshold (same branch / file overlap / recency / unfinished work). A
 *     fresh, unrelated session injects nothing — that's what keeps the feature
 *     from going context-negative.
 *   - The injected block stores only NON-RECONSTRUCTABLE context (goal,
 *     decisions, where-you-stopped) and is framed as a verifiable lead, never
 *     ground truth — git/tests are the source of truth the next session checks.
 *
 * STORAGE: a dedicated `.moflo/continuity/` JSON store, NOT `.moflo/moflo.db`.
 * Capture fires on the Stop hook while the daemon is live; the moflo.db writer
 * audit (docs/internal/1054-writer-audit.md) requires cross-process DB writers
 * to route through the daemon chokepoint. A separate JSON store sidesteps that
 * entirely — these digests are operational state, not semantic memory, carry no
 * embeddings, and never belong in the HNSW index. One file per session avoids
 * concurrent-write conflicts between simultaneous sessions.
 *
 * Cross-platform (Rule #1): `spawnSync` with arg arrays (no shell, no
 * `2>/dev/null`), forward-slash path compares (git porcelain emits `/` on every
 * OS), Node fs/path primitives only.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { randomBytes } from 'crypto';

// ── Relevance-scoring tunables (exported for tests) ─────────────────────────
export const MAINLINE_BRANCHES = ['main', 'master', 'develop', 'trunk'];
export const SCORE = Object.freeze({
  BRANCH_MATCH: 0.5,           // feature branch identity is a strong continuation signal
  MAINLINE_BRANCH_MATCH: 0.25, // main/master is weak — everyone's always "on main"
  FILE_OVERLAP_PER_FILE: 0.1,
  FILE_OVERLAP_MAX: 0.3,
  RECENCY_MAX: 0.2,
  RECENCY_HALFLIFE_HOURS: 24,
  UNFINISHED_BONUS: 0.15,
  INJECT_THRESHOLD: 0.5,
});
export const DEFAULT_MAX_AGE_HOURS = 72;
/** Hard cap on the injected block (~250 tokens). Bounds context cost even when
 *  a digest does fire. */
export const INJECT_MAX_CHARS = 1000;
/** Rotation: keep the most recent N sessions' digests. */
export const KEEP_DIGESTS = 30;

// ── Store helpers (.moflo/continuity/) ──────────────────────────────────────

export function continuityDir(projectRoot) {
  return resolve(projectRoot, '.moflo', 'continuity');
}

/** Stable, filesystem-safe filename for a session's digest record. */
export function digestFileName(key) {
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return `${safe || 'session'}.json`;
}

/**
 * Persist a digest record atomically (temp + rename) so a crash mid-write can
 * never leave a half-written file the injection path would choke on.
 *
 * @param {string} projectRoot
 * @param {string} key - stable per-session key
 * @param {{content: string, metadata: object}} record
 */
export function writeDigest(projectRoot, key, record) {
  const dir = continuityDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, digestFileName(key));
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), 'utf-8');
  renameSync(tmp, dest);
}

/**
 * Read recent digest records, newest first, capped to `limit`. Tolerates a
 * partially-written / malformed file (skips it) — never throws.
 *
 * @param {string} projectRoot
 * @param {{limit?: number}} [opts]
 * @returns {Array<{content: string, metadata: object}>}
 */
export function readDigests(projectRoot, opts = {}) {
  const limit = opts.limit ?? KEEP_DIGESTS;
  const dir = continuityDir(projectRoot);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no store yet
  }
  const withTime = files.map((f) => ({ f, mtime: fileMtime(join(dir, f)) }));
  withTime.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { f } of withTime.slice(0, limit)) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (rec && typeof rec.content === 'string') out.push(rec);
    } catch { /* skip malformed / mid-write */ }
  }
  return out;
}

/** Delete the oldest digest files beyond `keep` (housekeeping; never fatal). */
export function rotateDigests(projectRoot, keep = KEEP_DIGESTS) {
  const dir = continuityDir(projectRoot);
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  if (names.length <= keep) return; // common case — no per-file stat sweep needed
  const entries = names.map((f) => ({ f, mtime: fileMtime(join(dir, f)) }));
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const { f } of entries.slice(keep)) {
    try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
  }
}

// ── moflo.yaml config (regex read, matching the launcher's no-js-yaml style) ─

/**
 * Read the `session_continuity` block from moflo.yaml without a YAML parser
 * (the launcher and bin scripts avoid the js-yaml dependency for speed). Both
 * flags default ON; injection is still relevance-gated at runtime.
 *
 * @param {string} projectRoot
 * @returns {{capture: boolean, inject: boolean, maxAgeHours: number}}
 */
export function readContinuityConfig(projectRoot) {
  const cfg = { capture: true, inject: true, maxAgeHours: DEFAULT_MAX_AGE_HOURS };
  try {
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    if (!existsSync(yamlPath)) return cfg;
    const text = readFileSync(yamlPath, 'utf-8');
    const capture = text.match(/session_continuity:\s*\n(?:\s+\w+:.*\n)*?\s+capture:\s*(true|false)/);
    const inject = text.match(/session_continuity:\s*\n(?:\s+\w+:.*\n)*?\s+inject:\s*(true|false)/);
    const maxAge = text.match(/session_continuity:\s*\n(?:\s+\w+:.*\n)*?\s+max_age_hours:\s*(\d+)/);
    if (capture) cfg.capture = capture[1] === 'true';
    if (inject) cfg.inject = inject[1] === 'true';
    if (maxAge) cfg.maxAgeHours = Math.max(1, parseInt(maxAge[1], 10));
  } catch {
    // Defaults (on) keep the feature alive if the file is mid-write / malformed.
  }
  return cfg;
}

// ── Git state (cross-platform, no shell) ────────────────────────────────────

function git(projectRoot, args) {
  try {
    const r = spawnSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Current branch, changed-file paths, last-commit subject and uncommitted count.
 * Returns null-ish fields rather than throwing in a non-git directory.
 *
 * @param {string} projectRoot
 * @returns {{branch: string|null, changedFiles: string[], lastCommit: string|null, uncommittedCount: number}}
 */
export function readGitState(projectRoot) {
  const branchRaw = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = null;
  if (branchRaw === 'HEAD') branch = 'detached'; // detached HEAD checkout
  else if (branchRaw) branch = branchRaw;        // null when not a git repo
  const status = git(projectRoot, ['status', '--porcelain']);
  const changedFiles = status
    ? status
        .split('\n')
        .map((l) => l.slice(3).trim()) // strip the 2-char XY status + space
        .filter(Boolean)
        .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p)) // renames
        .slice(0, 50)
    : [];
  const lastCommit = git(projectRoot, ['log', '-1', '--pretty=%s']) || null;
  return { branch, changedFiles, lastCommit, uncommittedCount: changedFiles.length };
}

// ── Opt-out ─────────────────────────────────────────────────────────────────

/** Honor a `<private>` opt-out tag anywhere in the supplied text (e.g. the
 *  recent transcript). Case-insensitive. */
export function hasPrivateOptOut(text) {
  return typeof text === 'string' && /<private>/i.test(text);
}

// ── Digest assembly (pure) ──────────────────────────────────────────────────

/** statSync mtime that never throws (file may vanish between readdir and stat). */
function fileMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

function trimList(items, max) {
  return (Array.isArray(items) ? items : []).map((s) => String(s).trim()).filter(Boolean).slice(0, max);
}

/**
 * Build the digest CONTENT — only non-reconstructable context. Git facts appear
 * as a single "stopped at" anchor line, not as the payload (the next session can
 * re-derive git state for free; it can't re-derive intent or rejected options).
 *
 * @param {{goal?: string, decisions?: string[], openThreads?: string[],
 *          gitState?: {branch?: string|null, lastCommit?: string|null, uncommittedCount?: number}}} parts
 * @returns {string} markdown (may be empty if nothing substantive was captured)
 */
export function assembleDigestContent(parts = {}) {
  const lines = [];
  const goal = parts.goal && String(parts.goal).trim();
  if (goal) lines.push(`**Goal:** ${goal}`);

  const decisions = trimList(parts.decisions, 5);
  if (decisions.length) lines.push(`**Decisions this session:** ${decisions.join('; ')}`);

  const threads = trimList(parts.openThreads, 5);
  if (threads.length) lines.push(`**Open threads:** ${threads.join('; ')}`);

  const g = parts.gitState || {};
  if (g.branch) {
    const bits = [`on \`${g.branch}\``];
    if (g.lastCommit) bits.push(`last commit: "${g.lastCommit}"`);
    if (g.uncommittedCount) bits.push(`${g.uncommittedCount} uncommitted file(s)`);
    lines.push(`**Stopped at:** ${bits.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Metadata persisted alongside the digest — the scoring signals (never shown).
 *
 * @returns {{branch: string|null, changedFiles: string[], endedAt: number,
 *            sessionId: string|null, hadUnfinished: boolean}}
 */
export function buildDigestMetadata({ gitState = {}, sessionId = null, openThreads = [], endedAt = Date.now() } = {}) {
  const uncommitted = Number(gitState.uncommittedCount || 0);
  return {
    branch: gitState.branch ?? null,
    changedFiles: Array.isArray(gitState.changedFiles) ? gitState.changedFiles.slice(0, 50) : [],
    endedAt,
    sessionId: sessionId ?? null,
    hadUnfinished: uncommitted > 0 || (Array.isArray(openThreads) && openThreads.length > 0),
  };
}

// ── Relevance scoring + selection (pure) ────────────────────────────────────

function metaOf(row) {
  if (!row) return {};
  const raw = row.metadata;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

function overlapCount(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  let n = 0;
  for (const x of b) if (set.has(x)) n++;
  return n;
}

/**
 * Score how relevant a stored digest is to the session starting now. Higher =
 * more likely a continuation. Returns 0 for digests older than maxAgeHours.
 *
 * @param {object} meta - parsed digest metadata (branch, changedFiles, endedAt, hadUnfinished)
 * @param {{branch: string|null, changedFiles: string[]}} ctx - current session context
 * @param {{now?: number, maxAgeHours?: number}} [opts]
 * @returns {number}
 */
export function scoreDigest(meta, ctx, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const endedAt = Number(meta?.endedAt || 0);
  if (!endedAt) return 0;
  // Clamp small negative ages (clock skew / NTP step between capture and this
  // start) to 0 = most-recent, rather than silently dropping a fresh digest.
  const ageHours = Math.max(0, (now - endedAt) / 3_600_000);
  if (ageHours > maxAgeHours) return 0;

  let score = 0;
  if (meta.branch && ctx.branch && meta.branch === ctx.branch) {
    score += MAINLINE_BRANCHES.includes(meta.branch) ? SCORE.MAINLINE_BRANCH_MATCH : SCORE.BRANCH_MATCH;
  }
  const overlap = overlapCount(meta.changedFiles, ctx.changedFiles);
  if (overlap > 0) score += Math.min(SCORE.FILE_OVERLAP_MAX, overlap * SCORE.FILE_OVERLAP_PER_FILE);
  score += SCORE.RECENCY_MAX * Math.exp(-ageHours / SCORE.RECENCY_HALFLIFE_HOURS);
  if (meta.hadUnfinished) score += SCORE.UNFINISHED_BONUS;
  return score;
}

/**
 * Pick the single most relevant digest to inject, or null if none clear the
 * threshold. Skips the row matching `excludeSessionId` (don't replay the very
 * session that just started, if it somehow already wrote a record).
 *
 * @param {Array<{content: string, metadata: any}>} rows
 * @param {{branch: string|null, changedFiles: string[]}} ctx
 * @param {{now?: number, maxAgeHours?: number, excludeSessionId?: string|null}} [opts]
 * @returns {{row: object, meta: object, score: number}|null}
 */
export function selectBestDigest(rows, ctx, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = null;
  for (const row of rows) {
    const meta = metaOf(row);
    if (opts.excludeSessionId && meta.sessionId && meta.sessionId === opts.excludeSessionId) continue;
    if (!row.content || !String(row.content).trim()) continue;
    const score = scoreDigest(meta, ctx, opts);
    if (score >= SCORE.INJECT_THRESHOLD && (!best || score > best.score)) {
      best = { row, meta, score };
    }
  }
  return best;
}

// ── Injection formatting (pure) ─────────────────────────────────────────────

/** Humanise an elapsed-millis duration into a short phrase. */
export function relativeTime(endedAt, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - endedAt) / 60_000));
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Format the selected digest as the SessionStart injection block — framed as a
 * verifiable lead (not ground truth) and hard-capped at INJECT_MAX_CHARS.
 *
 * @param {{row: {content: string}, meta: {endedAt?: number}}} selection
 * @param {number} [now]
 * @returns {string}
 */
export function formatInjection(selection, now = Date.now()) {
  const content = String(selection?.row?.content || '').trim();
  if (!content) return '';
  const when = selection?.meta?.endedAt ? relativeTime(selection.meta.endedAt, now) : 'recently';
  const header = `📌 Where you left off (${when}) — verify current state before continuing:`;
  const budget = INJECT_MAX_CHARS - header.length - 2;
  if (budget <= 0) return header; // header alone already at the cap (defensive)
  let body = content;
  if (body.length > budget) body = body.slice(0, budget - 1).trimEnd() + '…';
  return `${header}\n${body}`;
}
