/**
 * `flo memory audit-learnings` (#1466) — curation pass over durable learnings.
 *
 * Every side effect the audit needs lives here: reading the store, the
 * verdict-state file, the bounded headless model call, and the archive write.
 * The judgement itself is pure and lives in `memory/learnings-audit.ts`, which
 * is what makes the clustering and ranking testable without a database.
 *
 * **Dry by default.** A run with no flags reads, nominates, judges, and prints;
 * it never writes to the store. `--apply` archives (`status = 'archived'`) via
 * the same `archiveDurableRow` primitive `flo memory delete` uses, so the
 * deletion carries a tombstone the #1463 reconciler can propagate instead of
 * being silently re-imported on the next session start.
 *
 * Cross-platform (Rule #1): `path.join` throughout, `child_process.spawn` with
 * an argument array (no shell), `windowsHide` on the child, and no POSIX-only
 * utilities.
 *
 * @module commands/memory-audit-learnings
 */

import * as fs from 'fs';
import * as pathModule from 'path';
import { spawn } from 'child_process';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm } from '../prompt.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import { deleteEntry } from '../memory/entries-write.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../memory/daemon-backend.js';
import { resolveBridgeDbPath } from '../memory/bridge-core.js';
import { findProjectRoot } from '../services/project-root.js';
import { hasMemoryEntriesTable } from '../services/cherry-pick-learnings.js';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { hashContent } from '../memory/auto-memory-bridge.js';
import {
  LEARNINGS_NAMESPACE,
  buildAuditPlan,
  buildJudgePrompt,
  parseVerdicts,
  selectArchivable,
  selectManualActions,
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_JUDGE_LIMIT,
  DEFAULT_UNUSED_LIMIT,
  DEFAULT_UNUSED_MIN_AGE_MS,
  type AuditCandidate,
  type AuditPlan,
  type AuditRow,
  type AuditVerdict,
  type DecidedEntry,
} from '../memory/learnings-audit.js';

/** Where recorded verdicts live. Local-only — never part of the shared artifact. */
export const AUDIT_STATE_FILE = 'learnings-audit.json';
/** Bump when the record shape changes; an older file is discarded, not migrated. */
const AUDIT_STATE_VERSION = 1;
/** Cheap formatter/judge model — same tier the auto-meditate distill runs on. */
const JUDGE_MODEL_ID = 'claude-haiku-4-5-20251001';
/** Hard ceiling on the headless judge; killed past this. */
const JUDGE_TIMEOUT_MS = 180_000;
/** Narrowest read-only tool grant for the judge child. See `runJudge`. */
const JUDGE_ALLOWED_TOOLS = 'Read';

/**
 * Test seam mirroring `bin/meditate-distill.mjs`: when set to a script path the
 * judge runs as `node <stub> --print <prompt>` instead of `claude --print
 * <prompt>`, so the spawn is exercisable on all three platforms without a real
 * Claude CLI on PATH.
 */
export const JUDGE_STUB_ENV = 'MOFLO_AUDIT_LEARNINGS_NODE_STUB';

interface AuditState {
  version: number;
  decided: Record<string, DecidedEntry>;
}

function stateFilePath(projectRoot: string): string {
  return pathModule.join(projectRoot, '.moflo', AUDIT_STATE_FILE);
}

