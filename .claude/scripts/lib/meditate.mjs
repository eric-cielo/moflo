/**
 * Auto-meditate (#1198) — pure logic shared by the capture hook
 * (`bin/meditate-capture.mjs`, wired to UserPromptSubmit + Stop) and the distill
 * orchestrator (`bin/meditate-distill.mjs`, fired detached by the session-start
 * launcher).
 *
 * DESIGN (owner-signed-off, #1198): two-stage Recognize → Distill.
 *   - RECOGNIZE happens in the LIVE session. A UserPromptSubmit hook detects a
 *     strong signal (user correction / error→fix / explicit decision) and, on a
 *     hit, injects an answer-first directive asking the model — which has full
 *     context at the moment of insight — to append ONE <meditate-capture> line IF
 *     a durable lesson emerged. A Stop hook scrapes that tag into a JSON ledger.
 *     No moflo.db write, no dedup yet — the ledger is raw, high-quality material.
 *   - DISTILL happens at the NEXT session-start. The launcher fire-and-forgets a
 *     detached process that runs ONE bounded headless Haiku `claude --print`
 *     executing #1187's /meditate distillation over the ledger one-liners —
 *     dedup-search `learnings` (≥0.80 → update same key), store via memory_store
 *     (routes through the daemon = writer-safe). Haiku is a FORMATTER, not a
 *     judge: the durability gate already passed upstream in the live model, so
 *     unattended runs cannot pollute `learnings` with junk.
 *
 * Default-ON (opt out via moflo.yaml `auto_meditate.enabled: false`). Shipped
 * default-on from #1198; the `rc` dist-tag gated the initial rollout. Every
 * entry point still early-returns cheaply when the flag is off OR
 * `CLAUDE_CODE_HEADLESS` is set — the distill's own headless session must never
 * re-enter capture or re-spawn distill (the #860 / infinite-spawn guard).
 *
 * STORAGE: `.moflo/meditate-ledger.json` (single file) + `.moflo/meditate-state.json`
 * (rate-limit). Deliberately NOT under `.moflo/continuity/` — that directory is
 * rotation-managed by #1185 (`rotateDigests` would delete a stray file there).
 *
 * Cross-platform (Rule #1): Node fs/path primitives only; no shell.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { randomBytes } from 'crypto';

// ── Tunables (exported for tests) ───────────────────────────────────────────
/** Model used for the bounded distillation pass (cheap; Haiku is a formatter). */
export const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001';
/** Min gap between in-session capture directives — a debounce so a burst of
 *  signals in quick succession injects the directive at most once per window.
 *  Shorter window = more capture opportunities (and more injected context). */
export const INJECT_WINDOW_MS = 5 * 60_000;
/** Hard cap on directives per session (belt-and-braces over the time window). */
export const INJECT_MAX_PER_SESSION = 10;
/** Ledger size cap — distilled entries are pruned first, then oldest. */
export const MAX_LEDGER_ENTRIES = 200;
/** Keep this many already-distilled entries for idempotency/debug before pruning. */
export const KEEP_DISTILLED = 50;
/** Hard cap on a single captured lesson (defensive against a runaway tag). */
export const MAX_LESSON_CHARS = 320;
/** Bytes of transcript tail the capture hook scans for signals / tags. */
export const TRANSCRIPT_TAIL_BYTES = 32_768;

const LEDGER_FILE = 'meditate-ledger.json';
const STATE_FILE = 'meditate-state.json';

// Pre-rebrand filenames. Before auto-reflect → auto-meditate, the capture
// pipeline wrote `.moflo/reflect-ledger.json` (pending lessons) and
// `.moflo/reflect-state.json` (rate-limit). The new code writes meditate-*.json,
// so on upgrade the old pair is orphaned — never read, never updated. We purge
// rather than migrate: the state file is throwaway rate-limit data, and the
// ledger is drained by the distill pass every session, so the residual is at
// most a handful of undistilled one-liners. Leaving them beside the new files
// just confuses users (#auto-meditate rebrand).
export const LEGACY_STATE_FILES = ['reflect-ledger.json', 'reflect-state.json'];

/**
 * Delete orphaned pre-rebrand reflect-*.json files from `.moflo/`. Idempotent
 * (no-op once they're gone) and tolerant of a concurrent unlink. Returns the
 * names actually removed, so the launcher can log a one-time crumb.
 */
