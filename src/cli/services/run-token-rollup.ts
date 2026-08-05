/**
 * Per-run token attribution — issue #1333.
 *
 * `claude-stats.ts` answers "what has this project spent"; it aggregates every
 * transcript in the project dir into windows and model distributions. It cannot
 * answer "what did THIS run cost", because a run is a stretch of wall-clock
 * inside one session, and nothing in that aggregation is keyed to a run.
 *
 * This module is the narrow counterpart: given a session id and a time window,
 * sum the `usage` counters for exactly that slice. The result is written into
 * the run's existing `tasklist` record (see `storeFloRunRecord`), so cost and
 * outcome finally share a key.
 *
 * Deliberately NOT folded into `claude-stats.ts`: that module's aggregation is
 * on the dashboard's hot path behind a 30s cache, and #1333 requires its
 * behaviour to stay byte-identical. This reads one session's files, not the
 * whole project dir.
 *
 * Why persist rather than join on read: the retained transcript corpus is
 * shallow — measured at ~2 days on this repo — because Claude Code prunes
 * `~/.claude/projects/**`. A rollup computed on demand would report a run's
 * cost correctly today and zero next week. Snapshotting at finalize time is
 * what makes the number durable.
 *
 * Cross-platform (Rule #1): pure `node:fs` + `path.join`, no shell, and the
 * reader tolerates CRLF because `readline` splits on both.
 */

import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeProjectDirFor } from '../shared/utils/claude-projects-path.js';

/**
 * Token counters for one run. Field names mirror `ClaudeStatsWindow['tokens']`
 * so a reader that already understands the stats shape needs no translation.
 */
export interface RunTokenRollup {
  readonly input: number;
  readonly output: number;
  readonly cacheCreate: number;
  readonly cacheRead: number;
  readonly total: number;
  /** Transcript files actually read (main + subagent). 0 ⇒ nothing attributed. */
  readonly transcripts: number;
  /** Assistant messages whose usage was counted — the sample size behind the sum. */
  readonly messages: number;
  /** Lines that failed to parse; surfaced so a silent zero is distinguishable. */
  readonly parseErrors: number;
}

export interface ComputeRunTokensOptions {
  /** Project directory whose transcripts to read. Defaults to `cwd`'s encoding. */
  readonly projectDir?: string;
  /** Claude Code session id — the transcript basename. */
  readonly sessionId: string;
  /** Window start, ms since epoch (inclusive). */
  readonly fromMs: number;
  /**
   * Window end, ms since epoch (inclusive). Defaults to `Date.now()` at call
   * time — a run being finalized ends now.
   */
  readonly toMs?: number;
}

interface UsageLine {
  type?: string;
  timestamp?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface MutableRollup {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  messages: number;
  parseErrors: number;
}

/** The all-zero rollup — returned when no transcript is attributable. */
export function emptyRunTokenRollup(): RunTokenRollup {
  return {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
    transcripts: 0,
    messages: 0,
    parseErrors: 0,
  };
}

/**
 * Collect the transcript files attributable to one session: the session's own
 * `<sessionId>.jsonl` plus every `<sessionId>/subagents/*.jsonl` (Task-tool
 * spawns, which carry their parent's session id and are part of the run's
 * real cost). Missing files are simply absent from the result — a session with
 * no subagents is the common case, not an error.
 */
async function sessionTranscripts(projectDir: string, sessionId: string): Promise<string[]> {
  const paths: string[] = [];

  const main = join(projectDir, `${sessionId}.jsonl`);
  try {
    if ((await stat(main)).isFile()) paths.push(main);
  } catch {
    // No main transcript (pruned, or the id is wrong) — subagents may still exist.
  }

  const subDir = join(projectDir, sessionId, 'subagents');
  let names: string[];
  try {
    names = await readdir(subDir);
  } catch {
    return paths;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(subDir, name);
    try {
      if ((await stat(full)).isFile()) paths.push(full);
    } catch {
      // Rotated mid-listing — skip.
    }
  }
  return paths;
}

async function streamUsage(
  acc: MutableRollup,
  path: string,
  fromMs: number,
  toMs: number,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    if (!raw) continue;
    // Cheap reject before JSON.parse — most lines carry no usage at all.
    if (raw.indexOf('"usage"') < 0) continue;
    let line: UsageLine;
    try {
      line = JSON.parse(raw) as UsageLine;
    } catch {
      acc.parseErrors++;
      continue;
    }
    if (line.type !== 'assistant') continue;
    const usage = line.message?.usage;
    if (!usage) continue;

    // A line with no parseable timestamp cannot be placed in the window. Drop
    // it rather than guess — over-attributing another run's spend to this one
    // is worse than under-reporting, because the number is meant to be joined.
    const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;

    acc.input += usage.input_tokens ?? 0;
    acc.output += usage.output_tokens ?? 0;
    acc.cacheCreate += usage.cache_creation_input_tokens ?? 0;
    acc.cacheRead += usage.cache_read_input_tokens ?? 0;
    acc.messages++;
  }
}

/**
 * Sum the token usage recorded for `sessionId` between `fromMs` and `toMs`.
 *
 * Returns {@link emptyRunTokenRollup} — never throws — when the project dir or
 * transcript is absent. A run whose transcript has been pruned is a run with
 * no attributable cost, which is exactly what a zeroed rollup with
 * `transcripts: 0` communicates to a reader.
 */
export async function computeRunTokens(
  cwd: string,
  options: ComputeRunTokensOptions,
): Promise<RunTokenRollup> {
  const projectDir = options.projectDir ?? claudeProjectDirFor(cwd);
  const toMs = options.toMs ?? Date.now();
  const { sessionId, fromMs } = options;

  if (!sessionId || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return emptyRunTokenRollup();
  }

  const paths = await sessionTranscripts(projectDir, sessionId);
  if (paths.length === 0) return emptyRunTokenRollup();

  const acc: MutableRollup = {
    input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0, parseErrors: 0,
  };
  let read = 0;
  for (const path of paths) {
    // Counted before streaming, not after: a file that throws part-way has
    // already contributed its parsed lines to `acc`, so incrementing only on
    // clean completion would report a transcript count lower than the number
    // actually folded into the sum.
    read++;
    try {
      await streamUsage(acc, path, fromMs, toMs);
    } catch {
      // One unreadable transcript must not blank the whole rollup.
    }
  }

  return {
    input: acc.input,
    output: acc.output,
    cacheCreate: acc.cacheCreate,
    cacheRead: acc.cacheRead,
    total: acc.input + acc.output + acc.cacheCreate + acc.cacheRead,
    transcripts: read,
    messages: acc.messages,
    parseErrors: acc.parseErrors,
  };
}
