/**
 * `flo runs start|finalize|show` — the run ledger (#1333).
 *
 * A `/flo` run's record used to be written by the MODEL: `.claude/skills/fl/phases.md`
 * Phase 0 carried a hand-copied JSON shape and asked for a `memory_store` call,
 * while the equivalent code path (`storeFloRunRecord`) sat unused. Two copies of
 * one schema, and the copy that ran was contingent on an agent remembering to
 * run it — measured compliance across the retained corpus was a single record.
 *
 * These subcommands are that single code path. The skill now shells to them, so
 * the schema has one home, and `finalize` additionally snapshots the run's token
 * cost so `tasklist` rows carry (run, tokens, completed-without-error).
 *
 * On the tuple's third element: `success` reports that the run reached a
 * terminal state without reporting an error. It is NOT externally-verified
 * outcome data — Claude Code's hook payload carries no exit code and PostToolUse
 * does not fire on Bash failure (#1322). Nothing here should be relabelled to
 * imply otherwise.
 *
 * Cross-platform (Rule #1): pure Node — no shell, no POSIX-only path handling.
 *
 * Created with cielolimitada.com
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import type { FloRunContext } from '../spells/types/runner.types.js';
import { output } from '../output.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildFloRunContext,
  storeFloRunRecord,
  getSharedMemoryAccessor,
} from '../services/daemon-dashboard.js';
import { computeRunTokens, emptyRunTokenRollup } from '../services/run-token-rollup.js';
import { resolveStateRoot } from '../services/project-root.js';

const TASKLIST_NAMESPACE = 'tasklist';

/**
 * Read the main-loop Claude Code session id stamped by `gate.cjs`'s
 * `prompt-reminder` case on every UserPromptSubmit.
 *
 * Returns null outside a Claude Code session (a bare `flo runs start` from a
 * terminal), which is correct: with no session there is no transcript, and
 * `finalize` will record a zeroed rollup rather than attribute someone else's
 * spend to the run.
 */
