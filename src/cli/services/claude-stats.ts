/**
 * Claude Stats aggregator — issue #1044.
 *
 * Reads `~/.claude/projects/<encoded-cwd>/*.jsonl` line-by-line and produces
 * the JSON shape consumed by The Luminarium's "Claude Stats" tab. Pure I/O
 * + reduce; no persistent storage, no network.
 *
 * Scope: primary-session transcripts (top-level `*.jsonl`) AND per-session
 * `<id>/subagents/agent-*.jsonl` files (Task-tool spawns). Subagent usage —
 * the Sonnet/Haiku spend from /flo fan-out, /simplify, /ultrareview, etc. —
 * rolls into the model distribution and token windows so totals are complete,
 * and is ALSO tracked as a distinct `subagents` subtotal so callers can split
 * main-loop context from subagent context (issue #1264). Subagent transcripts
 * carry their PARENT sessionId, so they attribute to the right session without
 * inflating the session count. Their mtimes/sizes fold into the cache key.
 *
 * Performance posture:
 *   - Streaming readline (not `readFileSync().split('\n')`) — transcripts
 *     can grow to tens of MB and we don't want to balloon dashboard memory.
 *   - Aggregate counters only — message bodies are dropped after extracting
 *     `usage`, `model`, `tool_use.name`, `tool_result.is_error`.
 *   - 30s TTL cache keyed on the most-recent file mtime in the project dir
 *     so consecutive dashboard polls reuse the prior aggregation when no
 *     transcript has changed.
 */

import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  claudeProjectDirFor,
  encodeCwdForClaudeProjects,
} from '../shared/utils/claude-projects-path.js';

export { claudeProjectDirFor, encodeCwdForClaudeProjects };

/**
 * Map a transcript model name to a stable display key. Recognises bare family
 * names ("opus", "sonnet", "haiku"), dated/dotted variants
 * ("claude-opus-4-7", "claude-3-5-sonnet-20241022"), and is case-insensitive.
 * Anything else falls through to `'unknown'`.
 */
export function canonicalModelKey(model: string | null | undefined): string {
  if (!model || typeof model !== 'string') return 'unknown';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return 'unknown';
}

// ============================================================================
// Public types
// ============================================================================

export interface ClaudeStatsWindow {
  readonly sessions: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheCreate: number;
    readonly cacheRead: number;
    readonly total: number;
  };
}

export interface ModelDistribution {
  readonly model: string;
  readonly messages: number;
  readonly tokens: number;
}

export interface ToolUsage {
  readonly name: string;
  readonly count: number;
}

