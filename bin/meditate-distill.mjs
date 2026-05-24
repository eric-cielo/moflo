#!/usr/bin/env node
/**
 * Auto-meditate Stage 2 — DISTILL (#1198). Fired DETACHED by the session-start
 * launcher (never inline — the launcher's contract is spawn-and-exit). Runs ONE
 * bounded headless Haiku `claude --print` that executes #1187's /meditate
 * distillation over the ledger one-liners (NOT the transcript): dedup-search
 * `learnings` (≥0.80 → update same key), store via memory_store. Because the
 * headless session calls memory_store itself, writes route through the daemon
 * single-writer chokepoint (#981) — writer-safe, no raw cross-process db write.
 *
 * Haiku is a FORMATTER, not a judge: the durability gate already passed upstream
 * in the live model when the lesson was captured, so this unattended pass cannot
 * pollute `learnings` with junk it invented.
 *
 * GUARDS:
 *   - off (auto_meditate.enabled: false) — exit immediately. Default is ON.
 *   - CLAUDE_CODE_HEADLESS — exit immediately (defensive; the launcher already
 *     won't fire us in headless, but self-guarding prevents any infinite spawn).
 *   - empty ledger — exit without spawning anything.
 *
 * Only entries in the snapshot we hand to Haiku are marked distilled on success,
 * so captures that arrive DURING the run survive for the next pass.
 *
 * Test seam: MOFLO_MEDITATE_DISTILL_NODE_STUB — when set to a path, the model
 * call is `node <stub> --print <prompt>` instead of `claude --print <prompt>`,
 * so the spawn is exercisable cross-platform without a real Claude CLI.
 *
 * Invoked by: node .claude/scripts/meditate-distill.mjs
 *
 * Cross-platform (Rule #1): Node child_process (arg arrays, no shell) + fs/path.
 */

import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { findProjectRoot } from './lib/moflo-paths.mjs';
import {
  HAIKU_MODEL_ID,
  readMeditateConfig,
  isHeadless,
  readLedger,
  pendingEntries,
  buildDistillPrompt,
  markLedgerDistilled,
} from './lib/meditate.mjs';

/** Cap candidates per pass — keeps the Haiku prompt small (cheap, fast). Extra
 *  pending entries roll into the next session's pass. */
const DISTILL_BATCH_MAX = 25;
/** Hard ceiling on the headless run; killed past this. */
const DISTILL_TIMEOUT_MS = 120_000;

function log(projectRoot, line) {
  try {
    const p = resolve(projectRoot, '.moflo', 'meditate-distill.log');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
  } catch { /* logging is best-effort — never throw */ }
}

/** Run the bounded headless distillation. Resolves { success, output }. */
function runHeadless(projectRoot, prompt) {
  return new Promise((res) => {
    const stub = process.env.MOFLO_MEDITATE_DISTILL_NODE_STUB;
    const cmd = stub ? process.execPath : 'claude';
    const args = stub ? [stub, '--print', prompt] : ['--print', prompt];

    const env = {
      ...process.env,
      CLAUDE_CODE_HEADLESS: 'true',     // mark the child so its own hooks no-op (#860)
      ANTHROPIC_MODEL: HAIKU_MODEL_ID,  // cheap formatter model
    };

    let child;
    try {
      child = spawn(cmd, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      res({ success: false, output: '', error: err && err.message ? err.message : String(err) });
      return;
    }

    let out = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); res(r); };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish({ success: false, output: out, error: `timed out after ${DISTILL_TIMEOUT_MS}ms` });
    }, DISTILL_TIMEOUT_MS);

    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => finish({ success: false, output: out, error: err && err.message ? err.message : String(err) }));
    child.on('close', (code) => finish({ success: code === 0, output: out }));
  });
}

async function main() {
  if (isHeadless(process.env)) return;                       // #860 self-guard
  const projectRoot = findProjectRoot();
  if (!readMeditateConfig(projectRoot).enabled) return;       // off (opt-out)

  const pending = pendingEntries(readLedger(projectRoot));
  if (pending.length === 0) return;                          // nothing to do — no spawn

  const batch = pending.slice(0, DISTILL_BATCH_MAX);
  const prompt = buildDistillPrompt(batch);

  const result = await runHeadless(projectRoot, prompt);
  if (result.success) {
    const marked = markLedgerDistilled(projectRoot, batch.map((e) => e.id));
    const summary = String(result.output || '').trim().split('\n').filter(Boolean).pop() || '(no summary)';
    log(projectRoot, `distilled ${batch.length} candidate(s), marked ${marked} — haiku: ${summary.slice(0, 200)}`);
  } else {
    // Leave the ledger untouched so the next session retries.
    log(projectRoot, `distill failed (${result.error || 'non-zero exit'}) — ${batch.length} candidate(s) retained for retry`);
  }
}

main().catch((err) => {
  try { process.stderr.write(`moflo: meditate-distill failed (${err && err.message ? err.message : String(err)})\n`); } catch { /* ignore */ }
});
