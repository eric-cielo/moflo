/**
 * Unit tests for `bin/lib/get-backend.mjs` — the JS-twin factory that every
 * bin/ script routes through (issue #1081, epic #1078 Phase 2).
 *
 * Coverage:
 *   1. Engine selection — explicit override, env var, default chain
 *   2. sql.js adapter — open/run/prepare/step/getAsObject/save/close
 *   3. node:sqlite adapter — same surface, WAL pragmas, save() is a no-op
 *   4. Parity — both backends round-trip the same data through the same API
 *   5. Static grep — zero direct sql.js imports in bin/** outside the factory
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sync as globSync } from 'glob';

import {
  openBackend,
  resolveBackend,
  BACKEND_SQLJS,
  BACKEND_NODE_SQLITE,
} from '../../bin/lib/get-backend.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTempProjectRoot(prefix: string): string {
  // OS tmpdir keeps the consumer-smoke fixture pattern (#1088) — never write
  // under the moflo repo's own .moflo/ during tests.
  return fs.mkdtempSync(path.join(os.tmpdir(), `moflo-getbackend-${prefix}-`));
}

function cleanupRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe('get-backend factory — engine selection', () => {
  const original = process.env.MOFLO_DB_BACKEND;
  beforeEach(() => {
    delete process.env.MOFLO_DB_BACKEND;
  });
  afterEach(() => {
    if (original !== undefined) process.env.MOFLO_DB_BACKEND = original;
    else delete process.env.MOFLO_DB_BACKEND;
  });

  it('defaults to sql.js when no override is set', () => {
    expect(resolveBackend()).toBe(BACKEND_SQLJS);
  });

  it('honours MOFLO_DB_BACKEND=node-sqlite', () => {
    process.env.MOFLO_DB_BACKEND = 'node-sqlite';
    expect(resolveBackend()).toBe(BACKEND_NODE_SQLITE);
  });

  it('honours MOFLO_DB_BACKEND=sql.js', () => {
    process.env.MOFLO_DB_BACKEND = 'sql.js';
    expect(resolveBackend()).toBe(BACKEND_SQLJS);
  });

  it('ignores unrecognised env values and falls back to default', () => {
    process.env.MOFLO_DB_BACKEND = 'mongodb';
    expect(resolveBackend()).toBe(BACKEND_SQLJS);
  });

  it('explicit opts.backend wins over env var', () => {
    process.env.MOFLO_DB_BACKEND = 'node-sqlite';
    expect(resolveBackend({ backend: 'sql.js' })).toBe(BACKEND_SQLJS);
  });

  it('trims whitespace around the env var', () => {
    process.env.MOFLO_DB_BACKEND = '  node-sqlite  ';
    expect(resolveBackend()).toBe(BACKEND_NODE_SQLITE);
  });
});

describe.each([
  { name: 'sql.js', backend: 'sql.js' as const },
  { name: 'node-sqlite', backend: 'node-sqlite' as const },
])('get-backend adapter — $name (parity)', ({ backend, name }) => {
  let root: string;

  beforeEach(() => {
    root = makeTempProjectRoot(name.replace('.', ''));
  });
  afterEach(() => {
    cleanupRoot(root);
  });

  it('reports its kind via the .kind property', async () => {
    const db = await openBackend(root, { backend, create: true });
    try {
      expect(db.kind).toBe(backend);
    } finally {
      db.close();
    }
  });

  it('round-trips a row via prepare/run + prepare/step/getAsObject', async () => {
    const db = await openBackend(root, { backend, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
      const ins = db.prepare(`INSERT INTO t (id, name) VALUES (?, ?)`);
      ins.run([1, 'alpha']);
      ins.run([2, 'beta']);
      ins.free();

      const sel = db.prepare(`SELECT id, name FROM t ORDER BY id`);
      sel.bind([]);
      const rows: Array<Record<string, unknown>> = [];
      while (sel.step()) rows.push(sel.getAsObject());
      sel.free();

      expect(rows).toEqual([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);
    } finally {
      db.close();
    }
  });

  it('exposes getRowsModified() after an UPDATE', async () => {
    const db = await openBackend(root, { backend, create: true });
    try {
      db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER)`);
      db.run(`INSERT INTO t (id, flag) VALUES (1, 0), (2, 0), (3, 1)`);
      const upd = db.prepare(`UPDATE t SET flag = 9 WHERE flag = 0`);
      upd.run();
      upd.free();
      expect(db.getRowsModified()).toBe(2);
    } finally {
      db.close();
    }
  });

  it('exec() returns sql.js-shaped row array for PRAGMA queries', async () => {
    const db = await openBackend(root, { backend, create: true });
    try {
      const result = db.exec('PRAGMA integrity_check');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]?.values?.[0]?.[0]).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('persists across reopen — save() then load again', async () => {
    const first = await openBackend(root, { backend, create: true });
    first.run(`CREATE TABLE persist (k TEXT PRIMARY KEY, v TEXT)`);
    first.run(`INSERT INTO persist (k, v) VALUES ('hello', 'world')`);
    first.save();
    first.close();

    const second = await openBackend(root, { backend, create: false });
    try {
      const stmt = second.prepare(`SELECT v FROM persist WHERE k = ?`);
      stmt.bind(['hello']);
      expect(stmt.step()).toBe(true);
      expect(stmt.getAsObject()).toEqual({ v: 'world' });
      stmt.free();
    } finally {
      second.close();
    }
  });
});

describe('get-backend adapter — node:sqlite specifics', () => {
  let root: string;
  beforeEach(() => {
    root = makeTempProjectRoot('node-specifics');
  });
  afterEach(() => {
    cleanupRoot(root);
  });

  it('enables WAL on first open (sidecars appear on first write)', async () => {
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
    try {
      db.run(`CREATE TABLE w (id INTEGER PRIMARY KEY)`);
      db.run(`INSERT INTO w (id) VALUES (1)`);
      // node:sqlite writes immediately under WAL — no explicit save() required.
      const dbPath = path.join(root, '.moflo', 'moflo.db');
      expect(fs.existsSync(dbPath + '-wal')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('get-backend — static import audit (issue #1081 AC)', () => {
  it('no bin/**/*.mjs imports sql.js directly outside the factory', () => {
    const matches = globSync('bin/**/*.mjs', {
      cwd: REPO_ROOT,
      ignore: ['bin/lib/get-backend.mjs'],
      absolute: true,
      nodir: true,
    });

    // Match both static `from 'sql.js'` and dynamic `import('sql.js')` forms,
    // including the mofloResolveURL('sql.js') resolver call that wraps the
    // import URL on Windows.
    const sqlJsImport = /(from\s+['"]sql\.js['"]|import\s*\(\s*['"]sql\.js['"]|mofloResolveURL\(\s*['"]sql\.js['"])/;

    const violations: string[] = [];
    for (const abs of matches) {
      const content = fs.readFileSync(abs, 'utf8');
      if (sqlJsImport.test(content)) {
        violations.push(path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Direct sql.js imports leaked into bin/** outside the factory (issue #1081):\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `\n\nRoute through openBackend() from bin/lib/get-backend.mjs instead.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
