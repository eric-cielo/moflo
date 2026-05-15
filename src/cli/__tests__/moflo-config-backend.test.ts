/**
 * Tests for the `memory.backend` config section + runtime resolver
 * introduced by issue #1144.
 *
 * The old story: `MofloConfig.memory.backend` was set in `moflo.yaml` but
 * never reached the runtime — selectProvider() probed node:sqlite → rvf →
 * json and ignored the YAML knob entirely. The collapse PR narrows the type
 * union to match what selectProvider understands, adds a resolver that
 * normalises the deprecated `sql.js` alias, and wires the value through
 * `createDatabase()` so the YAML promise is finally truthful.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadMofloConfig,
  resolveDatabaseProvider,
  _resetBackendDeprecations,
} from '../config/moflo-config.js';
import {
  createDatabase,
  _resetPreferredProviderCache,
} from '../memory/database-provider.js';

describe('moflo-config: memory.backend type union (#1144)', () => {
  let root: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-backend-'));
    _resetBackendDeprecations();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it('defaults backend to node-sqlite when moflo.yaml is absent', () => {
    const cfg = loadMofloConfig(root);
    expect(cfg.memory.backend).toBe('node-sqlite');
  });

  it('accepts every legitimate backend value as-is', async () => {
    for (const backend of ['node-sqlite', 'rvf', 'json'] as const) {
      await writeFile(join(root, 'moflo.yaml'), `memory:\n  backend: ${backend}\n`);
      const cfg = loadMofloConfig(root);
      expect(cfg.memory.backend).toBe(backend);
    }
  });

  it('accepts sql.js as a deprecated alias (parsed, not yet resolved)', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'memory:\n  backend: sql.js\n');
    const cfg = loadMofloConfig(root);
    expect(cfg.memory.backend).toBe('sql.js');
    // No deprecation message yet — the warning fires when the value is
    // *used* (via resolveDatabaseProvider), not when it's loaded.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown backend values (e.g. dropped agentdb) with a stderr warning', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'memory:\n  backend: agentdb\n');
    const cfg = loadMofloConfig(root);
    expect(cfg.memory.backend).toBe('node-sqlite'); // fallback to default
    const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toMatch(/unknown memory\.backend "agentdb"/);
    expect(calls).toMatch(/falling back to "node-sqlite"/);
  });
});

describe('resolveDatabaseProvider (#1144)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetBackendDeprecations();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes through node-sqlite, rvf, and json unchanged', () => {
    expect(resolveDatabaseProvider('node-sqlite')).toBe('node-sqlite');
    expect(resolveDatabaseProvider('rvf')).toBe('rvf');
    expect(resolveDatabaseProvider('json')).toBe('json');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('maps sql.js → node-sqlite with a one-time stderr deprecation', () => {
    expect(resolveDatabaseProvider('sql.js')).toBe('node-sqlite');
    const firstCall = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(firstCall).toMatch(/DEPRECATED: memory\.backend "sql\.js"/);
    expect(firstCall).toMatch(/Using "node-sqlite" instead/);

    // Second call is also mapped, but no second stderr write — dedup per
    // process is mandatory so daemons/long-lived MCP servers don't spam.
    stderrSpy.mockClear();
    expect(resolveDatabaseProvider('sql.js')).toBe('node-sqlite');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('createDatabase honours MofloConfig.memory.backend (#1144)', () => {
  let root: string;
  let prevCwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-createdb-'));
    prevCwd = process.cwd();
    process.chdir(root);
    _resetBackendDeprecations();
    _resetPreferredProviderCache();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(root, { recursive: true, force: true });
  });

  it('opens a working node-sqlite handle when moflo.yaml says node-sqlite', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'memory:\n  backend: node-sqlite\n');
    const db = await createDatabase(':memory:');
    try {
      const health = await db.healthCheck();
      expect(health.status).toBe('healthy');
    } finally {
      await db.shutdown();
    }
  });

  it('opens without throwing when moflo.yaml says sql.js (deprecated alias)', async () => {
    await writeFile(join(root, 'moflo.yaml'), 'memory:\n  backend: sql.js\n');
    const stderrCalls: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrCalls.push(String(chunk));
      return true;
    });
    try {
      const db = await createDatabase(':memory:');
      try {
        const health = await db.healthCheck();
        expect(health.status).toBe('healthy');
      } finally {
        await db.shutdown();
      }
      const stderr = stderrCalls.join('');
      expect(stderr).toMatch(/DEPRECATED: memory\.backend "sql\.js"/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
