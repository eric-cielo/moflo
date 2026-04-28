/**
 * Path-hygiene test for the deployed `.claude/helpers/statusline.cjs` (#639).
 *
 * The migration commit that renamed runtime state from `.claude-flow/` to
 * `.moflo/` (PR #706) missed this file. The bug was that statusline read
 * `.claude-flow/vector-stats.json` (legacy) before `.moflo/vector-stats.json`
 * (canonical), so when a different writer left a stale `vectorCount: 0` in
 * the legacy path the statusline displayed `Vectors ●0` despite the live DB
 * having thousands of embedded rows.
 *
 * This test guards against the file regressing: it must contain zero
 * `.claude-flow/` references and must read the `.moflo/` cache before the
 * `.swarm/` fallback.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STATUSLINE = resolve(__dirname, '../../../.claude/helpers/statusline.cjs');

describe('.claude/helpers/statusline.cjs — post-#699 path hygiene (#639)', () => {
  const source = readFileSync(STATUSLINE, 'utf-8');

  it('contains zero `.claude-flow/` path references', () => {
    const matches = source.match(/\.claude-flow\b/g) ?? [];
    expect(matches).toHaveLength(0);
  });

  it('reads the `.moflo/vector-stats.json` cache before the `.swarm/` fallback', () => {
    const mofloIdx = source.indexOf("'.moflo', 'vector-stats.json'");
    const swarmIdx = source.indexOf("'.swarm', 'vector-stats.json'");
    expect(mofloIdx).toBeGreaterThanOrEqual(0);
    expect(swarmIdx).toBeGreaterThanOrEqual(0);
    expect(mofloIdx).toBeLessThan(swarmIdx);
  });
});