export function purgeLegacyFiles(projectRoot) {
  const removed = [];
  for (const name of LEGACY_STATE_FILES) {
    const p = resolve(projectRoot, '.moflo', name);
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
      removed.push(name);
    } catch {
      /* deleted between stat and unlink, or held open — non-fatal */
    }
  }
  return removed;
}

// ── moflo.yaml config (regex read, matching the launcher's no-js-yaml style) ─

/**
 * Read the `auto_meditate` block from moflo.yaml without a YAML parser. Defaults
 * ON — opt out with `auto_meditate.enabled: false`. (#1198 ships default-on; the
 * `rc` dist-tag gated the initial rollout.) Stays ON on a mid-write/malformed
 * file, consistent with the on default.
 *
 * Back-compat: also honours the legacy `auto_reflect:` key (pre-rebrand) so a
 * consumer's opt-out survives the window between upgrade and the yaml-upgrader
 * renaming the key to `auto_meditate:`.
 *
 * @param {string} projectRoot
 * @returns {{enabled: boolean}}
 */
export function readMeditateConfig(projectRoot) {
  const cfg = { enabled: true };
  try {
    const yamlPath = resolve(projectRoot, 'moflo.yaml');
    if (!existsSync(yamlPath)) return cfg;
    const text = readFileSync(yamlPath, 'utf-8');
    const enabled = text.match(/auto_(?:meditate|reflect):\s*\n(?:\s+\w+:.*\n)*?\s+enabled:\s*(true|false)/);
    if (enabled) cfg.enabled = enabled[1] === 'true';
  } catch {
    // Default ON keeps the feature live if the file is mid-write / malformed.
  }
  return cfg;
}

/** True when running inside a spawned headless Claude (the distill pass, or any
 *  other moflo headless worker). Capture + distill MUST no-op here so the
 *  distill session can't re-enter capture or re-spawn another distill (#860). */
export function isHeadless(env = process.env) {
  return env.CLAUDE_CODE_HEADLESS === 'true' || env.CLAUDE_CODE_HEADLESS === '1';
}

// ── Stage 1: signal detection (pure) ────────────────────────────────────────
//
// Recall over precision by design: the live model's "append nothing" is the
// real precision filter, so a mis-fire just produces no tag (~zero cost). These
// patterns aim to catch the genuine "moment of insight", not to be exhaustive.

