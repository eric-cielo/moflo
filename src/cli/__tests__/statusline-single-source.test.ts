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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const REPO_ROOT = findRepoRoot();

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