export interface ClaudeStatsShape {
  readonly available: boolean;
  readonly projectDir: string | null;
  readonly windows: {
    readonly today: ClaudeStatsWindow;
    readonly last7d: ClaudeStatsWindow;
    readonly last30d: ClaudeStatsWindow;
    readonly lifetime: ClaudeStatsWindow;
  };
  readonly models: readonly ModelDistribution[];
  readonly tools: readonly ToolUsage[];
  /**
   * Subagent (`<id>/subagents/agent-*.jsonl`, Task-tool spawn) subtotal. These
   * tokens are ALSO included in `windows`/`models` above — this breaks them out
   * so callers can compute main-loop context (window total − subagent total).
   */
  readonly subagents: {
    readonly transcripts: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly cacheCreate: number;
      readonly cacheRead: number;
      readonly total: number;
    };
  };
  /** Sessions whose transcript contained at least one tool_result.is_error. */
  readonly errorSessions: number;
  /** Median + p95 of (last - first timestamp) per session, milliseconds. */
  readonly sessionDurationMs: { readonly median: number; readonly p95: number };
  /** Total session count over lifetime (== windows.lifetime.sessions). */
  readonly totalSessions: number;
  /** Lines that failed to parse — surfaced for debugging, not user-facing. */
  readonly parseErrors: number;
  /** Aggregation wall-clock duration in ms — populated when computed. */
  readonly elapsedMs: number;
}

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry {
  readonly key: string; // most-recent-mtime + total-bytes signature
  readonly value: ClaudeStatsShape;
  readonly cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: CacheEntry | null = null;

/** Test-only — drop the in-memory cache so the next call re-aggregates. */
export function _resetClaudeStatsCache(): void {
  cache = null;
}

// ============================================================================
// Aggregation
// ============================================================================

const DAY_MS = 86_400_000;

interface MutableWindow {
  sessions: Set<string>;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

function emptyWindow(): MutableWindow {
  return { sessions: new Set(), input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

function freezeWindow(w: MutableWindow): ClaudeStatsWindow {
  const total = w.input + w.output + w.cacheCreate + w.cacheRead;
  return {
    sessions: w.sessions.size,
    tokens: {
      input: w.input,
      output: w.output,
      cacheCreate: w.cacheCreate,
      cacheRead: w.cacheRead,
      total,
    },
  };
}

interface SessionMeta {
  firstTs: number;
  lastTs: number;
  hasError: boolean;
}

interface Aggregator {
  today: MutableWindow;
  last7d: MutableWindow;
  last30d: MutableWindow;
  lifetime: MutableWindow;
  modelMessages: Map<string, number>;
  modelTokens: Map<string, number>;
  toolCounts: Map<string, number>;
  sessions: Map<string, SessionMeta>;
  parseErrors: number;
  /** Subagent-only token subtotal (also folded into windows/models above). */
  subagent: { input: number; output: number; cacheCreate: number; cacheRead: number };
}

function makeAggregator(): Aggregator {
  return {
    today: emptyWindow(),
    last7d: emptyWindow(),
    last30d: emptyWindow(),
    lifetime: emptyWindow(),
    modelMessages: new Map(),
    modelTokens: new Map(),
    toolCounts: new Map(),
    sessions: new Map(),
    parseErrors: 0,
    subagent: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  };
}

interface JsonlLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Walk one parsed JSONL line and update the aggregator. `isSubagent` marks
 * lines from `<id>/subagents/agent-*.jsonl` so their usage is additionally
 * booked to the subagent subtotal (it still counts toward windows/models).
 */
function consumeLine(agg: Aggregator, line: JsonlLine, now: number, isSubagent: boolean): void {
  const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
  const sessionId = line.sessionId;

  if (sessionId && Number.isFinite(ts)) {
    const meta = agg.sessions.get(sessionId);
    if (meta) {
      if (ts < meta.firstTs) (meta as { firstTs: number }).firstTs = ts;
      if (ts > meta.lastTs) (meta as { lastTs: number }).lastTs = ts;
    } else {
      agg.sessions.set(sessionId, { firstTs: ts, lastTs: ts, hasError: false });
    }
  }

  // Tool-error detection: tool_result blocks with is_error: true.
  // These appear on `type:"user"` lines whose message.content is an array
  // of tool_result blocks. We only check is_error so we don't have to
  // copy any payloads.
  const content = line.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; name?: string; is_error?: boolean };
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        agg.toolCounts.set(b.name, (agg.toolCounts.get(b.name) ?? 0) + 1);
      } else if (b.type === 'tool_result' && b.is_error === true && sessionId) {
        const meta = agg.sessions.get(sessionId);
        if (meta) (meta as { hasError: boolean }).hasError = true;
      }
    }
  }

  // Only assistant lines carry billable usage. Skip everything else.
  if (line.type !== 'assistant') return;
  const usage = line.message?.usage;
  if (!usage) return;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cc = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  const totalThisLine = input + output + cc + cr;

  const modelKey = canonicalModelKey(line.message?.model);
  agg.modelMessages.set(modelKey, (agg.modelMessages.get(modelKey) ?? 0) + 1);
  agg.modelTokens.set(modelKey, (agg.modelTokens.get(modelKey) ?? 0) + totalThisLine);

  // Subagent subtotal — booked in addition to (not instead of) the windows.
  if (isSubagent) {
    agg.subagent.input += input;
    agg.subagent.output += output;
    agg.subagent.cacheCreate += cc;
    agg.subagent.cacheRead += cr;
  }

  // Lifetime always.
  bump(agg.lifetime, sessionId, input, output, cc, cr);

  // Bucketed windows — only when we have a usable timestamp.
  if (Number.isFinite(ts)) {
    const ageMs = now - ts;
    if (ageMs >= 0 && ageMs < DAY_MS) bump(agg.today, sessionId, input, output, cc, cr);
    if (ageMs >= 0 && ageMs < 7 * DAY_MS) bump(agg.last7d, sessionId, input, output, cc, cr);
    if (ageMs >= 0 && ageMs < 30 * DAY_MS) bump(agg.last30d, sessionId, input, output, cc, cr);
  }
}

