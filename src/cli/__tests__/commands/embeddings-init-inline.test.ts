/**
 * Regression tests for #732. The `embeddings init` and `embeddings models -d`
 * actions used to call `embeddings.downloadEmbeddingModel()`, which throws
 * unconditionally because the fastembed-inline runtime auto-fetches on first
 * use. The init command treated the throw as fatal, surfacing
 * `[ERROR] Initialization failed: Explicit model downloads are not supported`
 * to consumers running `doctor --fix`, manual `embeddings init`, or
 * `embeddings models -d <id>`.
 *
 * The fix removes the explicit-download path entirely and lets the runtime
 * fetch on first use. These tests pin that behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initCommand, modelsCommand } from '../../commands/embeddings.js';
import type { CommandContext, ParsedFlags } from '../../types.js';

function makeCtx(flags: ParsedFlags): CommandContext {
  return {
    args: [],
    flags,
    cwd: process.cwd(),
    interactive: false,
  };
}

describe('embeddings init — inline runtime auto-fetch (#732)', () => {
  let originalCwd: string;
  let tmp: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'moflo-embeddings-init-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('default flags (download=true) succeed without throwing', async () => {
    const result = await initCommand.action!(makeCtx({}));
    expect(result.success).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmp, '.moflo', 'embeddings.json'), 'utf-8'));
    expect(cfg.model).toBe('all-MiniLM-L6-v2');
  });

  it('--force over an existing config rewrites and succeeds', async () => {
    await initCommand.action!(makeCtx({}));
    expect(existsSync(join(tmp, '.moflo', 'embeddings.json'))).toBe(true);

    const result = await initCommand.action!(makeCtx({ force: true, model: 'all-mpnet-base-v2' }));
    expect(result.success).toBe(true);
    const cfg = JSON.parse(readFileSync(join(tmp, '.moflo', 'embeddings.json'), 'utf-8'));
    expect(cfg.model).toBe('all-mpnet-base-v2');
    expect(cfg.dimension).toBe(768);
  });

  it('--no-download still succeeds (back-compat)', async () => {
    const result = await initCommand.action!(makeCtx({ download: false }));
    expect(result.success).toBe(true);
  });
});

describe('embeddings models -d — inline runtime auto-fetch (#732)', () => {
  it('returns success with a friendly auto-fetch message', async () => {
    const result = await modelsCommand.action!(makeCtx({ download: 'all-MiniLM-L6-v2' }));
    expect(result.success).toBe(true);
  });
});

describe('downloadEmbeddingModel removed (#732 drift guard)', () => {
  it('is no longer exported from embeddings/index', async () => {
    const mod = await import('../../embeddings/index.js') as Record<string, unknown>;
    expect(mod.downloadEmbeddingModel).toBeUndefined();
  });

  it('is not referenced anywhere in src/', () => {
    // Pure-fs scan matching the established drift-guard pattern in
    // services/published-package-drift-guard.test.ts (no shell-out, no git
    // dependency, cross-platform).
    const repoRoot = findRepoRoot();
    const offenders: string[] = [];
    for (const file of walkSrc(join(repoRoot, 'src'))) {
      const text = readFileSync(file, 'utf-8');
      if (text.includes('downloadEmbeddingModel')) {
        offenders.push(file.replace(repoRoot, '').replace(/\\/g, '/'));
      }
    }
    expect(offenders, 'downloadEmbeddingModel must have zero src references').toEqual([]);
  });
});

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'cli'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate moflo repo root from drift guard test.');
}

function* walkSrc(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSrc(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(m?ts|m?js)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (statSync(full).size > 5_000_000) continue;
    yield full;
  }
}
