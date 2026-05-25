/**
 * Unit tests for getLearningsOverview (#1203).
 *
 * Seeds a real temp SQLite DB (full control over created_at / tags) and
 * verifies the four panel signals: truthful total (NOT the capped recent
 * length — #1149 guard), recent list with capped bodies + parsed source,
 * provenance tally over the whole namespace, and per-day growth + windows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';
import { MEMORY_SCHEMA_V3 } from '../../memory/schema.js';
import { getLearningsOverview } from '../../memory/learnings-overview.js';

const DAY = 86_400_000;

let tmpRoot: string;
let dbPath: string;

function seed(rows: Array<{
  key: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt?: number;
  namespace?: string;
}>): void {
  const db = openDaemonDatabase(dbPath);
  try {
    let n = 0;
    for (const r of rows) {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content, type, tags, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, 'active')`,
        [
          `id_${n++}_${r.key}`,
          r.key,
          r.namespace ?? 'learnings',
          r.content,
          r.tags && r.tags.length ? JSON.stringify(r.tags) : null,
          r.createdAt,
          r.updatedAt ?? r.createdAt,
        ],
      );
    }
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'moflo-lrn-'));
  dbPath = join(tmpRoot, 'moflo.db');
  const db = openDaemonDatabase(dbPath);
  try { db.run(MEMORY_SCHEMA_V3); } finally { db.close(); }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getLearningsOverview', () => {
  it('returns an empty shape when the DB file does not exist', async () => {
    const overview = await getLearningsOverview({ dbPath: join(tmpRoot, 'nope.db') });
    expect(overview.total).toBe(0);
    expect(overview.recent).toEqual([]);
    expect(overview.provenance).toEqual({});
    expect(overview.growth).toEqual([]);
    expect(overview.addedLast7d).toBe(0);
    expect(overview.addedLast30d).toBe(0);
  });

  it('reports recent list, provenance tally, growth, and time windows', async () => {
    const now = Date.now();
    seed([
      { key: 'a', content: 'Alpha lesson.\nMore detail.', tags: ['x', 'source:auto-meditate'], createdAt: now },
      { key: 'b', content: 'Bravo lesson.', tags: ['source:meditate-manual'], createdAt: now - 3 * DAY },
      { key: 'c', content: 'Charlie lesson.', tags: ['source:manual'], createdAt: now - 10 * DAY },
      { key: 'd', content: 'Delta legacy lesson.', tags: [], createdAt: now - 40 * DAY },
    ]);

    const o = await getLearningsOverview({ dbPath });

    expect(o.total).toBe(4);

    // Recent newest-first (updated_at defaults to created_at).
    expect(o.recent.map(r => r.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(o.recent[0].source).toBe('auto-meditate');
    expect(o.recent[0].firstLine).toBe('Alpha lesson.');
    expect(o.recent[3].source).toBeNull(); // legacy/untagged

    // Provenance over the whole namespace.
    expect(o.provenance).toEqual({
      'auto-meditate': 1,
      'meditate-manual': 1,
      'manual': 1,
      'unknown': 1,
    });

    // Growth buckets (per-day) — 4 distinct days here.
    expect(o.growth.length).toBe(4);
    expect(o.growth.reduce((s, g) => s + g.count, 0)).toBe(4);

    // Time windows: a(now)+b(3d) within 7d; +c(10d) within 30d; d(40d) outside.
    expect(o.addedLast7d).toBe(2);
    expect(o.addedLast30d).toBe(3);
  });

  it('total is the authoritative count, not the capped recent length (#1149)', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      key: `k${i}`,
      content: `Lesson ${i}`,
      tags: ['source:manual'],
      createdAt: now - i * 1000, // distinct, descending
    }));
    seed(rows);

    const o = await getLearningsOverview({ dbPath });
    expect(o.total).toBe(25);
    expect(o.recent.length).toBe(20); // default recentLimit cap
    expect(o.provenance.manual).toBe(25); // tally is over ALL rows
  });

  it('caps an oversized body and flags it truncated', async () => {
    const now = Date.now();
    const big = 'X'.repeat(1000);
    seed([{ key: 'big', content: big, tags: ['source:manual'], createdAt: now }]);

    const def = await getLearningsOverview({ dbPath });
    expect(def.recent[0].body.length).toBe(600); // DEFAULT_BODY_CAP
    expect(def.recent[0].truncated).toBe(true);

    const custom = await getLearningsOverview({ dbPath, bodyCap: 100 });
    expect(custom.recent[0].body.length).toBe(100);
    expect(custom.recent[0].truncated).toBe(true);
  });

  it('routes untagged learnings into the legacy/unknown provenance bucket', async () => {
    const now = Date.now();
    seed([
      { key: 'legacy1', content: 'old one', createdAt: now },
      { key: 'legacy2', content: 'old two', tags: ['topic-only'], createdAt: now },
    ]);
    const o = await getLearningsOverview({ dbPath });
    expect(o.provenance.unknown).toBe(2);
    expect(o.recent.every(r => r.source === null)).toBe(true);
  });

  it('ignores entries in other namespaces', async () => {
    const now = Date.now();
    seed([
      { key: 'l1', content: 'learning', tags: ['source:manual'], createdAt: now, namespace: 'learnings' },
      { key: 'p1', content: 'pattern', tags: ['source:manual'], createdAt: now, namespace: 'patterns' },
    ]);
    const o = await getLearningsOverview({ dbPath });
    expect(o.total).toBe(1);
    expect(o.recent.map(r => r.key)).toEqual(['l1']);
  });
});
