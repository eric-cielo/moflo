/**
 * Learnings-namespace overview for the Luminarium "Learnings" panel (#1203).
 *
 * Surfaces what the learning loop (auto-meditate's background distill + manual
 * /meditate + ad-hoc memory_store) has actually accumulated: a bounded list of
 * recent learnings with content, a per-day growth series, and a provenance
 * tally derived from the write-time `source:<origin>` tag.
 *
 * Read-only. Opens the DB directly via the unified `openDaemonDatabase`
 * factory (same pattern as `getNamespaceCounts`) — the dashboard route that
 * calls this runs inside the daemon, so direct access is correct and there is
 * no daemon round-trip. The `total` is an authoritative COUNT (NOT the length
 * of the capped recent list) so the panel never under-reports — the #1149
 * "memory_stats lies" guard applies here too.
 *
 * @module memory/learnings-overview
 */

import * as fs from 'fs';
import { memoryDbPath } from '../services/moflo-paths.js';
import { openDaemonDatabase } from './daemon-backend.js';

/** The namespace this overview is scoped to. */
const LEARNINGS_NAMESPACE = 'learnings';
/** Default number of most-recent learnings returned with their bodies. */
const DEFAULT_RECENT_LIMIT = 20;
/** Default per-learning body cap (chars) — bounds the browser payload. */
const DEFAULT_BODY_CAP = 600;
/** Cap on the number of daily growth buckets returned (most-recent N). */
const MAX_GROWTH_BUCKETS = 30;
/** Provenance bucket key for learnings written before write-time tagging. */
export const LEGACY_PROVENANCE = 'unknown';

export interface RecentLearning {
  key: string;
  /** First non-empty line of the body (headline). */
  firstLine: string;
  /** The body, capped to `bodyCap` chars. */
  body: string;
  /** True when the stored body exceeded `bodyCap` and was truncated. */
  truncated: boolean;
  /** Provenance from the `source:<origin>` tag, or null if untagged (legacy). */
  source: string | null;
  /** ms-since-epoch when first stored. */
  createdAt: number;
  /** ms-since-epoch of the last update. */
  updatedAt: number;
}

export interface LearningsOverview {
  /** Authoritative total count of active learnings (matches memory_stats). */
  total: number;
  /** Most-recent learnings (capped), newest first. */
  recent: RecentLearning[];
  /** source → count over the WHOLE namespace; legacy/untagged → "unknown". */
  provenance: Record<string, number>;
  /** Per-day new-learning counts (UTC date), oldest→newest, most-recent buckets. */
  growth: Array<{ date: string; count: number }>;
  /** New learnings added in the last 7 days (by createdAt). */
  addedLast7d: number;
  /** New learnings added in the last 30 days (by createdAt). */
  addedLast30d: number;
}

/** Parse the `source:<origin>` provenance tag out of a tags JSON array. */
function parseSourceTag(tagsJson: string | null | undefined): string | null {
  if (!tagsJson) return null;
  try {
    const tags = JSON.parse(tagsJson);
    if (!Array.isArray(tags)) return null;
    for (const t of tags) {
      if (typeof t === 'string' && t.startsWith('source:')) {
        const v = t.slice('source:'.length).trim();
        if (v) return v;
      }
    }
  } catch {
    // Malformed tags JSON — treat as untagged.
  }
  return null;
}

/** First non-empty, trimmed line of a body (for the headline). */
function firstLineOf(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** A finite positive integer, or the default (guards NaN / float / ≤0 inputs). */
function toPositiveInt(v: number | undefined, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : def;
}

/** UTC `YYYY-MM-DD` for a ms timestamp, or null if not a finite timestamp. */
function utcDay(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

const EMPTY: LearningsOverview = {
  total: 0,
  recent: [],
  provenance: {},
  growth: [],
  addedLast7d: 0,
  addedLast30d: 0,
};

/**
 * Build the learnings overview. Returns an empty shape only when the DB file
 * doesn't exist yet (genuine "no learnings"); DB read errors propagate so the
 * dashboard route surfaces a 500 rather than a misleading empty panel.
 */
export async function getLearningsOverview(options?: {
  recentLimit?: number;
  bodyCap?: number;
  dbPath?: string;
}): Promise<LearningsOverview> {
  // recentLimit is interpolated into the SQL LIMIT clause — accept only a
  // finite positive integer so a stray float/NaN/≤0 can't produce bad SQL.
  const recentLimit = toPositiveInt(options?.recentLimit, DEFAULT_RECENT_LIMIT);
  const bodyCap = toPositiveInt(options?.bodyCap, DEFAULT_BODY_CAP);
  const resolvedPath = options?.dbPath || memoryDbPath(process.cwd());

  if (!fs.existsSync(resolvedPath)) {
    return { ...EMPTY };
  }

  const db = openDaemonDatabase(resolvedPath);
  try {
    // One full-namespace scan over the small tags + created_at columns yields
    // BOTH the authoritative total (row count — NOT the capped recent-list
    // length, the #1149 guard) and the provenance tally + growth buckets. Kept
    // in JS so tag parsing needs no SQLite JSON extension. The WHERE clause
    // matches getNamespaceCounts, so this count agrees with memory_stats.
    const allRes = db.exec(
      "SELECT tags, created_at FROM memory_entries WHERE status = 'active' AND namespace = 'learnings'",
    );
    const allRows = allRes[0]?.values ?? [];
    const total = allRows.length;

    const provenance: Record<string, number> = {};
    const dayCounts = new Map<string, number>();
    const now = Date.now();
    const cutoff7d = now - 7 * 86_400_000;
    const cutoff30d = now - 30 * 86_400_000;
    let addedLast7d = 0;
    let addedLast30d = 0;

    for (const row of allRows) {
      const [tagsJson, createdAtRaw] = row as [string | null, number | string | null];
      const source = parseSourceTag(tagsJson) ?? LEGACY_PROVENANCE;
      provenance[source] = (provenance[source] ?? 0) + 1;

      const createdAt = Number(createdAtRaw);
      const day = utcDay(createdAt);
      if (day) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
      if (Number.isFinite(createdAt)) {
        if (createdAt >= cutoff7d) addedLast7d++;
        if (createdAt >= cutoff30d) addedLast30d++;
      }
    }

    // Most-recent MAX_GROWTH_BUCKETS days, oldest→newest (bounds payload).
    const growth = [...dayCounts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(-MAX_GROWTH_BUCKETS)
      .map(([date, count]) => ({ date, count }));

    // 3) Recent learnings with capped bodies, newest first.
    const recentRes = db.exec(
      "SELECT key, content, tags, created_at, updated_at FROM memory_entries " +
      "WHERE status = 'active' AND namespace = 'learnings' " +
      `ORDER BY updated_at DESC LIMIT ${recentLimit}`,
    );
    const recent: RecentLearning[] = [];
    for (const row of recentRes[0]?.values ?? []) {
      const [key, contentRaw, tagsJson, createdAtRaw, updatedAtRaw] = row as [
        string, string | null, string | null, number | string | null, number | string | null,
      ];
      const content = contentRaw ?? '';
      const truncated = content.length > bodyCap;
      recent.push({
        key: String(key),
        firstLine: firstLineOf(content).slice(0, 200),
        body: truncated ? content.slice(0, bodyCap) : content,
        truncated,
        source: parseSourceTag(tagsJson),
        createdAt: Number(createdAtRaw) || 0,
        updatedAt: Number(updatedAtRaw) || 0,
      });
    }

    return { total, recent, provenance, growth, addedLast7d, addedLast30d };
  } finally {
    db.close();
  }
}
