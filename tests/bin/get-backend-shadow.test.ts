/**
 * Shadow-read mode tests — Phase 3 of epic #1078 (issue #1082).
 *
 * Covers the factory's opt-in resolution (env, opts, moflo.yaml), the
 * wrapper's write-mirroring + read-comparison, divergence reporting via
 * stderr + JSON-lines log, and strict-mode throw. Default-off is asserted
 * separately so the zero-overhead path stays load-bearing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  openBackend,
  BACKEND_SQLJS,
  BACKEND_NODE_SQLITE,
} from '../../bin/lib/get-backend.mjs';
import {
  resolveShadow,
  shadowDbPath,
  shadowLogPath,
  _resetYamlCache,
} from '../../bin/lib/shadow-backend.mjs';

function makeRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `moflo-shadow-${prefix}-`));
}

function cleanupRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function writeMofloYaml(root: string, body: string): void {
  fs.writeFileSync(path.join(root, 'moflo.yaml'), body, 'utf-8');
  _resetYamlCache();
}

describe('resolveShadow precedence', () => {
  const original = {
    shadow: process.env.MOFLO_DB_SHADOW,
    strict: process.env.MOFLO_DB_SHADOW_STRICT,
  };
  let root: string;

  beforeEach(() => {
    root = makeRoot('resolve');
    delete process.env.MOFLO_DB_SHADOW;
    delete process.env.MOFLO_DB_SHADOW_STRICT;
    _resetYamlCache();
  });
  afterEach(() => {
    cleanupRoot(root);
    if (original.shadow !== undefined) process.env.MOFLO_DB_SHADOW = original.shadow;
    else delete process.env.MOFLO_DB_SHADOW;
    if (original.strict !== undefined) process.env.MOFLO_DB_SHADOW_STRICT = original.strict;
    else delete process.env.MOFLO_DB_SHADOW_STRICT;
  });

  it('defaults to false when nothing is set', () => {
    expect(resolveShadow(root)).toBe(false);
  });

  it('honours MOFLO_DB_SHADOW=1', () => {
    process.env.MOFLO_DB_SHADOW = '1';
    expect(resolveShadow(root)).toBe(true);
  });

  it('honours MOFLO_DB_SHADOW=true', () => {
    process.env.MOFLO_DB_SHADOW = 'true';
    expect(resolveShadow(root)).toBe(true);
  });

  it('honours MOFLO_DB_SHADOW=0 explicitly off', () => {
    process.env.MOFLO_DB_SHADOW = '0';
    writeMofloYaml(root, 'memory:\n  backend: sql.js\n  shadow_read: true\n');
    // Env 0 wins over yaml true.
    expect(resolveShadow(root)).toBe(false);
  });

  it('honours moflo.yaml memory.shadow_read: true', () => {
    writeMofloYaml(root, 'memory:\n  backend: sql.js\n  shadow_read: true\n');
    expect(resolveShadow(root)).toBe(true);
  });

  it('reads false from moflo.yaml when shadow_read: false', () => {
    writeMofloYaml(root, 'memory:\n  backend: sql.js\n  shadow_read: false\n');
    expect(resolveShadow(root)).toBe(false);
  });

  it('opts.shadow explicit override wins over env', () => {
    process.env.MOFLO_DB_SHADOW = '1';
    expect(resolveShadow(root, { shadow: false })).toBe(false);
    delete process.env.MOFLO_DB_SHADOW;
    expect(resolveShadow(root, { shadow: true })).toBe(true);
  });
});

describe('shadow off (default) — zero overhead path', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('off'); });
  afterEach(() => cleanupRoot(root));

  it('does not create a shadow DB or log file', async () => {
    const db = await openBackend(root, { create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      db.run(`INSERT INTO t (id) VALUES (1)`);
      db.save();
    } finally {
      db.close();
    }
    expect(fs.existsSync(shadowDbPath(root))).toBe(false);
    expect(fs.existsSync(shadowLogPath(root))).toBe(false);
  });

  it('reports kind without a shadowKind property', async () => {
    const db = await openBackend(root, { create: true });
    try {
      // Phase 4 (#1083) flipped the default to node-sqlite; shadow-off path
      // surfaces the bare primary without a shadowKind annotation.
      expect(db.kind).toBe(BACKEND_NODE_SQLITE);
      expect((db as { shadowKind?: string }).shadowKind).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe.each([
  { primary: BACKEND_SQLJS as const, shadowEngine: BACKEND_NODE_SQLITE },
  { primary: BACKEND_NODE_SQLITE as const, shadowEngine: BACKEND_SQLJS },
])('shadow on — parity ($primary primary)', ({ primary, shadowEngine }) => {
  let root: string;
  beforeEach(() => { root = makeRoot(`parity-${primary.replace('.', '')}`); });
  afterEach(() => cleanupRoot(root));

  it('opens both engines and reports both kinds', async () => {
    const db = await openBackend(root, { backend: primary, shadow: true, create: true });
    try {
      expect(db.kind).toBe(primary);
      expect((db as { shadowKind: string }).shadowKind).toBe(shadowEngine);
    } finally {
      db.close();
    }
  });

  it('seeds the shadow file and mirrors writes', async () => {
    const db = await openBackend(root, { backend: primary, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
      const ins = db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`);
      ins.run([1, 'alpha']);
      ins.run([2, 'beta']);
      ins.free();
      db.save();
    } finally {
      db.close();
    }

    // Reopen each backend independently — both files should hold the same rows.
    const primaryDb = await openBackend(root, { backend: primary, create: false });
    const shadowDb = await openBackend(root, {
      backend: shadowEngine,
      create: false,
      dbPath: shadowDbPath(root),
    });
    try {
      for (const handle of [primaryDb, shadowDb]) {
        const stmt = handle.prepare(`SELECT id, name FROM t ORDER BY id`);
        stmt.bind([]);
        const rows: Array<Record<string, unknown>> = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        expect(rows).toEqual([
          { id: 1, name: 'alpha' },
          { id: 2, name: 'beta' },
        ]);
      }
    } finally {
      primaryDb.close();
      shadowDb.close();
    }

    // Parity → zero divergence entries written to the log.
    expect(fs.existsSync(shadowLogPath(root))).toBe(false);
  });

  it('compares exec() row arrays — parity returns clean', async () => {
    const db = await openBackend(root, { backend: primary, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      db.run(`INSERT INTO t (id) VALUES (1), (2), (3)`);
      const result = db.exec(`SELECT COUNT(*) AS c FROM t`);
      expect(result[0]?.values?.[0]?.[0]).toBe(3);
    } finally {
      db.close();
    }
    expect(fs.existsSync(shadowLogPath(root))).toBe(false);
  });

  it('round-trips BLOB bytes equally on both engines', async () => {
    const blob = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    const db = await openBackend(root, { backend: primary, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)`);
      const ins = db.prepare(`INSERT INTO b (id, data) VALUES (?, ?)`);
      ins.run([1, blob]);
      ins.free();
      db.save();

      const sel = db.prepare(`SELECT data FROM b WHERE id = 1`);
      sel.bind([]);
      expect(sel.step()).toBe(true);
      const row = sel.getAsObject();
      const got = row.data as Uint8Array;
      expect(got).toBeInstanceOf(Uint8Array);
      expect(Array.from(got)).toEqual(Array.from(blob));
      sel.free();
    } finally {
      db.close();
    }
    expect(fs.existsSync(shadowLogPath(root))).toBe(false);
  });
});

describe('shadow on — divergence detection', () => {
  let root: string;
  let originalStrict: string | undefined;

  beforeEach(() => {
    root = makeRoot('diverge');
    originalStrict = process.env.MOFLO_DB_SHADOW_STRICT;
    delete process.env.MOFLO_DB_SHADOW_STRICT;
  });
  afterEach(() => {
    cleanupRoot(root);
    if (originalStrict !== undefined) process.env.MOFLO_DB_SHADOW_STRICT = originalStrict;
    else delete process.env.MOFLO_DB_SHADOW_STRICT;
  });

  it('flags divergence when primary is mutated without the shadow', async () => {
    const db = await openBackend(root, { backend: BACKEND_SQLJS, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
      db.run(`INSERT INTO t (id, name) VALUES (1, 'alpha')`);

      // Mutate ONLY the primary engine via the internal handle — this is the
      // simulated bug class shadow-mode is designed to catch.
      const wrapper = db as { _primary: { run: (sql: string) => void } };
      wrapper._primary.run(`UPDATE t SET name = 'drift' WHERE id = 1`);

      const stmt = db.prepare(`SELECT name FROM t WHERE id = 1`);
      stmt.bind([]);
      stmt.step();
      stmt.free();
    } finally {
      db.close();
    }

    expect(fs.existsSync(shadowLogPath(root))).toBe(true);
    const log = fs.readFileSync(shadowLogPath(root), 'utf-8').trim().split('\n');
    expect(log.length).toBeGreaterThan(0);
    const last = JSON.parse(log[log.length - 1]);
    expect(last.op).toBe('step.row');
    expect(last.primaryRow?.name).toBe('drift');
    expect(last.shadowRow?.name).toBe('alpha');
  });

  it('flags exec() row-array divergence (compareExecRows path)', async () => {
    const db = await openBackend(root, { backend: BACKEND_SQLJS, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      db.run(`INSERT INTO t (id) VALUES (1), (2)`);

      // Mutate ONLY primary so exec() row counts diverge.
      const wrapper = db as { _primary: { run: (sql: string) => void } };
      wrapper._primary.run(`INSERT INTO t (id) VALUES (3), (4)`);

      db.exec(`SELECT id FROM t ORDER BY id`);
    } finally {
      db.close();
    }

    expect(fs.existsSync(shadowLogPath(root))).toBe(true);
    const entries = fs
      .readFileSync(shadowLogPath(root), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    // Either a length divergence (different row counts) or a values divergence
    // would satisfy the AC; both originate in compareExecRows.
    const execOps = entries.filter((e) => /^exec\./.test(e.op));
    expect(execOps.length).toBeGreaterThan(0);
  });

  it('MOFLO_DB_SHADOW_STRICT=1 throws on divergence', async () => {
    process.env.MOFLO_DB_SHADOW_STRICT = '1';

    const db = await openBackend(root, { backend: BACKEND_SQLJS, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)`);
      db.run(`INSERT INTO t (id, n) VALUES (1, 1)`);

      const wrapper = db as { _primary: { run: (sql: string) => void } };
      wrapper._primary.run(`UPDATE t SET n = 999 WHERE id = 1`);

      expect(() => {
        const stmt = db.prepare(`SELECT n FROM t WHERE id = 1`);
        stmt.bind([]);
        stmt.step();
        stmt.free();
      }).toThrow(/Shadow-read divergence/);
    } finally {
      db.close();
    }
  });
});

describe('shadow on — file layout invariants', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('layout'); });
  afterEach(() => cleanupRoot(root));

  it('shadow file lives at .moflo/moflo.shadow.db', async () => {
    const db = await openBackend(root, { backend: BACKEND_SQLJS, shadow: true, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      db.run(`INSERT INTO t (id) VALUES (1)`);
      db.save();
    } finally {
      db.close();
    }
    const expected = path.join(root, '.moflo', 'moflo.shadow.db');
    expect(shadowDbPath(root)).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('seedShadowFile always recopies primary at open (no stale state)', async () => {
    // Round 1: seed primary with rows A+B.
    {
      const db = await openBackend(root, { backend: BACKEND_SQLJS, shadow: true, create: true });
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
      db.run(`INSERT INTO t (id, name) VALUES (1, 'A'), (2, 'B')`);
      db.save();
      db.close();
    }
    // Round 2: delete row B from primary side only via plain (non-shadow) open.
    {
      const db = await openBackend(root, { backend: BACKEND_SQLJS, create: false });
      db.run(`DELETE FROM t WHERE id = 2`);
      db.save();
      db.close();
    }
    // Round 3: reopen with shadow on — the seed must recopy from primary,
    // so a SELECT * must return only row A on BOTH engines (no divergence).
    {
      const db = await openBackend(root, { backend: BACKEND_SQLJS, shadow: true, create: false });
      try {
        const result = db.exec(`SELECT id, name FROM t ORDER BY id`);
        expect(result[0]?.values).toEqual([[1, 'A']]);
      } finally {
        db.close();
      }
    }
    // Parity preserved by reseed → no log entries.
    expect(fs.existsSync(shadowLogPath(root))).toBe(false);
  });
});