const CORRECTION_PATTERNS = [
  /^\s*(no|nope|nah|stop|wait)\b/i,
  /\bthat'?s (not|wrong|incorrect)\b/i,
  /\b(that|this) is (wrong|incorrect|not right)\b/i,
  /\bdo ?n'?t\b/i,
  /\b(actually|instead)\b/i,
  /\bi (said|asked|told you|meant|wanted)\b/i,
  /\byou (were supposed to|should(n'?t)? have|misunderstood|got it wrong)\b/i,
  /\b(revert|undo|roll ?back)\b/i,
  /\bwhy did you\b/i,
  /\bnot what i\b/i,
  /\b(that'?s|this is) not (it|right|correct)\b/i,
];

const DECISION_PATTERNS = [
  /\blet'?s (go with|use|do|stick with)\b/i,
  /\bwe'?ll (go with|use|do)\b/i,
  /\b(decided|decision)\b/i,
  /\bgoing with\b/i,
  /\bthe plan is\b/i,
  /\bthe approach is\b/i,
  /\bwe should (use|go with|do)\b/i,
  /\bi'?ll go with\b/i,
  // Selection / preference / finalization phrasing.
  /\bgo with (option|approach|the|that|a)\b/i,
  /\bi'?d rather\b/i,
  /\b(we'?ll|let'?s) keep\b/i,
  /\bfinal (decision|answer|call)\b/i,
  // Approval ATTACHED to a concrete action/decision — "go ahead and ship the
  // fix", "ok, use the daemon", "proceed with option B". Bare approval alone
  // ("ok"/"yes"/"go ahead"/"sounds good") deliberately does NOT fire: it must
  // carry an action to count as a decision moment, else it would trip on nearly
  // every agreeing turn and burn the per-session injection budget. The live
  // model's "append nothing" remains the final precision filter.
  /\bgo ahead (and|with)\b/i,
  /\bproceed with\b/i,
  /\b(yes|yeah|yep|sure|ok|okay|sounds good|lgtm)[\s,!.]+(go with|use|ship|build|implement|add|proceed)\b/i,
];

// Tight, low-false-positive markers only — tool output mentions "error" benignly
// all the time, so we anchor on structured failure signals, not the bare word.
// `[1-9]\d*` (not `\d+`) so a SUCCESS line like "0 failed" never triggers.
const ERROR_PATTERNS = [
  /"is_error"\s*:\s*true/,
  /\bexit code [1-9]\d*/i,
  /Traceback \(most recent call last\)/,
  /\b[1-9]\d* (failed|failing)\b/i,
];

// Bare approval that, on its own, looks like mere assent ("yes", "ok", "go
// ahead") — but confirms a real decision when the PRIOR assistant turn proposed
// one. Anchored at the start of the user's message so it matches a reply that
// LEADS with approval. Paired with PROPOSAL_PATTERNS below as the precision gate.
const APPROVAL_PATTERNS = [
  /^\s*(y(es|ep|eah|up)?|sure|ok(ay)?|kk?|roger|agreed?|perfect|great|nice|sounds good|lgtm|do it|go ahead|proceed|approved?|let'?s do it|make it so|ship it)\b/i,
];

// Proposal / recommendation / options language the assistant uses when it asks
// the user to choose or approve. Scanned against the recent transcript tail; a
// match here means a bare approval in the prompt is confirming a real decision,
// so "yes" after "I recommend we use the daemon" fires, but "ok thanks" after a
// plain status report does not. Recall-biased — the live model still filters.
const PROPOSAL_PATTERNS = [
  /\bi (propose|recommend|suggest|advise)\b/i,
  /\bi'?(d|ll) (recommend|suggest|propose|go with|use|implement|add|build|refactor)\b/i,
  /\bwe (could|should|can|might) (use|go with|implement|refactor|add|switch|split)\b/i,
  /\b(option|approach|plan|choice) (a|b|c|1|2|3|one|two)\b/i,
  /\b(two|three|several|a few) (options|approaches|choices|ways)\b/i,
  /\bshould i (proceed|go ahead|use|implement|start|continue|create|add)\b/i,
  /\b(would|do) you (like|want) me to\b/i,
  /\bhere'?s (the|my|a) (plan|approach|proposal|recommendation)\b/i,
  /\brecommendation\b/i,
  /\bpropos(e|ed|al)\b/i,
];

function anyMatch(patterns, text) {
  if (!text) return false;
  for (const re of patterns) if (re.test(text)) return true;
  return false;
}

/**
 * Classify the strongest signal in the current turn. `prompt` is the user's
 * message; `transcriptTail` is recent transcript text (for error→fix / decision
 * markers that live in the assistant/tool output).
 *
 * @param {string} prompt
 * @param {string} [transcriptTail]
 * @returns {{hit: boolean, kind: 'correction'|'decision'|'error_fix'|null}}
 */
export function detectSignal(prompt, transcriptTail = '') {
  const p = typeof prompt === 'string' ? prompt : '';
  const t = typeof transcriptTail === 'string' ? transcriptTail : '';
  if (anyMatch(CORRECTION_PATTERNS, p)) return { hit: true, kind: 'correction' };
  if (anyMatch(DECISION_PATTERNS, p) || anyMatch(DECISION_PATTERNS, t)) return { hit: true, kind: 'decision' };
  // Bare approval in the prompt that confirms a proposal/recommendation the
  // assistant made in the immediately prior turn — "yes"/"go ahead" answering
  // "I recommend we use the daemon". The prior-turn proposal (in transcriptTail)
  // is the precision gate: a contextless "ok thanks" with nothing proposed above
  // it does NOT fire.
  if (anyMatch(APPROVAL_PATTERNS, p) && anyMatch(PROPOSAL_PATTERNS, t)) return { hit: true, kind: 'decision' };
  if (anyMatch(ERROR_PATTERNS, t)) return { hit: true, kind: 'error_fix' };
  return { hit: false, kind: null };
}

/**
 * Text of the MOST RECENT turn — everything in the transcript tail after the
 * last user message. The detect hook scopes error/decision detection to this
 * slice so STALE markers from earlier in the session (a test failure 20 turns
 * ago) don't keep re-firing the capture directive. Falls back to the whole tail
 * when no user line is present. Tolerates a truncated leading JSONL line.
 *
 * @param {string} tailText - raw JSONL tail
 * @returns {string}
 */
export function recentTranscriptTurn(tailText) {
  if (typeof tailText !== 'string' || !tailText) return '';
  const lines = tailText.split('\n');
  let lastUserIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const role = obj?.message?.role ?? obj?.role;
    if (role === 'user') lastUserIdx = i;
  }
  return (lastUserIdx >= 0 ? lines.slice(lastUserIdx + 1) : lines).join('\n');
}

// ── Stage 1: the injected directive (DRY with #1187 /meditate) ───────────────

/** The durability bar — single canonical wording shared by the capture
 *  directive AND the distill prompt, mirroring `.claude/skills/meditate/SKILL.md`
 *  Step 2 so the automatic path applies the exact same standard as `/meditate`. */
export const DURABILITY_BAR =
  'A durable lesson would help a FUTURE session on a DIFFERENT task: a reusable ' +
  'pattern ("for X do Y because Z"), a recurring gotcha/trap, or a decision plus ' +
  'the rationale future work must honor. NOT durable: "fixed bug X in file Y" ' +
  '(that is git history), restating an existing rule, or session state.';

const KIND_LABEL = {
  correction: 'course-correction',
  decision: 'decision',
  error_fix: 'error-then-fix',
};

/**
 * Build the answer-first capture directive injected as UserPromptSubmit context.
 * Answer-first so the user's actual request is never degraded; "append nothing"
 * is framed as the correct common outcome so a mis-fire is cheap.
 *
 * @param {'correction'|'decision'|'error_fix'} kind
 * @returns {string}
 */
export function buildCaptureDirective(kind) {
  const label = KIND_LABEL[kind] || 'notable moment';
  return [
    `[auto-meditate] A ${label} just occurred this session.`,
    `FIRST: fully address the user's request as you normally would — do NOT let this note change your answer.`,
    `THEN, if a reusable lesson emerged, append exactly ONE final line of the form:`,
    `<meditate-capture>LESSON</meditate-capture>`,
    `where LESSON is a single concise sentence (a pattern, gotcha, or decision+rationale).`,
    DURABILITY_BAR,
    `When in doubt, capture it — a borderline lesson is cheap and the distill dedups; append nothing only for pure session state or git history. Never emit more than one such line.`,
  ].join('\n');
}

// ── Stage 1: rate-limit state ───────────────────────────────────────────────

function stateFilePath(projectRoot) {
  return resolve(projectRoot, '.moflo', STATE_FILE);
}

/**
 * Decide whether an injection is allowed now, given persisted state. Limits:
 * one directive per INJECT_WINDOW_MS, and at most INJECT_MAX_PER_SESSION per
 * session. A new session id resets the per-session counter.
 *
 * @param {{sessionId?: string|null, lastInjectMs?: number, count?: number}|null} state
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {boolean}
 */
export function injectionAllowed(state, sessionId, now) {
  if (!state || typeof state !== 'object') return true;
  const sameSession = state.sessionId && sessionId && state.sessionId === sessionId;
  if (!sameSession) return true; // fresh session — window + counter reset
  if (typeof state.lastInjectMs === 'number' && now - state.lastInjectMs < INJECT_WINDOW_MS) return false;
  if (typeof state.count === 'number' && state.count >= INJECT_MAX_PER_SESSION) return false;
  return true;
}

/** Read rate-limit state (never throws). */
export function readMeditateState(projectRoot) {
  try {
    return JSON.parse(readFileSync(stateFilePath(projectRoot), 'utf-8'));
  } catch {
    return null;
  }
}

/** Persist rate-limit state after an injection, incrementing the per-session
 *  counter (resets when the session id changes). */
export function recordInjection(projectRoot, sessionId, now, prevState = null) {
  const sameSession = prevState && prevState.sessionId === sessionId;
  const count = sameSession && typeof prevState.count === 'number' ? prevState.count + 1 : 1;
  atomicWriteJson(stateFilePath(projectRoot), { sessionId: sessionId ?? null, lastInjectMs: now, count });
}

// ── Stage 1: <meditate-capture> tag extraction (pure) ────────────────────────

const CAPTURE_TAG_RE = /<meditate-capture>([\s\S]*?)<\/meditate-capture>/gi;
// Drop the directive's own placeholder + non-lessons.
const PLACEHOLDER_RE = /^(lesson|none|n\/?a|nothing)$/i;

/** Extract lesson strings from a block of assistant text. Bounded + de-noised.
 *  Uses matchAll (fresh internal iterator) rather than exec-with-/g so there's
 *  no shared lastIndex state to reset/leak across calls. */
export function extractCaptureTags(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const m of text.matchAll(CAPTURE_TAG_RE)) {
    const lesson = String(m[1] || '').replace(/\s+/g, ' ').trim();
    if (lesson.length < 8) continue;            // empties / fragments
    if (PLACEHOLDER_RE.test(lesson)) continue;  // the directive's "LESSON" placeholder
    out.push(lesson.slice(0, MAX_LESSON_CHARS));
  }
  return out;
}

/**
 * Extract captures from a transcript tail, restricted to ASSISTANT-role
 * messages. This is what keeps the directive's own example tag (which rides in
 * UserPromptSubmit context, not assistant output) from being scraped as a real
 * capture. Tolerates a truncated leading JSONL line.
 *
 * @param {string} tailText - raw JSONL tail
 * @returns {string[]}
 */
export function extractCapturesFromTranscript(tailText) {
  const out = [];
  if (typeof tailText !== 'string' || !tailText) return out;
  for (const line of tailText.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; } // partial / non-JSON line
    const role = obj?.message?.role ?? obj?.role;
    if (role !== 'assistant') continue;
    let content = obj?.message?.content ?? obj?.content;
    if (Array.isArray(content)) {
      content = content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
    }
    if (typeof content !== 'string') continue;
    for (const lesson of extractCaptureTags(content)) out.push(lesson);
  }
  return out;
}

// ── Ledger (.moflo/meditate-ledger.json) ─────────────────────────────────────

function ledgerFilePath(projectRoot) {
  return resolve(projectRoot, '.moflo', LEDGER_FILE);
}

/** Atomic temp+rename JSON write (crash-safe; a half-write never lands). */
function atomicWriteJson(dest, obj) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
  renameSync(tmp, dest);
}

