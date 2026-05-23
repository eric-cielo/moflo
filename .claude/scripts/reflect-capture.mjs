#!/usr/bin/env node
/**
 * Auto-reflect Stage 1 — CAPTURE (#1198). One script, two hook entry points:
 *
 *   detect  (UserPromptSubmit) — mechanically score the user's prompt + recent
 *           transcript tail for a strong signal (course-correction / error→fix /
 *           decision). On a hit, and within rate limits, print an answer-first
 *           directive asking the LIVE model — which has full context at the
 *           moment of insight — to append ONE <reflect-capture> line IF a durable
 *           lesson emerged. Stdout from a UserPromptSubmit hook is added to the
 *           model's context (same mechanism as .claude/helpers/prompt-hook.mjs).
 *
 *   scrape  (Stop) — read the transcript tail, extract <reflect-capture> tags
 *           from the last ASSISTANT message(s), and append the raw one-liners to
 *           the JSON ledger (.moflo/reflect-ledger.json). No moflo.db write, no
 *           dedup yet — the bounded Haiku distill (bin/reflect-distill.mjs) does
 *           that later, writer-safe, via memory_store.
 *
 * Both modes early-return cheaply when auto-reflect is OFF or CLAUDE_CODE_HEADLESS
 * is set — the distill's own headless session must never re-enter capture (#860).
 * A hook must NEVER throw: every path is wrapped and degrades to a silent exit 0.
 *
 * Invoked by:
 *   node .claude/scripts/reflect-capture.mjs reflect-detect   (UserPromptSubmit)
 *   node .claude/scripts/reflect-capture.mjs reflect-scrape    (Stop)
 *
 * Cross-platform (Rule #1): Node fs/path primitives only; no shell.
 */

import { findProjectRoot } from './lib/moflo-paths.mjs';
import { readHookStdin, readFileTail } from './lib/hook-io.mjs';
import {
  TRANSCRIPT_TAIL_BYTES,
  readReflectConfig,
  isHeadless,
  detectSignal,
  buildCaptureDirective,
  injectionAllowed,
  readReflectState,
  recordInjection,
  extractCapturesFromTranscript,
  appendLedgerEntries,
} from './lib/reflect.mjs';

// Scrape needs to reliably catch the tag at the END of the assistant's reply,
// which can be a single large JSONL line — read a generous tail. Detect only
// needs recent error/decision markers, so the smaller shared window suffices.
const SCRAPE_TAIL_BYTES = 262_144;

function warn(msg) {
  try { process.stderr.write(`moflo: reflect-capture ${msg}\n`); } catch { /* never throw from a hook */ }
}

/** Shared preamble: resolve root + config, applying the OFF / headless guards.
 *  Returns null when the caller should early-exit. */
function gate() {
  if (isHeadless(process.env)) return null;          // #860 — never run inside the distill's own session
  const projectRoot = findProjectRoot();
  if (!readReflectConfig(projectRoot).enabled) return null; // off (opt-out)
  return { projectRoot };
}

async function detect() {
  const ctx = gate();
  if (!ctx) return;
  const { projectRoot } = ctx;

  const input = await readHookStdin();
  const prompt = input.prompt || input.user_prompt || '';

  // Cheapest path first: corrections + in-prompt decisions need only the prompt.
  // Read the (32KB) transcript tail for error→fix / in-transcript decisions ONLY
  // when the prompt alone produced no signal — saves the read on the common
  // correction case.
  let signal = detectSignal(prompt, '');
  if (!signal.hit) {
    const tail = readFileTail(input.transcript_path || input.transcriptPath, TRANSCRIPT_TAIL_BYTES);
    if (tail) signal = detectSignal(prompt, tail);
  }
  if (!signal.hit) return;

  const sessionId = input.session_id || input.sessionId || null;
  const now = Date.now();
  const state = readReflectState(projectRoot);
  if (!injectionAllowed(state, sessionId, now)) return; // rate-limited

  try {
    process.stdout.write(buildCaptureDirective(signal.kind) + '\n');
  } catch {
    return; // broken stdout — don't record an injection that didn't land
  }
  recordInjection(projectRoot, sessionId, now, state);
}

async function scrape() {
  const ctx = gate();
  if (!ctx) return;
  const { projectRoot } = ctx;

  const input = await readHookStdin();
  const tail = readFileTail(input.transcript_path || input.transcriptPath, SCRAPE_TAIL_BYTES);
  if (!tail) return;

  const lessons = extractCapturesFromTranscript(tail);
  if (lessons.length === 0) return;

  const sessionId = input.session_id || input.sessionId || null;
  appendLedgerEntries(projectRoot, lessons.map((lesson) => ({ lesson, kind: 'captured', sessionId })));
}

const sub = process.argv[2];
if (sub === 'reflect-detect') {
  detect().catch((err) => warn(`detect failed (${err && err.message ? err.message : String(err)})`));
} else if (sub === 'reflect-scrape') {
  scrape().catch((err) => warn(`scrape failed (${err && err.message ? err.message : String(err)})`));
} else {
  warn(`unknown subcommand "${sub || ''}" (expected: reflect-detect | reflect-scrape)`);
}
