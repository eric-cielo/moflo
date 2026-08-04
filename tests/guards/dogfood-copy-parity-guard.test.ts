/**
 * Guard: every dogfood copy under `.claude/` must be byte-identical to the
 * `bin/` file the launcher syncs into it.
 *
 * In a consumer project, `bin/session-start-launcher.mjs` copies itself and its
 * siblings into `.claude/scripts/` and `.claude/helpers/` on session start
 * (`syncFile` → `atomicCopy`, verbatim — no transformation). In moflo's OWN
 * repo that sync is deliberately skipped (#928: the destinations are committed
 * git files and copying `node_modules/moflo` content over them would clobber
 * in-flight work). The consequence is that these copies only ever update when
 * someone edits them by hand — and the dogfood copies are what moflo itself
 * runs.
 *
 * When they drift, moflo runs different code than it ships, which is precisely
 * the environment that is supposed to catch shipping bugs. It had drifted:
 * `.claude/scripts/session-start-launcher.mjs` sat two changes behind `bin/`,
 * missing #1307's `reconcileRetainedRecord` — which runs unconditionally every
 * session — so the dogfood repo silently never reconciled its retained-retired
 * record. Nothing caught it because no test compared the pair.
 *
 * If this goes red, copy the `bin/` file across wholesale. Do not hand-merge,
 * and do not add an exception: a file that legitimately differs does not belong
 * in the synced set at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * Destination → source-root pairs, mirroring what the launcher syncs.
 * `.claude/helpers/` and `.claude/scripts/` both come from `bin/`; their
 * `lib/` and `migrations/` subtrees come from the matching `bin/` subtree.
 */
const SYNCED_TREES: ReadonlyArray<{ dest: string; src: string }> = [
  { dest: '.claude/scripts', src: 'bin' },
  { dest: '.claude/scripts/lib', src: 'bin/lib' },
  { dest: '.claude/scripts/migrations', src: 'bin/migrations' },
  { dest: '.claude/scripts/migrations/lib', src: 'bin/migrations/lib' },
  { dest: '.claude/helpers', src: 'bin' },
];

/** Line endings are normalised: git may check these out as CRLF on Windows. */
function read(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * Every dest file that HAS a bin/ counterpart. A dest file without one is not a
 * dogfood copy at all — `.claude/helpers/statusline.cjs` and the git hooks are
 * sources in their own right — so it is skipped rather than failed.
 */
function syncedPairs(): Array<{ label: string; destPath: string; srcPath: string }> {
  const pairs: Array<{ label: string; destPath: string; srcPath: string }> = [];
  for (const { dest, src } of SYNCED_TREES) {
    const destDir = resolve(REPO_ROOT, dest);
    if (!existsSync(destDir)) continue;
    for (const name of readdirSync(destDir)) {
      const destPath = join(destDir, name);
      if (!statSync(destPath).isFile()) continue;
      const srcPath = resolve(REPO_ROOT, src, name);
      if (!existsSync(srcPath) || !statSync(srcPath).isFile()) continue;
      pairs.push({ label: `${dest}/${name} <- ${src}/${name}`, destPath, srcPath });
    }
  }
  return pairs;
}

describe('dogfood copy parity (bin/ -> .claude/)', () => {
  const pairs = syncedPairs();

  // A guard that silently matched nothing would be worse than no guard: it
  // would go green forever if the mapping above ever stopped resolving.
  it('finds the synced dogfood copies to compare', () => {
    expect(pairs.length).toBeGreaterThan(20);
    expect(pairs.map((p) => p.label)).toContain(
      '.claude/scripts/session-start-launcher.mjs <- bin/session-start-launcher.mjs',
    );
  });

  it.each(pairs.map((p) => [p.label, p] as const))(
    'is byte-identical: %s',
    (_label, pair) => {
      expect(read(pair.destPath)).toBe(read(pair.srcPath));
    },
  );
});