/** Read the ledger (never throws; returns an empty ledger on absence/malformed). */
export function readLedger(projectRoot) {
  try {
    const obj = JSON.parse(readFileSync(ledgerFilePath(projectRoot), 'utf-8'));
    if (obj && Array.isArray(obj.entries)) return obj;
  } catch {
    // absent or mid-write — start fresh
  }
  return { entries: [] };
}

/** Entries not yet distilled, oldest first. */
export function pendingEntries(ledger) {
  const entries = ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
  return entries.filter((e) => e && !e.distilled && typeof e.lesson === 'string');
}

function normalizeLesson(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Cap ledger size — drop distilled entries first (keep KEEP_DISTILLED newest),
 *  then oldest pending if still over cap. Pure; returns a new entries array.
 *  Membership is keyed by entry id (a Set), not object reference, so the cap
 *  stays correct even if entries are ever cloned (e.g. a JSON round-trip). */
function capEntries(entries) {
  if (entries.length <= MAX_LEDGER_ENTRIES) return entries;
  const distilled = entries.filter((e) => e.distilled);
  // Keep the newest KEEP_DISTILLED distilled, preserving order.
  const keptDistilledIds = new Set(
    (distilled.length > KEEP_DISTILLED ? distilled.slice(distilled.length - KEEP_DISTILLED) : distilled)
      .map((e) => e.id),
  );
  let merged = entries.filter((e) => (e.distilled ? keptDistilledIds.has(e.id) : true));
  if (merged.length > MAX_LEDGER_ENTRIES) {
    // Still over — drop oldest pending (front of array).
    const overflow = merged.length - MAX_LEDGER_ENTRIES;
    let dropped = 0;
    merged = merged.filter((e) => {
      if (dropped < overflow && !e.distilled) { dropped++; return false; }
      return true;
    });
  }
  return merged;
}

/**
 * Append new captures to the ledger, skipping ones whose lesson already exists
 * (normalized) — the Stop scrape re-reads an overlapping tail each turn, so
 * dedup-on-append prevents the same lesson landing twice. Dedup is best-effort
 * (read-then-write, not a transaction): correct because Claude Code serialises a
 * session's Stop hooks, so there is no concurrent writer to race against. The
 * distill's separate semantic dedup (≥0.80) is the real backstop.
 *
 * @param {string} projectRoot
 * @param {Array<{lesson: string, kind?: string, sessionId?: string|null}>} captures
 * @param {number} [now]
 * @returns {number} count actually appended
 */
export function appendLedgerEntries(projectRoot, captures, now = Date.now()) {
  const list = Array.isArray(captures) ? captures : [];
  if (list.length === 0) return 0;
  const ledger = readLedger(projectRoot);
  const seen = new Set(ledger.entries.map((e) => normalizeLesson(e.lesson)));
  let appended = 0;
  for (const c of list) {
    const lesson = String(c?.lesson || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LESSON_CHARS);
    if (lesson.length < 8) continue;
    const norm = normalizeLesson(lesson);
    if (seen.has(norm)) continue;
    seen.add(norm);
    ledger.entries.push({
      id: `${now.toString(36)}-${randomBytes(3).toString('hex')}`,
      lesson,
      kind: c?.kind || null,
      sessionId: c?.sessionId ?? null,
      capturedAt: now,
      distilled: false,
    });
    appended++;
  }
  if (appended === 0) return 0;
  ledger.entries = capEntries(ledger.entries);
  atomicWriteJson(ledgerFilePath(projectRoot), ledger);
  return appended;
}

/**
 * Mark the given entry ids distilled. New captures that arrived during the
 * distill run keep `distilled:false` and survive for the next pass.
 *
 * @param {string} projectRoot
 * @param {string[]} ids
 * @returns {number} count marked
 */
export function markLedgerDistilled(projectRoot, ids) {
  const idSet = new Set(Array.isArray(ids) ? ids : []);
  if (idSet.size === 0) return 0;
  const ledger = readLedger(projectRoot);
  let marked = 0;
  for (const e of ledger.entries) {
    if (e && idSet.has(e.id) && !e.distilled) { e.distilled = true; marked++; }
  }
  if (marked === 0) return 0;
  ledger.entries = capEntries(ledger.entries);
  atomicWriteJson(ledgerFilePath(projectRoot), ledger);
  return marked;
}

// ── Stage 2: distill prompt (DRY with #1187 /meditate) ───────────────────────

/**
 * Build the bounded headless-Haiku distillation prompt over the pending ledger
 * entries. Reuses the `/meditate` protocol (search → dedup ≥0.80 → store) rather
 * than forking it, and instructs writes through the MCP memory tools so they
 * route via the daemon single-writer chokepoint (#981) — writer-safe.
 *
 * @param {Array<{lesson: string}>} entries
 * @returns {string}
 */
export function buildDistillPrompt(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.lesson);
  const numbered = list.map((e, i) => `${i + 1}. ${e.lesson}`).join('\n');
  return [
    `You are running moflo's automatic /meditate distillation (#1198) headlessly. Below are raw candidate lessons captured during a recent session — one per line. Persist the durable keepers to long-term memory, deduped. Be terse; do not write files.`,
    ``,
    `Candidates:`,
    numbered,
    ``,
    `Procedure — reuse the /meditate protocol, do not invent a new one:`,
    `1. For EACH candidate, call mcp__moflo__memory_search { namespace: "learnings", query: <bare keywords>, threshold: 0.6, limit: 5 }.`,
    `2. If the top hit is the SAME fact at similarity >= 0.80, call mcp__moflo__memory_store with that SAME key (upsert), merging any new nuance — do NOT create a near-duplicate.`,
    `3. Otherwise call mcp__moflo__memory_store { namespace: "learnings", key: <stable descriptive slug>, value: "<lesson> — Why: <why it matters>. How to apply: <what to do next time>.", tags: [<topic>, <area>] }.`,
    `   PROVENANCE (#1203): every memory_store you make — both the step-2 upsert and the step-3 new write — MUST include the tag "source:auto-meditate" in its tags array, so the Luminarium "Learnings" panel can attribute these to the automatic distill pass.`,
    `4. Skip any candidate that does not clear the durability bar below, or that merely restates an existing entry.`,
    ``,
    DURABILITY_BAR,
    ``,
    `When finished, output one line only: "distilled <new>, updated <merged>, skipped <n>".`,
  ].join('\n');
}
