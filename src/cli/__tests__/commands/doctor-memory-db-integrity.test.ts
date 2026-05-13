/**
 * Tests for the `Memory DB Integrity` doctor check (#1090-followup).
 *
 * Scope: the check's status mapping — passes silently when the DB is absent
 * or `PRAGMA integrity_check` returns ok, fails with a healer-pointer fix
 * when corruption is detected, and never throws against a non-SQLite file
 * (the failure mode that pre-#1090 surfaced as the synthetic 'Check' error
 * — doctor.ts:214 — and masked the actionable signal).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkMemoryDbIntegrity } from '../../commands/doctor-checks-config.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-integrity-check-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* */ }
});

function dbPath(): string {
  return join(tmpDir, '.moflo', 'moflo.db');
}

function seedDb(rows: number): void {
  mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
  const db = openDaemonDatabase(dbPath());
  db.run('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT)');
  for (let i = 0; i < rows; i++) {
    db.run('INSERT INTO memory_entries (key, value) VALUES (?, ?)', [`key-${i}`, `value-${i}`]);
  }
  db.close();
}

describe('checkMemoryDbIntegrity (#1090-followup)', () => {
  it('passes silently when the DB file is absent', async () => {
    const result = await checkMemoryDbIntegrity(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.fix).toBeUndefined();
  });

  it('passes when integrity_check returns ok', async () => {
    seedDb(25);
    const result = await checkMemoryDbIntegrity(tmpDir);
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/integrity_check.*ok/i);
  });

  it('fails with a healer-pointer fix when the DB has corruption', async () => {
    seedDb(200);
    // Same autoindex-zeroing fixture as bin/lib/db-repair test. Page 4–6
    // typically hold the autoindex for a small DB; zeroing yields
    // "row N missing from index sqlite_autoindex_memory_entries_1" which
    // PRAGMA integrity_check detects on read.
    const buf = readFileSync(dbPath());
    for (let page = 4; page < 7; page++) {
      const start = page * 4096;
      if (start + 4096 > buf.length) break;
      buf.fill(0, start, start + 4096);
    }
    writeFileSync(dbPath(), buf);

    const result = await checkMemoryDbIntegrity(tmpDir);
    expect(result.status).toBe('fail');
    expect(result.fix).toBe('flo healer --fix -c memory-db-integrity');
    // Two valid failure messages: either `integrity_check` returns
    // violations (sqlite parses the file but the b-tree is broken), or
    // the readonly open itself throws (`Unable to probe DB`) when
    // corruption is deep enough to break the open path. Both paths
    // surface the same actionable signal — the healer pointer.
    expect(result.message).toMatch(/integrity violation|unable to probe/i);
  });

  it('reports fail with a fix pointer for a non-SQLite file (never throws)', async () => {
    mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
    writeFileSync(dbPath(), Buffer.from('this is not a sqlite file'));
    const result = await checkMemoryDbIntegrity(tmpDir);
    // Header damage surfaces as `fail` with the same fix pointer — the
    // healer's tiered repair handles "unrecoverable header" by returning
    // persistent:true, but the *check* must still surface an actionable
    // signal rather than masking it as a generic Check error.
    expect(result.status).toBe('fail');
    expect(result.fix).toBe('flo healer --fix -c memory-db-integrity');
  });
});
