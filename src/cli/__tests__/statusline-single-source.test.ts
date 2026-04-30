/**
 * Drift guard for #715 — `.claude/helpers/statusline.cjs` is the single
 * source of truth for the consumer's statusline. The previous structure
 * also had a `src/cli/init/statusline-generator.ts` that produced the same
 * file as a template string at init time; the two were not kept in sync,
 * which is exactly how PR #706 introduced the path-mismatch that produced
 * #639.
 *
 * If a future change re-introduces a generator (or another `statusline.cjs`
 * source), this test fails — re-think the approach instead of re-creating
 * the divergence.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

describe('statusline.cjs — single source of truth (#715)', () => {
  it('does not have any statusline generator under src/cli/init/', () => {
    const initDir = join(REPO_ROOT, 'src', 'cli', 'init');
    const offenders = readdirSync(initDir).filter((name) =>
      /^statusline.*generator/i.test(name),
    );
    expect(offenders).toEqual([]);
  });

  it('ships a static .claude/helpers/statusline.cjs', () => {
    expect(existsSync(join(REPO_ROOT, '.claude', 'helpers', 'statusline.cjs'))).toBe(true);
  });
});