export function readStampedSessionId(root: string): string | null {
  const statePath = join(root, '.claude', 'workflow-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Normalize what `MemoryAccessor.read` hands back.
 *
 * The dashboard accessor JSON-stringifies on `write` but returns the raw
 * `entry.content` on `read` — only its `search` path parses. So a record that
 * round-trips through the store comes back as a STRING, and treating it as an
 * object silently makes every field undefined.
 */
function parseRunRecord(raw: unknown): StoredRunRecord | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as StoredRunRecord;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? (raw as StoredRunRecord) : null;
}

/** Stored shape of a `flo-*` tasklist row. Mirrors `storeFloRunRecord`. */
interface StoredRunRecord {
  status?: string;
  context?: FloRunContext;
  startedAt?: number;
  sessionId?: string;
  duration?: number;
  success?: boolean;
}

/**
 * Look a flag up under both spellings.
 *
 * `parser.ts:normalizeKey` rewrites `--session-id` to `sessionId` before a
 * command ever sees it, so the declared kebab name is NOT the key on `flags`.
 * Accepting both keeps the option table readable in one shape while matching
 * what the parser actually delivers — and is why this indirection exists rather
 * than indexing `ctx.flags` directly at each call site.
 */
function rawFlag(ctx: CommandContext, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return ctx.flags[camel] ?? ctx.flags[name];
}

function flagStr(ctx: CommandContext, name: string): string | undefined {
  const v = rawFlag(ctx, name);
  // A numeric-looking value (`--run-id 42`) is coerced to a number by
  // `parseValue`; stringify rather than dropping it.
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v ? v : undefined;
}

function flagNum(ctx: CommandContext, name: string): number | undefined {
  const v = rawFlag(ctx, name);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function flagBool(ctx: CommandContext, name: string): boolean {
  return rawFlag(ctx, name) === true;
}

async function startRun(ctx: CommandContext): Promise<CommandResult> {
  const root = resolveStateRoot({ cwd: ctx.cwd });
  const startedAt = flagNum(ctx, 'started-at') ?? Date.now();
  const issue = flagNum(ctx, 'issue');
  const title = flagStr(ctx, 'title');
  const spellName = flagStr(ctx, 'spell');
  const execModeRaw = flagStr(ctx, 'exec-mode');
  const execMode =
    execModeRaw === 'swarm' || execModeRaw === 'hive' ? execModeRaw : 'normal';

  const context = buildFloRunContext({
    ...(issue !== undefined ? { issueNumber: issue } : {}),
    ...(title !== undefined ? { issueTitle: title } : {}),
    ...(spellName !== undefined ? { spellName } : {}),
    execMode,
    ...(flagBool(ctx, 'epic') ? { isEpic: true } : {}),
    ...(flagBool(ctx, 'research') ? { isResearch: true } : {}),
    ...(flagBool(ctx, 'new-ticket')
      ? { isNewTicket: true, ...(title !== undefined ? { ticketTitle: title } : {}) }
      : {}),
  });

  const runId =
    flagStr(ctx, 'run-id') ?? `flo-${issue !== undefined ? issue : 'new'}-${startedAt}`;
  const sessionId = flagStr(ctx, 'session-id') ?? readStampedSessionId(root) ?? undefined;

  const memory = await getSharedMemoryAccessor();
  if (!memory) {
    output.printWarning('memory unavailable — run will not appear in The Luminarium');
    return { success: false, message: 'memory accessor unavailable', exitCode: 1 };
  }

  await storeFloRunRecord(memory, runId, context, 'running', {
    startedAt,
    ...(sessionId ? { sessionId } : {}),
  });

  // Machine-readable so the skill can capture runId without re-deriving it.
  output.printInfo(JSON.stringify({ runId, startedAt, sessionId: sessionId ?? null }));
  return { success: true, data: { runId, startedAt, sessionId: sessionId ?? null } };
}

async function finalizeRun(ctx: CommandContext): Promise<CommandResult> {
  const root = resolveStateRoot({ cwd: ctx.cwd });
  const runId = flagStr(ctx, 'run-id');
  if (!runId) {
    output.printError('flo runs finalize requires --run-id');
    return { success: false, message: 'missing --run-id', exitCode: 1 };
  }
  const statusRaw = flagStr(ctx, 'status') ?? 'completed';
  if (statusRaw !== 'completed' && statusRaw !== 'failed') {
    output.printError(`--status must be "completed" or "failed" (got "${statusRaw}")`);
    return { success: false, message: 'invalid --status', exitCode: 1 };
  }

  const memory = await getSharedMemoryAccessor();
  if (!memory) {
    output.printWarning('memory unavailable — run record not finalized');
    return { success: false, message: 'memory accessor unavailable', exitCode: 1 };
  }

  const prior = parseRunRecord(await memory.read(TASKLIST_NAMESPACE, runId));
  if (!prior || !prior.context) {
    output.printError(`no run record found for ${runId} — was "flo runs start" called?`);
    return { success: false, message: 'run record not found', exitCode: 1 };
  }

  const startedAt = prior.startedAt ?? flagNum(ctx, 'started-at');
  const endedAt = flagNum(ctx, 'ended-at') ?? Date.now();
  const sessionId = flagStr(ctx, 'session-id') ?? prior.sessionId ?? readStampedSessionId(root);

  // Attribute only what this session spent inside the run's window. With no
  // session id there is nothing to attribute against — record the zeroed
  // rollup rather than guess, so a reader can tell "cost nothing" from
  // "could not be measured" via `transcripts: 0`.
  // Anchor on the state root, NOT ctx.cwd: Claude Code encodes its project dir
  // from the directory the session was opened in, so finalizing from a
  // sub-directory (or anywhere in a monorepo below the root) would encode a
  // path with no transcripts and silently record a zeroed rollup — the #1315
  // failure shape.
  const tokens =
    sessionId && startedAt !== undefined
      ? await computeRunTokens(root, { sessionId, fromMs: startedAt, toMs: endedAt })
      : emptyRunTokenRollup();

  const errorSummary = flagStr(ctx, 'error');
  await storeFloRunRecord(memory, runId, prior.context, statusRaw, {
    ...(startedAt !== undefined ? { startedAt, duration: endedAt - startedAt } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(errorSummary ? { error: errorSummary } : {}),
    tokens,
  });

  output.printInfo(
    JSON.stringify({ runId, status: statusRaw, tokens, sessionId: sessionId ?? null }),
  );
  return { success: true, data: { runId, status: statusRaw, tokens } };
}

async function showRun(ctx: CommandContext): Promise<CommandResult> {
  const runId = flagStr(ctx, 'run-id') ?? ctx.args[1];
  if (!runId) {
    output.printError('flo runs show requires a run id');
    return { success: false, message: 'missing run id', exitCode: 1 };
  }
  const memory = await getSharedMemoryAccessor();
  if (!memory) {
    return { success: false, message: 'memory accessor unavailable', exitCode: 1 };
  }
  // Parse for the same reason `finalize` does — `read` returns the raw stored
  // string, and printing that gives an escaped one-liner instead of a record.
  const record = parseRunRecord(await memory.read(TASKLIST_NAMESPACE, runId));
  if (!record) {
    output.printError(`no run record found for ${runId}`);
    return { success: false, message: 'run record not found', exitCode: 1 };
  }
  output.printInfo(JSON.stringify(record, null, 2));
  return { success: true, data: record };
}

export const runsCommand: Command = {
  name: 'runs',
  description:
    'Record a /flo run and its token cost — usage: flo runs start --issue <n> --title <t> | flo runs finalize --run-id <id> | flo runs show <id>',
  options: [
    { name: 'run-id', description: 'Run identifier (start: generated if omitted)', type: 'string' },
    { name: 'issue', description: 'GitHub issue number', type: 'string' },
    { name: 'title', description: 'Issue or ticket title', type: 'string' },
    { name: 'spell', description: 'Spell name for -wf runs', type: 'string' },
    { name: 'exec-mode', description: 'normal | swarm | hive', type: 'string', default: 'normal' },
    { name: 'epic', description: 'Record as an epic run', type: 'boolean', default: false },
    { name: 'research', description: 'Record as a research (-r) run', type: 'boolean', default: false },
    { name: 'new-ticket', description: 'Record as a new-ticket (-t) run', type: 'boolean', default: false },
    { name: 'session-id', description: 'Claude Code session id (defaults to the stamped one)', type: 'string' },
    { name: 'started-at', description: 'Run start, ms since epoch', type: 'string' },
    { name: 'ended-at', description: 'Run end, ms since epoch (finalize)', type: 'string' },
    { name: 'status', description: 'completed | failed (finalize)', type: 'string', default: 'completed' },
    { name: 'error', description: 'Error summary when --status failed', type: 'string' },
  ],
  examples: [
    { command: 'flo runs start --issue 1333 --title "Join tokens to runs"', description: 'Open a run record' },
    { command: 'flo runs finalize --run-id flo-1333-1785891035226', description: 'Close it and snapshot token cost' },
    { command: 'flo runs show flo-1333-1785891035226', description: 'Print the stored record' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sub = ctx.args[0];
    switch (sub) {
      case 'start':
        return startRun(ctx);
      case 'finalize':
        return finalizeRun(ctx);
      case 'show':
        return showRun(ctx);
      default:
        output.printError(`unknown subcommand "${sub ?? ''}" — expected start | finalize | show`);
        return { success: false, message: 'unknown subcommand', exitCode: 1 };
    }
  },
};

export default runsCommand;
