/**
 * Path-hygiene test for the deployed `.claude/helpers/statusline.cjs`.
 *
 * Two regression bands are guarded here:
 *
 * 1. #639 / #706 — the rename from `.claude-flow/` to `.moflo/` must stay
 *    complete. A `.claude-flow/` reference creeping back in would resurface
 *    the original bug where stale legacy files masked the canonical count.
 *
 * 2. #714 — the `.swarm/vector-stats.json` parallel read was retired now
 *    that every writer (bridge-core, memory-initializer, build-embeddings)
 *    targets `.moflo/` only. A `.swarm/vector-stats.json` reference creeping
 *    back in would re-introduce the divergence trap that produced #639.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STATUSLINE = resolve(__dirname, '../../../.claude/helpers/statusline.cjs');

describe('.claude/helpers/statusline.cjs — vector-stats path hygiene', () => {
  const source = readFileSync(STATUSLINE, 'utf-8');

  it('contains zero `.claude-flow/` path references (#639/#706)', () => {
    const matches = source.match(/\.claude-flow\b/g) ?? [];
    expect(matches).toHaveLength(0);
  });

  it('reads `.moflo/vector-stats.json` and never `.swarm/vector-stats.json` (#714)', () => {
    expect(source).toContain("'.moflo', 'vector-stats.json'");
    expect(source).not.toContain("'.swarm', 'vector-stats.json'");
  });
});
