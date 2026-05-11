/**
 * Unit tests for `bin/lib/get-backend.mjs` — the JS-twin factory that every
 * bin/ script routes through.
 *
 * Phase 5 (#1084) deleted sql.js entirely. Only node:sqlite is supported.
 *
 * Coverage:
 *   1. Engine selection — only `node-sqlite` is valid; everything else throws
 *   2. node:sqlite adapter — open/run/prepare/step/getAsObject/save/close
 *   3. WAL pragma + network-FS warning probe
 *   4. Static grep — zero direct sql.js imports anywhere in bin/**
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sync as globSync } from 'glob';

import {
  openBackend,
  resolveBackend,
  warnIfNotWal,
  BACKEND_NODE_SQLITE,
  _resetNetworkFsWarnings,
} from '../../bin/lib/get-backend.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTempProjectRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `moflo-getbackend-${prefix}-`));
}

function cleanupRoot(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* best-effort — node:sqlite may hold a brief WAL sidecar lock on Windows */
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

  it('defaults to node-sqlite', () => {
    expect(resolveBackend()).toBe(BACKEND_NODE_SQLITE);
  });

  it('explicit opts.backend = "node-sqlite" returns node-sqlite', () => {
    expect(resolveBackend({ backend: 'node-sqlite' })).toBe(BACKEND_NODE_SQLITE);
  });

  it('throws on any non-node-sqlite backend (Phase 5 #1084 retired sql.js)', () => {
    expect(() => resolveBackend({ backend: 'sql.js' })).toThrow(/sql\.js was retired/);
    expect(() => resolveBackend({ backend: 'sqlite' })).toThrow(/Unknown backend/);
  });

  it('ignores MOFLO_DB_BACKEND env var entirely (Phase 4 removed the escape hatch)', () => {
    process.env.MOFLO_DB_BACKEND = 'sql.js';
    expect(resolveBackend()).toBe(BACKEND_NODE_SQLITE);
    process.env.MOFLO_DB_BACKEND = 'anything';
    expect(resolveBackend()).toBe(BACKEND_NODE_SQLITE);
  });
});

describe('get-backend adapter — node:sqlite', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempProjectRoot('node-sqlite');
  });
  afterEach(() => {
    cleanupRoot(root);
  });

  it('reports its kind via the .kind property', async () => {
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
    try {
      expect(db.kind).toBe('node-sqlite');
    } finally {
      db.close();
    }
  });

  it('round-trips a row via prepare/run + prepare/step/getAsObject', async () => {
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
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
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
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
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
    try {
      const result = db.exec('PRAGMA integrity_check');
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]?.values?.[0]?.[0]).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('persists across reopen — save() then load again', async () => {
    const first = await openBackend(root, { backend: 'node-sqlite', create: true });
    first.run(`CREATE TABLE persist (k TEXT PRIMARY KEY, v TEXT)`);
    first.run(`INSERT INTO persist (k, v) VALUES ('hello', 'world')`);
    first.save();
    first.close();

    const second = await openBackend(root, { backend: 'node-sqlite', create: false });
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

  it('enables WAL on first open (sidecars appear on first write)', async () => {
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
    try {
      db.run(`CREATE TABLE w (id INTEGER PRIMARY KEY)`);
      db.run(`INSERT INTO w (id) VALUES (1)`);
      const dbPath = path.join(root, '.moflo', 'moflo.db');
      expect(fs.existsSync(dbPath + '-wal')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('get-backend — network-FS warning probe', () => {
  let root: string;
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    root = makeTempProjectRoot('netfs');
    _resetNetworkFsWarnings();
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr.write as any) = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = originalWrite;
    cleanupRoot(root);
  });

  it('no warning fires on a local disk (WAL succeeds)', async () => {
    const db = await openBackend(root, { backend: 'node-sqlite', create: true });
    try {
      db.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    } finally {
      db.close();
    }
    const warning = stderrWrites.join('').includes('SQLite journal_mode=');
    expect(warning).toBe(false);
  });

  it('emits the network-FS warning when journal_mode reads back as non-WAL', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(root, '.moflo', 'sim.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const handle = new DatabaseSync(dbPath);
    handle.exec('PRAGMA journal_mode = DELETE');
    warnIfNotWal(handle, dbPath);
    handle.close();

    const stderr = stderrWrites.join('');
    expect(stderr).toContain('WARNING: SQLite journal_mode=delete');
    expect(stderr).toContain(dbPath);
    expect(stderr).toContain('NFS/SMB');
  });

  it('dedupes the warning so subsequent opens of the same path stay quiet', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(root, '.moflo', 'sim.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const handle = new DatabaseSync(dbPath);
    handle.exec('PRAGMA journal_mode = DELETE');
    warnIfNotWal(handle, dbPath);
    warnIfNotWal(handle, dbPath);
    warnIfNotWal(handle, dbPath);
    handle.close();

    const matches = stderrWrites.join('').match(/WARNING: SQLite journal_mode/g);
    expect(matches?.length ?? 0).toBe(1);
  });
});

describe('get-backend — static import audit (Phase 5 #1084)', () => {
  it('no bin/**/*.mjs imports sql.js', () => {
    const matches = globSync('bin/**/*.mjs', {
      cwd: REPO_ROOT,
      absolute: true,
      nodir: true,
    });

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
        `Direct sql.js imports found in bin/** (Phase 5 #1084 retired sql.js):\n` +
          violations.map((v) => `  - ${v}`).join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });
});
