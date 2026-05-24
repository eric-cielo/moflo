/**
 * #1168 — Neural runtime + swarm/memory command writers must resolve to
 * `.moflo/...` under the project root, not `.swarm/` under cwd.
 *
 * The pre-#1168 defaults captured `process.cwd()` at module-load time (or
 * used bare relative paths resolved against cwd at use time) and joined
 * `.swarm/`. Any consumer that imported these modules through the daemon or
 * MCP server got an empty `.swarm/` directory regenerated every session.
 *
 * This test pins the default-path invariant for all four neural-runtime
 * persisters + the two explicit-command writers. We never construct the
 * persisters with overrides — that's the only path that's supposed to
 * trigger the default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let originalCwd: string;
let originalClaudeProjectDir: string | undefined;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-1168-default-paths-'));
  process.chdir(tmpDir);
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalClaudeProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('#1168 — neural runtime defaults land under .moflo/, never .swarm/', () => {
  it('LoRAAdapter default weightsPath resolves to .moflo/movector/lora-weights.json', async () => {
    const { LoRAAdapter } = await import('../../movector/lora-adapter.js');
    const adapter = new LoRAAdapter();
    // Public surface intentionally exposes config; rely on it.
    const cfg = (adapter as unknown as { config: { weightsPath: string } }).config;
    expect(cfg.weightsPath).toBe(join(tmpDir, '.moflo', 'movector', 'lora-weights.json'));
    expect(cfg.weightsPath).not.toMatch(/\.swarm/);
  });

  it('MoERouter default weightsPath resolves to .moflo/movector/moe-weights.json', async () => {
    const { MoERouter } = await import('../../movector/moe-router.js');
    const router = new MoERouter();
    const cfg = (router as unknown as { config: { weightsPath: string } }).config;
    expect(cfg.weightsPath).toBe(join(tmpDir, '.moflo', 'movector', 'moe-weights.json'));
    expect(cfg.weightsPath).not.toMatch(/\.swarm/);
  });

  it('EWCConsolidator default storagePath resolves to .moflo/neural/ewc-fisher.json', async () => {
    const { EWCConsolidator } = await import('../../memory/ewc-consolidation.js');
    const c = new EWCConsolidator();
    const cfg = (c as unknown as { config: { storagePath: string } }).config;
    expect(cfg.storagePath).toBe(join(tmpDir, '.moflo', 'neural', 'ewc-fisher.json'));
    expect(cfg.storagePath).not.toMatch(/\.swarm/);
  });

  it('SONAOptimizer default persistencePath resolves to .moflo/neural/sona-patterns.json', async () => {
    const { SONAOptimizer } = await import('../../memory/sona-optimizer.js');
    const sona = new SONAOptimizer();
    const persistencePath = (sona as unknown as { persistencePath: string }).persistencePath;
    expect(persistencePath).toBe(join(tmpDir, '.moflo', 'neural', 'sona-patterns.json'));
    expect(persistencePath).not.toMatch(/\.swarm/);
  });
});

describe('#1168 follow-up — `flo memory` command writer (openDb) lands under .moflo/', () => {
  it('openDb resolves to canonical .moflo/moflo.db, never .swarm/memory.db', async () => {
    const { openDb } = await import('../../commands/memory.js');
    const { db, dbPath } = await openDb(tmpDir);
    try {
      expect(dbPath).toBe(join(tmpDir, '.moflo', 'moflo.db'));
      expect(dbPath).not.toMatch(/\.swarm/);
    } finally {
      db.close();
    }
  });

  it('openDb never recreates the legacy .swarm/ directory', async () => {
    const { existsSync } = await import('node:fs');
    const { openDb } = await import('../../commands/memory.js');
    const { db } = await openDb(tmpDir);
    db.close();
    expect(existsSync(join(tmpDir, '.swarm'))).toBe(false);
  });
});