function bump(
  w: MutableWindow,
  sessionId: string | undefined,
  input: number,
  output: number,
  cc: number,
  cr: number,
): void {
  if (sessionId) w.sessions.add(sessionId);
  w.input += input;
  w.output += output;
  w.cacheCreate += cc;
  w.cacheRead += cr;
}

// ============================================================================
// File walking
// ============================================================================

/** List the `.jsonl` files in a project dir, returning [path, mtime, size]. */
async function listTranscripts(
  dir: string,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const candidates = entries.filter(n => n.endsWith('.jsonl'));
  // Stat in parallel — at ~700 files a serial loop is the dominant cost
  // before any file content is read.
  const stats = await Promise.all(
    candidates.map(async (name) => {
      const full = join(dir, name);
      try {
        const s = await stat(full);
        return s.isFile() ? { path: full, mtimeMs: s.mtimeMs, size: s.size } : null;
      } catch {
        // Skip transient ENOENT (file rotated mid-listing) and perms errors.
        return null;
      }
    }),
  );
  return stats.filter((s): s is { path: string; mtimeMs: number; size: number } => s !== null);
}

async function streamFile(
  agg: Aggregator,
  path: string,
  now: number,
  isSubagent: boolean,
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(raw) as JsonlLine;
    } catch {
      agg.parseErrors++;
      continue;
    }
    consumeLine(agg, parsed, now, isSubagent);
  }
}

/**
 * List `<id>/subagents/*.jsonl` transcripts (Task-tool spawns) across every
 * session subdirectory in a project dir, returning [path, mtime, size]. Session
 * dirs without a `subagents/` folder are skipped silently.
 */
async function listSubagentTranscripts(
  dir: string,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const perSession = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const subDir = join(dir, e.name, 'subagents');
        let names: string[];
        try {
          names = await readdir(subDir);
        } catch {
          // No subagents/ dir for this session (the common case) — skip.
          return [];
        }
        const jsonl = names.filter((n) => n.endsWith('.jsonl'));
        const stats = await Promise.all(
          jsonl.map(async (name) => {
            const full = join(subDir, name);
            try {
              const s = await stat(full);
              return s.isFile() ? { path: full, mtimeMs: s.mtimeMs, size: s.size } : null;
            } catch {
              return null;
            }
          }),
        );
        return stats.filter(
          (s): s is { path: string; mtimeMs: number; size: number } => s !== null,
        );
      }),
  );

  return perSession.flat();
}

// ============================================================================
// Public entry point
// ============================================================================

export interface AggregateOptions {
  /** Override the project directory — primarily for tests. */
  readonly projectDir?: string;
  /** Bypass the 30s TTL cache. */
  readonly skipCache?: boolean;
  /** Override "now" — primarily for tests. */
  readonly now?: number;
}

/**
 * Build the JSON shape returned by `GET /api/claude-stats`.
 *
 * Returns an `available: false` shape when the project dir doesn't exist or
 * holds no transcripts — the dashboard renders a "no sessions found" empty
 * state from that signal.
 */
