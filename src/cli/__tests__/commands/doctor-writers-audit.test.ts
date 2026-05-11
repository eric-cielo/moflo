/**
 * Tests for the Writers Audit runtime doctor check (epic #1054.S5 / #1059).
 *
 * The check enumerates running node processes and fails if a non-daemon
 * process is running a known cross-process writer (build-embeddings.mjs,
 * a migration .mjs, db-repair.mjs) while the daemon owns the lock. This is
 * the runtime sibling of S1's static lint — catches a stale writer that
 * survived S3's daemon-stop wrapper.
 */
import { describe, expect, it } from 'vitest';
import { findForeignWriters } from '../../commands/doctor-checks-writers-audit.js';

describe('findForeignWriters (#1059)', () => {
  it('returns empty when no candidate processes are running', () => {
    expect(findForeignWriters([], null, new Set(), 1)).toEqual([]);
  });

  it('ignores the daemon PID', () => {
    const procs = [
      { pid: 100, cmdline: 'node /path/to/bin/build-embeddings.mjs' },
    ];
    expect(findForeignWriters(procs, 100, new Set(), 1)).toEqual([]);
  });

  it('ignores tracked background PIDs (daemon-spawned children)', () => {
    const procs = [
      { pid: 200, cmdline: 'node /path/to/bin/build-embeddings.mjs' },
    ];
    expect(findForeignWriters(procs, 100, new Set([200]), 1)).toEqual([]);
  });

  it('ignores the doctor process itself', () => {
    const procs = [
      { pid: 300, cmdline: 'node /path/to/bin/build-embeddings.mjs' },
    ];
    expect(findForeignWriters(procs, 100, new Set(), 300)).toEqual([]);
  });

  it('flags a build-embeddings.mjs writer running outside the daemon', () => {
    const procs = [
      { pid: 400, cmdline: 'node /home/user/project/node_modules/moflo/bin/build-embeddings.mjs' },
    ];
    const out = findForeignWriters(procs, 100, new Set(), 1);
    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(400);
    expect(out[0].matchedPattern).toMatch(/build-embeddings/);
  });

  it('flags migration scripts running outside the daemon', () => {
    const procs = [
      { pid: 500, cmdline: 'node /path/to/bin/migrations/strip-context-preambles.mjs' },
      { pid: 501, cmdline: 'node /path/to/bin/migrations/purge-doc-entries.mjs' },
    ];
    const out = findForeignWriters(procs, 100, new Set(), 1);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.pid).sort()).toEqual([500, 501]);
  });

  it('flags db-repair.mjs running outside the daemon', () => {
    const procs = [
      { pid: 600, cmdline: 'node /path/to/bin/lib/db-repair.mjs' },
    ];
    const out = findForeignWriters(procs, 100, new Set(), 1);
    expect(out).toHaveLength(1);
    expect(out[0].matchedPattern).toMatch(/db-repair/);
  });

  it('does not flag arbitrary node processes that touch moflo paths', () => {
    // A test runner or the daemon itself shouldn't trip the writer regex.
    const procs = [
      { pid: 700, cmdline: 'node /path/to/moflo/dist/src/cli/index.js daemon start' },
      { pid: 701, cmdline: 'node /path/to/moflo/dist/src/cli/index.js mcp start' },
      { pid: 702, cmdline: 'node /path/to/.bin/vitest' },
    ];
    expect(findForeignWriters(procs, 100, new Set(), 1)).toEqual([]);
  });

  it('flags Windows-style paths to writer scripts', () => {
    const procs = [
      { pid: 800, cmdline: 'node "C:\\Users\\u\\project\\node_modules\\moflo\\bin\\build-embeddings.mjs"' },
      { pid: 801, cmdline: 'node "C:\\Users\\u\\project\\node_modules\\moflo\\bin\\migrations\\knowledge-purge.mjs"' },
    ];
    const out = findForeignWriters(procs, 100, new Set(), 1);
    expect(out).toHaveLength(2);
  });
});
