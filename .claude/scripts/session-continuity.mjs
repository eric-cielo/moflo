#!/usr/bin/env node
/**
 * Passive session-continuity CAPTURE (#1185).
 *
 * Wired to Claude Code's Stop hook (fires at the end of each assistant turn).
 * On each fire it assembles a compact "where you left off" digest from data
 * moflo already has — git state, recent `learnings`, the session goal — scrubs
 * any secrets, and writes ONE record per session into the `.moflo/continuity/`
 * JSON store. The matching injection runs at session-start inside
 * session-start-launcher.mjs.
 *
 * Why a JSON store and not moflo.db: capture fires while the daemon is live, and
 * the moflo.db writer audit requires cross-process DB writers to route through
 * the daemon chokepoint. A dedicated JSON store sidesteps that — these digests
 * are operational state, not semantic memory. We still READ moflo.db read-only
 * for recent learnings (safe under WAL; reads never clobber).
 *
 * Why Stop (per-turn) and not only a clean SessionEnd: capturing on every turn
 * makes the digest crash-robust — the latest state survives even if the session
 * never exits cleanly ("closed my laptop"). A throttle keeps the real work to at
 * most once per THROTTLE_MS so per-turn cost stays negligible across consumers.
 *
 * Invoked by: node .claude/scripts/session-continuity.mjs capture
 *
 * Cross-platform (Rule #1): Node fs/path/child_process primitives only.
 */

import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { findProjectRoot } from './lib/moflo-paths.mjs';
import { openBackend } from './lib/get-backend.mjs';
import { scrubSecrets } from './lib/pii-scrub.mjs';
import { readHookStdin } from './lib/hook-io.mjs';
import {
  readContinuityConfig,
  readGitState,
  hasPrivateOptOut,
  assembleDigestContent,
  buildDigestMetadata,
  writeDigest,
  rotateDigests,
} from './lib/session-continuity.mjs';

const THROTTLE_MS = 30_000;     // skip the work if we captured <30s ago this session
const LEARNINGS_SAMPLE = 5;     // how many recent learnings to fold in as "decisions"

function warn(msg) {
  try { process.stderr.write(`moflo: session-continuity ${msg}\n`); } catch { /* never throw from a hook */ }
}

/** First user message (the session goal) from a transcript JSONL head. */
function extractFirstUserGoal(headText) {
  for (const line of headText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const role = obj?.message?.role ?? obj?.role;
    if (role !== 'user') continue;
    let content = obj?.message?.content ?? obj?.content;
    if (Array.isArray(content)) {
      content = content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join(' ');
    }
    if (typeof content !== 'string') continue;
    const firstLine = content.replace(/\s+/g, ' ').trim();
    // Skip slash-command / hook-noise openers — they aren't a goal statement.
    if (!firstLine || firstLine.startsWith('<')) continue;
    return firstLine.slice(0, 200);
  }
  return null;
}

/** Bounded transcript read: goal from the head, `<private>` opt-out scan over
 *  head+tail. Large transcripts are read at the edges only. */
function readTranscriptInfo(path) {
  const info = { goal: null, optOut: false };
  try {
    if (!path || !existsSync(path)) return info;
    const size = statSync(path).size;
    let head;
    let tail;
    if (size <= 1_048_576) {
      head = tail = readFileSync(path, 'utf-8');
    } else {
      const fd = openSync(path, 'r');
      try {
        const hb = Buffer.alloc(32_768);
        readSync(fd, hb, 0, hb.length, 0);
        head = hb.toString('utf-8');
        const tlen = 131_072;
        const tb = Buffer.alloc(tlen);
        readSync(fd, tb, 0, tlen, Math.max(0, size - tlen));
        tail = tb.toString('utf-8');
      } finally {
        closeSync(fd);
      }
    }
    info.optOut = hasPrivateOptOut(head) || hasPrivateOptOut(tail);
    info.goal = extractFirstUserGoal(head);
  } catch {
    // Transcript is best-effort context; never block capture on it.
  }
  return info;
}

/** Throttle gate — true if we should skip capturing this turn. */
function shouldThrottle(statePath, sessionId, now) {
  try {
    if (!existsSync(statePath)) return false;
    const s = JSON.parse(readFileSync(statePath, 'utf-8'));
    return s.sessionId === sessionId && typeof s.lastCaptureMs === 'number' && now - s.lastCaptureMs < THROTTLE_MS;
  } catch {
    return false;
  }
}

function writeThrottleState(statePath, sessionId, now) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ sessionId, lastCaptureMs: now }), 'utf-8');
  } catch { /* non-fatal */ }
}

/** Recent learnings → short "decision" bullets. Read-only moflo.db access; safe
 *  under WAL and never blocks the daemon. Best-effort: any failure → []. */
async function readRecentDecisions(projectRoot, limit) {
  let db;
  try {
    db = await openBackend(projectRoot, { create: false, readOnly: true });
  } catch {
    return [];
  }
  const out = [];
  try {
    const stmt = db.prepare(
      `SELECT content FROM memory_entries WHERE namespace='learnings' AND status='active' ORDER BY created_at DESC LIMIT ?`,
    );
    stmt.bind([limit]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const firstLine = String(row.content || '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('---'));
      if (firstLine) out.push(firstLine.slice(0, 120));
    }
    stmt.free();
  } catch {
    // learnings table may not exist yet, or DB mid-repair — optional source.
  } finally {
    try { if (typeof db.close === 'function') db.close(); } catch { /* already closed */ }
  }
  return out;
}

async function capture() {
  const projectRoot = findProjectRoot();
  const cfg = readContinuityConfig(projectRoot);
  if (!cfg.capture) return;

  const input = await readHookStdin();
  const sessionId = input.session_id || input.sessionId || null;
  const now = Date.now();

  const statePath = resolve(projectRoot, '.moflo', 'continuity-state.json');
  if (shouldThrottle(statePath, sessionId, now)) return;

  const transcript = readTranscriptInfo(input.transcript_path || input.transcriptPath);
  if (transcript.optOut) {
    // User asked this session not to be remembered — record nothing, but stamp
    // the throttle so we don't re-scan the transcript every turn.
    writeThrottleState(statePath, sessionId, now);
    return;
  }

  const gitState = readGitState(projectRoot);
  const decisions = await readRecentDecisions(projectRoot, LEARNINGS_SAMPLE);

  const content = scrubSecrets(
    assembleDigestContent({ goal: transcript.goal, decisions, gitState }),
  );
  if (!content.trim()) {
    writeThrottleState(statePath, sessionId, now);
    return; // nothing substantive to remember
  }

  const metadata = buildDigestMetadata({ gitState, sessionId, endedAt: now });
  const key = sessionId
    ? `session-${sessionId}`
    : `session-${gitState.branch || 'nobranch'}-${new Date(now).toISOString().slice(0, 10)}`;

  try {
    writeDigest(projectRoot, key, { content, metadata });
    rotateDigests(projectRoot);
    writeThrottleState(statePath, sessionId, now);
  } catch (err) {
    warn(`persist failed (${err && err.message ? err.message : String(err)})`);
  }
}

const sub = process.argv[2];
if (sub === 'capture') {
  capture().catch((err) => warn(`failed (${err && err.message ? err.message : String(err)})`));
} else {
  warn(`unknown subcommand "${sub || ''}" (expected: capture)`);
}
