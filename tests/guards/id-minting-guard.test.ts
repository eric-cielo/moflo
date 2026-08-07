/**
 * Guards the ID-minting consolidation from #1423.
 *
 * Story #801 fixed `agent_spawn` after base-36 slicing of `Math.random()` was
 * observably colliding under burst spawns, and stopped there. ~38 sites kept
 * the pattern, and four separately-written `generateId` helpers accumulated —
 * three of them live and identically named. This test exists so it cannot split
 * a third time.
 *
 * Shape-based, with no allowlist, deliberately: a new site trips it on first
 * use. Note what is NOT banned — plain `Math.random()` is correct and stays in
 * ~120 places (neural weight init, epsilon-greedy exploration, HNSW level
 * selection, benchmark workloads, jitter). Only the base-36-slice idiom, which
 * in this codebase means "mint an identifier", is caught.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateId, randomSuffix } from '../../src/cli/shared/utils/id.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Shipped source. `.claude/scripts/` is a synced mirror of `bin/`, so scanning bin covers it. */
const SHIPPED_ROOTS = ['src/cli', 'bin'];

/** Not shipped: test trees, fixtures, and build output. */
const SKIP_DIR = new Set(['__tests__', 'node_modules', 'dist', 'fixtures']);
const SOURCE_EXT = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

/** `Math.random().toString(36)` in any spacing — the ID-minting idiom. */
const BASE36_SLICE = /Math\s*\.\s*random\s*\(\s*\)\s*\.\s*toString\s*\(\s*36\s*\)/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIR.has(entry)) yield* walk(full);
      continue;
    }
    if (entry.includes('.test.') || entry.includes('.spec.')) continue;
    if (SOURCE_EXT.has(path.extname(entry))) yield full;
  }
}

function shippedSourceFiles(): string[] {
  return SHIPPED_ROOTS.flatMap((rel) => [...walk(path.join(REPO_ROOT, rel))]);
}

describe('#1423 — no ID is minted from Math.random()', () => {
  it('no shipped source file base-36-slices Math.random()', () => {
    const offenders: string[] = [];

    for (const file of shippedSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (BASE36_SLICE.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Mint IDs with generateId()/randomSuffix() from src/cli/shared/utils/id.ts.\n` +
        `This pattern collides — it is what Story #801 observed under burst spawns.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('no shipped source file pairs Date.now() with Math.random() in one template', () => {
    // The same defect written without `.toString(36)` — e.g. a raw
    // `${Date.now()}-${Math.random()}` — would slip past the check above.
    const pattern = /\$\{\s*Date\s*\.\s*now\s*\(\s*\)\s*\}[^`]{0,20}\$\{[^}]*Math\s*\.\s*random/;
    const offenders: string[] = [];

    for (const file of shippedSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe('#1423 — generateId', () => {
  it('mints unique IDs across a burst that Date.now() cannot separate', () => {
    // The failure being guarded against: entities created inside one millisecond
    // sharing an identity. 20k samples in a tight loop spans few enough
    // milliseconds that the timestamp segment is doing almost no work.
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i++) ids.add(generateId('agent'));
    expect(ids.size).toBe(20_000);
  });

  it('defaults to `<prefix>-<millis>-<12 hex>`', () => {
    expect(generateId('swarm')).toMatch(/^swarm-\d{13}-[0-9a-f]{12}$/);
  });

  it('honours the separator, entropy width, and base36 timestamp options', () => {
    expect(generateId('bc', { separator: '_' })).toMatch(/^bc_\d{13}_[0-9a-f]{12}$/);
    expect(generateId('mem', { separator: '_', bytes: 8 })).toMatch(/^mem_\d{13}_[0-9a-f]{16}$/);
    expect(generateId('mem', { base36Time: true })).toMatch(/^mem-[0-9a-z]+-[0-9a-f]{12}$/);
  });

  it('preserves the two persisted ID formats exactly', () => {
    // memory/controllers/_shared.ts and memory/bridge-core.ts write these into
    // .moflo/moflo.db. Their shapes are pinned, not normalised, so an upgrade
    // does not churn consumer state (Rule #2).
    expect(generateId('reflexion', { base36Time: true }))
      .toMatch(/^reflexion-[0-9a-z]{8,}-[0-9a-f]{12}$/);
    expect(generateId('entry', { separator: '_', bytes: 8 }))
      .toMatch(/^entry_\d{13}_[0-9a-f]{16}$/);
  });

  it('randomSuffix returns hex of the requested width and does not repeat', () => {
    expect(randomSuffix()).toMatch(/^[0-9a-f]{12}$/);
    expect(randomSuffix(4)).toMatch(/^[0-9a-f]{8}$/);
    const suffixes = new Set(Array.from({ length: 20_000 }, () => randomSuffix()));
    expect(suffixes.size).toBe(20_000);
  });
});