/** Read recorded verdicts. Any unreadable or stale-version file reads as empty. */
export function readAuditState(projectRoot: string): Map<string, DecidedEntry> {
  try {
    const raw = fs.readFileSync(stateFilePath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as AuditState;
    if (parsed?.version !== AUDIT_STATE_VERSION || !parsed.decided) return new Map();
    return new Map(Object.entries(parsed.decided));
  } catch {
    // Absent, truncated, or hand-edited into invalid JSON. Losing the record
    // costs one re-judgement; refusing to run over it costs the command.
    return new Map();
  }
}

/**
 * Write the verdict record back.
 *
 * Read-modify-write with no lock: two `--apply` runs racing on the same project
 * would lose one run's verdicts. Not worth a lock — this is a hand-invoked
 * curation command, the loss costs one re-judgement, and `atomicWriteFileSync`
 * already rules out a torn file (its temp name is pid- and random-suffixed, so
 * concurrent writers cannot clobber each other's staging file either).
 */
export function writeAuditState(projectRoot: string, decided: ReadonlyMap<string, DecidedEntry>): void {
  const file = stateFilePath(projectRoot);
  fs.mkdirSync(pathModule.dirname(file), { recursive: true });
  const payload: AuditState = { version: AUDIT_STATE_VERSION, decided: Object.fromEntries(decided) };
  atomicWriteFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Parse a stored embedding. A malformed vector reads as absent rather than
 * throwing — one bad row must not take the whole audit down.
 */
function parseEmbedding(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

/**
 * Load the active learnings rows the audit operates on.
 *
 * The missing-table case is PROBED rather than caught. A blanket try/catch here
 * would turn a corrupt or locked database into a cheerful "0 active learnings
 * examined", which is the same lie #1149 exists to prevent — a real read failure
 * must reach the caller.
 */
export function readLearningsRows(db: SqlJsLikeDatabase): AuditRow[] {
  if (!hasMemoryEntriesTable(db)) return [];

  const result = db.exec(
    `SELECT id, key, content, embedding, created_at, updated_at, access_count
       FROM memory_entries
      WHERE status = 'active' AND namespace = ?`,
    [LEARNINGS_NAMESPACE],
  );

  return (result[0]?.values ?? []).map((row) => {
    const [id, key, content, embedding, createdAt, updatedAt, accessCount] = row;
    return {
      id: String(id ?? ''),
      key: String(key ?? ''),
      content: String(content ?? ''),
      embedding: parseEmbedding(embedding),
      createdAt: Number(createdAt) || 0,
      updatedAt: Number(updatedAt) || 0,
      accessCount: Number(accessCount) || 0,
    };
  });
}

interface JudgeResult {
  ok: boolean;
  output: string;
  error?: string;
}

/**
 * Run one bounded headless judgement. Never throws — a failure is a result.
 *
 * The prompt goes over **stdin**, not argv. `bin/meditate-distill.mjs` passes
 * its prompt as an argument, which is safe there because it sends 25 one-line
 * lessons; this one sends up to 60 entries with 400-char bodies — roughly 36 KB,
 * comfortably past Windows' 32,767-character `CreateProcess` command-line limit,
 * so an argv prompt would fail on Windows at the DEFAULT settings (Rule #1).
 * `claude --print` with no positional prompt reads stdin, which has no such cap
 * on any platform.
 */
function runJudge(projectRoot: string, prompt: string): Promise<JudgeResult> {
  return new Promise((resolve) => {
    const stub = process.env[JUDGE_STUB_ENV];
    const cmd = stub ? process.execPath : 'claude';
    // The judge reads a prompt and writes verdict lines — it needs no tools at
    // all. The flag wants a value, so grant the narrowest read-only one rather
    // than leaving the child with an unrestricted default (Write/Edit/Bash) in
    // somebody else's repository.
    const args = stub ? [stub, '--print'] : ['--print', '--allowedTools', JUDGE_ALLOWED_TOOLS];

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: projectRoot,
        env: {
          ...process.env,
          // Mark the child so its own hooks no-op (#860) — without this the
          // judge would trip the session-start indexer chain in every consumer.
          CLAUDE_CODE_HEADLESS: 'true',
          ANTHROPIC_MODEL: JUDGE_MODEL_ID,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, output: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let text = '';
    let settled = false;
    const finish = (r: JudgeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish({ ok: false, output: text, error: `timed out after ${JUDGE_TIMEOUT_MS}ms` });
    }, JUDGE_TIMEOUT_MS);

    child.stdout?.on('data', (d) => { text += String(d); });
    child.stderr?.on('data', (d) => { text += String(d); });
    child.on('error', (err) => finish({ ok: false, output: text, error: err.message }));
    child.on('close', (code) => finish({ ok: code === 0, output: text }));

    // A child that exits before reading the prompt makes this write EPIPE.
    // That is the same failure the `close` handler is about to report, so
    // swallow it here rather than letting it reach the process as unhandled.
    child.stdin?.on('error', () => { /* reported via close/error above */ });
    try {
      child.stdin?.end(prompt, 'utf-8');
    } catch {
      /* same — the exit path carries the diagnosis */
    }
  });
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `--unused-min-age-days` in ms, falling back to the module default. */
function unusedMinAgeMs(flag: unknown): number {
  const days = Number(flag);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_UNUSED_MIN_AGE_MS;
}

function printPlan(plan: AuditPlan): void {
  output.writeln();
  output.writeln(output.bold('Nominations'));
  output.printTable({
    columns: [
      { key: 'bucket', header: 'Bucket', width: 24 },
      { key: 'count', header: 'Count', width: 10, align: 'right' },
    ],
    data: [
      { bucket: 'Near-duplicate', count: plan.counts.duplicate },
      { bucket: 'Unused and old', count: plan.counts.unused },
      { bucket: 'Superseded vocabulary', count: plan.counts.superseded },
      { bucket: output.bold('To judge'), count: output.bold(String(plan.candidates.length)) },
    ],
  });

  const notes: string[] = [
    `${plan.examined} active learning${plan.examined === 1 ? '' : 's'} examined`,
  ];
  if (plan.unusedCoverage.matched > plan.unusedCoverage.nominated) {
    // Never let a cap read as full coverage.
    notes.push(
      `${plan.unusedCoverage.matched} entries are unused and old; the ${plan.unusedCoverage.nominated} `
      + 'least-recently-updated were nominated (--unused-limit to widen)',
    );
  }
  if (plan.alreadyDecided > 0) {
    notes.push(`${plan.alreadyDecided} already carry a recorded verdict (--recheck to re-examine)`);
  }
  if (plan.withoutEmbedding > 0) {
    notes.push(`${plan.withoutEmbedding} have no stored vector — invisible to the duplicate pass`);
  }
  if (plan.overflow > 0) {
    notes.push(`${plan.overflow} nomination(s) over the judge limit — they resurface next run`);
  }
  output.printList(notes);
}

function printVerdicts(
  candidates: readonly AuditCandidate[],
  verdicts: ReadonlyMap<string, { verdict: AuditVerdict; reason: string }>,
): void {
  output.writeln();
  output.writeln(output.bold('Verdicts'));
  output.printTable({
    columns: [
      { key: 'key', header: 'Entry', width: 44 },
      { key: 'verdict', header: 'Verdict', width: 10 },
      { key: 'reason', header: 'Reason', width: 46 },
    ],
    data: candidates
      .filter((c) => verdicts.has(c.key))
      .map((c) => {
        const v = verdicts.get(c.key)!;
        return { key: c.key, verdict: v.verdict, reason: v.reason };
      }),
  });

  const unanswered = candidates.length - verdicts.size;
  if (unanswered > 0) {
    output.printWarning(`${unanswered} entr${unanswered === 1 ? 'y' : 'ies'} received no verdict — left untouched`);
  }
}

/** Say what a non-archiving verdict is asking for, so it never just evaporates. */
function printManualActions(
  manual: ReadonlyArray<{ candidate: AuditCandidate; verdict: AuditVerdict }>,
): void {
  if (manual.length === 0) return;
  output.writeln();
  output.printInfo(
    `${manual.length} entr${manual.length === 1 ? 'y needs' : 'ies need'} an author, not an archive — `
    + '--apply never removes these, because both verdicts mean the content still has to survive:',
  );
  output.printList(
    manual.map(({ candidate, verdict }) =>
      verdict === 'MERGE'
        ? `${candidate.key} — MERGE into ${candidate.duplicateOf ?? 'its near-duplicate'}, then retire it`
        : `${candidate.key} — COMPRESS: rewrite to 1-3 sentences`,
    ),
  );
}

export const auditLearningsCommand: Command = {
  name: 'audit-learnings',
  description: 'Evaluate durable learnings for staleness (dry by default)',
  options: [
    {
      name: 'apply',
      description: 'Archive entries the audit judged RETIRE or MERGE',
      type: 'boolean',
      default: false,
    },
    {
      // Declared positively. The parser turns `--no-<x>` into `<x> = false`
      // (parser.ts § long flag), so an option NAMED `no-judge` would be
      // unreachable: typing `--no-judge` sets `judge`, and nothing reads it.
      name: 'judge',
      description: 'Request a model verdict for nominated entries (--no-judge to skip)',
      type: 'boolean',
      default: true,
    },
    {
      name: 'recheck',
      description: 'Re-examine entries that already carry a recorded verdict',
      type: 'boolean',
      default: false,
    },
    {
      name: 'duplicate-threshold',
      description: `Cosine similarity for near-duplicates (default ${DEFAULT_DUPLICATE_THRESHOLD})`,
      type: 'number',
    },
    {
      name: 'unused-min-age-days',
      description: `Age floor before an unused entry is nominated (default ${DEFAULT_UNUSED_MIN_AGE_MS / 86_400_000})`,
      type: 'number',
    },
    {
      name: 'unused-limit',
      description: `Max unused entries nominated (default ${DEFAULT_UNUSED_LIMIT})`,
      type: 'number',
    },
    {
      name: 'judge-limit',
      description: `Max entries sent for a verdict (default ${DEFAULT_JUDGE_LIMIT})`,
      type: 'number',
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip the confirmation prompt on --apply',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'flo memory audit-learnings', description: 'Dry run — nominate, judge, and report' },
    { command: 'flo memory audit-learnings --no-judge', description: 'Mechanical nominations only, no model call' },
    { command: 'flo memory audit-learnings --apply', description: 'Archive the entries judged RETIRE' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      return await runAudit(ctx);
    } catch (error) {
      // Opening the store, reading it, or writing the verdict record can all
      // throw. Report them as a failed command rather than an unhandled
      // rejection that prints a stack trace over the plan the user just read.
      output.printError(`audit-learnings failed: ${errorDetail(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

async function runAudit(ctx: CommandContext): Promise<CommandResult> {
    const apply = ctx.flags.apply === true;
    const judge = ctx.flags.judge !== false;
    const recheck = ctx.flags.recheck === true;
    const force = ctx.flags.force === true;
    const asJson = ctx.flags.format === 'json';

    const projectRoot = findProjectRoot({ cwd: process.cwd() });
    const dbPath = resolveBridgeDbPath(projectRoot);

    if (!fs.existsSync(dbPath)) {
      output.printError(`No memory store found at ${dbPath}. Run: flo memory init`);
      return { success: false, exitCode: 1 };
    }

    // Always load the record: `--recheck` bypasses it for NOMINATION only.
    // Starting from an empty map and writing that back would erase every prior
    // verdict, making the next ordinary run re-nominate and re-pay for the whole
    // judged set — the opposite of what a recheck is asking for.
    const decided = readAuditState(projectRoot);
    const decidedForPlan = recheck ? new Map<string, DecidedEntry>() : decided;

    let rows: AuditRow[];
    const db = openDaemonDatabase(dbPath);
    try {
      rows = readLearningsRows(db);
    } finally {
      db.close();
    }

    const plan = buildAuditPlan(rows, {
      duplicateThreshold: toPositiveNumber(ctx.flags.duplicateThreshold, DEFAULT_DUPLICATE_THRESHOLD),
      unusedLimit: toPositiveNumber(ctx.flags.unusedLimit, DEFAULT_UNUSED_LIMIT),
      judgeLimit: toPositiveNumber(ctx.flags.judgeLimit, DEFAULT_JUDGE_LIMIT),
      decided: decidedForPlan,
      unusedMinAgeMs: unusedMinAgeMs(ctx.flags.unusedMinAgeDays),
      hashContent,
    });

    if (!asJson) {
      if (!apply) output.writeln(output.warning('DRY RUN - No changes will be made'));
      printPlan(plan);
    }

    // Report the number sent for a verdict on every path, including the paths
    // that send none — "0 judged" and "judging skipped" are different answers
    // and a reader has to be able to tell them apart.
    let verdicts = new Map<string, { verdict: AuditVerdict; reason: string }>();
    let judged = 0;
    let judgeError: string | undefined;

    if (!judge) {
      judgeError = 'skipped (--no-judge)';
    } else if (plan.candidates.length === 0) {
      judgeError = undefined;
    } else {
      judged = plan.candidates.length;
      if (!asJson) {
        output.printInfo(`Requesting a verdict for ${judged} nominated entr${judged === 1 ? 'y' : 'ies'}…`);
      }
      const result = await runJudge(projectRoot, buildJudgePrompt(plan.candidates));
      if (result.ok) {
        verdicts = parseVerdicts(result.output, plan.candidates.map((c) => c.key));
      } else {
        judgeError = result.error ?? 'the judge exited non-zero';
      }
    }

    if (judgeError && judge && !asJson) {
      output.printWarning(`No verdicts: ${judgeError}. Nominations above stand; nothing was archived.`);
    }
    if (!asJson && verdicts.size > 0) printVerdicts(plan.candidates, verdicts);

    const archivable = selectArchivable(plan.candidates, verdicts);
    const manual = selectManualActions(plan.candidates, verdicts);
    if (!asJson) printManualActions(manual);

    const summary = {
      dryRun: !apply,
      examined: plan.examined,
      alreadyDecided: plan.alreadyDecided,
      counts: plan.counts,
      nominated: plan.candidates.length,
      overflow: plan.overflow,
      judged,
      judgeSkipped: !judge,
      judgeError,
      verdicts: Object.fromEntries([...verdicts].map(([k, v]) => [k, v.verdict])),
      archivable: archivable.map((c) => c.key),
      archiveFailures: [] as string[],
      manualActions: manual.map(({ candidate, verdict }) => ({ key: candidate.key, verdict })),
      archived: 0,
    };

    if (!apply) {
      if (asJson) output.printJson(summary);
      else if (archivable.length > 0) {
        output.writeln();
        output.printInfo(`Re-run with --apply to archive ${archivable.length} entr${archivable.length === 1 ? 'y' : 'ies'}.`);
      }
      return { success: true, data: summary };
    }

    if (verdicts.size === 0) {
      // Without verdicts there is nothing to apply. Nominations are evidence,
      // not decisions — archiving on them alone is exactly the age-based purge
      // this command exists to replace.
      const reason = 'No verdicts to apply — nominations alone are not a decision.';
      if (asJson) output.printJson({ ...summary, applied: false, reason });
      else output.printWarning(reason);
      return { success: true, data: summary };
    }

    if (archivable.length > 0 && !force) {
      // A prompt needs somewhere to read the answer from. Under `--format json`,
      // in CI, or from a cron entry there is no terminal, and `confirm()` would
      // block forever on a pipe that never sends a line — so say what is needed
      // and decline instead of hanging.
      const canPrompt = ctx.interactive && process.stdin.isTTY === true && !asJson;
      if (!canPrompt) {
        const pending = { ...summary, applied: false, reason: 'Confirmation required — re-run with --force.' };
        if (asJson) output.printJson(pending);
        else output.printWarning(`${pending.reason} (no interactive terminal to confirm on)`);
        return { success: true, data: pending };
      }
      const confirmed = await confirm({
        message: `Archive ${archivable.length} learning${archivable.length === 1 ? '' : 's'}?`,
        default: false,
      });
      if (!confirmed) {
        output.printInfo('Audit cancelled — nothing was archived');
        return { success: true, data: summary };
      }
    }

    // Every mutation goes through `deleteEntry`, never a direct handle on the
    // store. This command runs in the foreground while the user's daemon is very
    // likely holding `.moflo/moflo.db`, and a raw cross-process write there is
    // exactly the single-writer violation epic #1054 exists to prevent — the
    // whitelist classifies `durable-store-io` as `daemon-offline` for that
    // reason, and this caller is not offline. Routing also means the archive
    // semantics are inherited rather than restated: `deleteEntry` and
    // `bridgeDeleteEntry` both send a durable namespace to `archiveDurableRow`,
    // so a `learnings` delete already archives, keeps the row, and leaves the
    // tombstone #1463's reconciler propagates.
    //
    // No `dbPath` is passed on purpose: supplying one is how a caller opts OUT
    // of that routing, which would put the raw write straight back.
    let archived = 0;
    const archiveFailures: string[] = [];
    for (const candidate of archivable) {
      try {
        const result = await deleteEntry({ key: candidate.key, namespace: LEARNINGS_NAMESPACE });
        if (result?.deleted === true) archived++;
        else archiveFailures.push(`${candidate.key}: ${result?.error ?? 'not deleted'}`);
      } catch (err) {
        archiveFailures.push(`${candidate.key}: ${errorDetail(err)}`);
      }
    }

    // Record every verdict, not just the archived ones. A KEEP that is not
    // recorded is re-nominated by the same mechanical pass on the next run,
    // which would make the audit permanently noisy instead of idempotent.
    const now = Date.now();
    const nextState = new Map(decided);
    for (const candidate of plan.candidates) {
      const v = verdicts.get(candidate.key);
      if (!v) continue;
      nextState.set(candidate.key, { verdict: v.verdict, hash: hashContent(candidate.content), at: now });
    }
    writeAuditState(projectRoot, nextState);

    summary.dryRun = false;
    summary.archived = archived;
    summary.archiveFailures = archiveFailures;
    if (archiveFailures.length > 0 && !asJson) {
      // Never let a partial apply read as a clean one: the verdict record below
      // still marks these decided, so a silent failure would retire them from
      // the audit's attention without ever removing them.
      output.printWarning(`${archiveFailures.length} entr${archiveFailures.length === 1 ? 'y' : 'ies'} could not be archived:`);
      output.printList(archiveFailures);
    }
    if (asJson) {
      output.printJson({ ...summary, applied: true });
    } else {
      output.writeln();
      output.printSuccess(`Archived ${archived} learning${archived === 1 ? '' : 's'}`);
      output.printList([
        `Verdicts recorded: ${verdicts.size}`,
        'Archived entries are excluded from memory_search, flo memory list, and memory_stats.',
      ]);
    }

    return { success: true, data: { ...summary, applied: true } };
}