export async function aggregateClaudeStats(
  cwd: string,
  options: AggregateOptions = {},
): Promise<ClaudeStatsShape> {
  const startedAt = Date.now();
  const dir = options.projectDir ?? claudeProjectDirFor(cwd);
  const now = options.now ?? Date.now();

  const [files, subFiles] = await Promise.all([
    listTranscripts(dir),
    listSubagentTranscripts(dir),
  ]);
  if (files.length === 0 && subFiles.length === 0) {
    return emptyShape(dir, Date.now() - startedAt);
  }

  // Cache key: per set, max(mtime) + sum(size) + file count. If none shifts,
  // the prior aggregation is still valid; a delete in either set (count drops)
  // invalidates correctly. Subagent transcripts are keyed alongside top-level.
  const allFiles = [...files, ...subFiles];
  const maxMtime = allFiles.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  const totalSize = allFiles.reduce((s, f) => s + f.size, 0);
  const cacheKey = `${dir}|${files.length}|${subFiles.length}|${maxMtime}|${totalSize}`;

  if (!options.skipCache && cache && cache.key === cacheKey && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const agg = makeAggregator();
  for (const f of files) {
    try {
      await streamFile(agg, f.path, now, false);
    } catch (err) {
      // One bad file shouldn't blank the whole tab.
      console.warn(`[claude-stats] failed to read ${f.path}: ${(err as Error).message ?? err}`);
    }
  }
  for (const f of subFiles) {
    try {
      await streamFile(agg, f.path, now, true);
    } catch (err) {
      console.warn(`[claude-stats] failed to read subagent ${f.path}: ${(err as Error).message ?? err}`);
    }
  }

  const value = freezeAggregator(agg, dir, subFiles.length, Date.now() - startedAt);
  cache = { key: cacheKey, value, cachedAt: Date.now() };
  return value;
}

/** Build the all-zero shape — exported so the dashboard route handler can
 *  reuse it on its own catch path without re-declaring the structure. */
export function emptyClaudeStatsShape(dir: string | null = null, elapsedMs = 0): ClaudeStatsShape {
  return emptyShape(dir, elapsedMs);
}

function emptyShape(dir: string | null, elapsedMs: number): ClaudeStatsShape {
  const empty = freezeWindow(emptyWindow());
  return {
    available: false,
    projectDir: dir,
    windows: { today: empty, last7d: empty, last30d: empty, lifetime: empty },
    models: [],
    tools: [],
    subagents: { transcripts: 0, tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 } },
    errorSessions: 0,
    sessionDurationMs: { median: 0, p95: 0 },
    totalSessions: 0,
    parseErrors: 0,
    elapsedMs,
  };
}

function freezeAggregator(
  agg: Aggregator,
  dir: string,
  subagentTranscripts: number,
  elapsedMs: number,
): ClaudeStatsShape {
  const models: ModelDistribution[] = [];
  for (const key of agg.modelMessages.keys()) {
    models.push({
      model: key,
      messages: agg.modelMessages.get(key) ?? 0,
      tokens: agg.modelTokens.get(key) ?? 0,
    });
  }
  models.sort((a, b) => b.tokens - a.tokens);

  const tools: ToolUsage[] = Array.from(agg.toolCounts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  let errorSessions = 0;
  const durations: number[] = [];
  for (const meta of agg.sessions.values()) {
    if (meta.hasError) errorSessions++;
    const span = meta.lastTs - meta.firstTs;
    if (span > 0) durations.push(span);
  }
  durations.sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;

  return {
    available: true,
    projectDir: dir,
    windows: {
      today: freezeWindow(agg.today),
      last7d: freezeWindow(agg.last7d),
      last30d: freezeWindow(agg.last30d),
      lifetime: freezeWindow(agg.lifetime),
    },
    models,
    tools,
    subagents: {
      transcripts: subagentTranscripts,
      tokens: {
        input: agg.subagent.input,
        output: agg.subagent.output,
        cacheCreate: agg.subagent.cacheCreate,
        cacheRead: agg.subagent.cacheRead,
        total:
          agg.subagent.input +
          agg.subagent.output +
          agg.subagent.cacheCreate +
          agg.subagent.cacheRead,
      },
    },
    errorSessions,
    sessionDurationMs: { median, p95 },
    totalSessions: agg.sessions.size,
    parseErrors: agg.parseErrors,
    elapsedMs,
  };
}
