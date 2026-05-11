/**
 * Tests for the onMigrationStart / onMigrationComplete callbacks on
 * `runEmbeddingsMigrationIfNeeded` (#639).
 *
 * The session-start launcher uses these to write a user-visible "migrating
 * memory store..." line to stdout, because Claude Code's SessionStart hook
 * surfaces hook stdout as `additionalContext` (visible to Claude → user) but
 * does not surface stderr (where the renderer's TTY bar goes). Without these
 * callbacks the migration UX is invisible to anyone running moflo as a
 * SessionStart hook.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEmbeddingsMigrationIfNeeded } from '../../services/embeddings-migration.js';
import { openDaemonDatabase } from '../../memory/daemon-backend.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal — Windows occasionally holds file handles */
    }
  }
});

async function makeV3Db(): Promise<string> {
  const { MEMORY_SCHEMA_V3 } = await import('../../memory/memory-initializer.js');
  const dir = await mkdtemp(join(tmpdir(), 'moflo-migration-cb-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  const db = openDaemonDatabase(dbPath);
  db.run(MEMORY_SCHEMA_V3);
  db.close();
  return dbPath;
}

const silentOut = {
  write: () => true,
  isTTY: false,
} as unknown as NodeJS.WritableStream & { isTTY?: boolean };

describe('runEmbeddingsMigrationIfNeeded — visibility callbacks (#639)', () => {
  it('does not call onMigrationStart when no migration is needed', async () => {
    let started = false;
    let completed = false;
    const ran = await runEmbeddingsMigrationIfNeeded({
      dbPath: join(tmpdir(), 'definitely-does-not-exist', 'nope.db'),
      out: silentOut,
      onMigrationStart: () => {
        started = true;
      },
      onMigrationComplete: () => {
        completed = true;
      },
    });
    expect(ran).toBe(false);
    expect(started).toBe(false);
    expect(completed).toBe(false);
  });

  it('calls onMigrationStart and onMigrationComplete when migration runs', async () => {
    const dbPath = await makeV3Db();
    let started = false;
    let completedRows: number | null = null;
    const ran = await runEmbeddingsMigrationIfNeeded({
      dbPath,
      out: silentOut,
      onMigrationStart: () => {
        started = true;
      },
      onMigrationComplete: (rows) => {
        completedRows = rows;
      },
    });
    expect(ran).toBe(true);
    expect(started).toBe(true);
    // Fresh DB with no rows → totalItemsMigrated is 0; the callback still fires.
    expect(completedRows).toBe(0);
  });

  it('calls onMigrationStart before onMigrationComplete (ordering invariant)', async () => {
    const dbPath = await makeV3Db();
    const events: string[] = [];
    await runEmbeddingsMigrationIfNeeded({
      dbPath,
      out: silentOut,
      onMigrationStart: () => events.push('start'),
      onMigrationComplete: () => events.push('complete'),
    });
    expect(events).toEqual(['start', 'complete']);
  });
});
