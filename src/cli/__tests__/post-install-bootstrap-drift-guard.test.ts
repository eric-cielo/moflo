/**
 * Postinstall bootstrap drift guard (#857).
 *
 * `scripts/post-install-bootstrap.mjs` and `bin/session-start-launcher.mjs`
 * each carry their own copy of the consumer-mirror sync lists (scripts,
 * bin-helpers, source-helpers). Both are load-bearing on every install:
 *
 *   - The launcher syncs at session-start (regular path, healthy consumer).
 *   - The bootstrap syncs at npm postinstall (#857 path, recovers consumers
 *     stuck on a pre-#854 launcher that can't replace itself).
 *
 * If either drifts, an upgrade ships an inconsistent set of files. This
 * test parses both files and asserts the lists are identical, plus that
 * every entry actually exists on disk.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

async function loadBootstrapLists() {
  // Dynamic import — the script is ESM and we want its real exported arrays
  // so a typo'd export name fails the test rather than silently skipping.
  const mod = await import(
    /* @vite-ignore */ pathToImport(join(REPO_ROOT, 'scripts/post-install-bootstrap.mjs'))
  );
  return {
    scripts: mod.SCRIPT_FILES as string[],
    binHelpers: mod.BIN_HELPER_FILES as string[],
    sourceHelpers: mod.SOURCE_HELPER_FILES as string[],
  };
}

function pathToImport(absPath: string): string {
  // vitest can resolve absolute paths on Windows when given a file URL;
  // a raw `C:\…` path triggers ERR_UNSUPPORTED_ESM_URL_SCHEME.
  return new URL(`file:///${absPath.replace(/\\/g, '/').replace(/^\/+/, '')}`).href;
}

function extractArrayLiteral(source: string, declarationToken: string): string[] {
  // Find the `<token> = [ ... ];` block and return the string contents in order.
  const idx = source.indexOf(declarationToken);
  if (idx === -1) {
    throw new Error(`drift-guard: '${declarationToken}' not found in launcher source`);
  }
  const open = source.indexOf('[', idx);
  const close = source.indexOf(']', open);
  if (open === -1 || close === -1) {
    throw new Error(`drift-guard: malformed array after '${declarationToken}'`);
  }
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]);
}

function loadLauncherLists() {
  const launcherPath = join(REPO_ROOT, 'bin/session-start-launcher.mjs');
  const src = readFileSync(launcherPath, 'utf-8');
  return {
    scripts: extractArrayLiteral(src, 'const scriptFiles ='),
    binHelpers: extractArrayLiteral(src, 'const binHelperFiles ='),
    sourceHelpers: extractArrayLiteral(src, 'const sourceHelperFiles ='),
  };
}

describe('post-install-bootstrap drift guard (#857)', () => {
  it('SCRIPT_FILES matches launcher §3 scriptFiles', async () => {
    const bootstrap = await loadBootstrapLists();
    const launcher = loadLauncherLists();
    expect(bootstrap.scripts).toEqual(launcher.scripts);
  });

  it('BIN_HELPER_FILES matches launcher §3 binHelperFiles', async () => {
    const bootstrap = await loadBootstrapLists();
    const launcher = loadLauncherLists();
    expect(bootstrap.binHelpers).toEqual(launcher.binHelpers);
  });

  it('SOURCE_HELPER_FILES matches launcher §3 sourceHelperFiles', async () => {
    const bootstrap = await loadBootstrapLists();
    const launcher = loadLauncherLists();
    expect(bootstrap.sourceHelpers).toEqual(launcher.sourceHelpers);
  });

  it('every SCRIPT_FILES entry exists in bin/', async () => {
    const { scripts } = await loadBootstrapLists();
    const missing = scripts.filter((f) => !existsSync(resolve(REPO_ROOT, 'bin', f)));
    expect(missing, `bin/ missing scripts referenced by bootstrap: ${missing.join(', ')}`).toEqual([]);
  });

  it('every BIN_HELPER_FILES entry exists in bin/', async () => {
    const { binHelpers } = await loadBootstrapLists();
    const missing = binHelpers.filter((f) => !existsSync(resolve(REPO_ROOT, 'bin', f)));
    expect(missing, `bin/ missing helpers referenced by bootstrap: ${missing.join(', ')}`).toEqual([]);
  });

  it('every SOURCE_HELPER_FILES entry exists in .claude/helpers/', async () => {
    const { sourceHelpers } = await loadBootstrapLists();
    const missing = sourceHelpers.filter(
      (f) => !existsSync(resolve(REPO_ROOT, '.claude/helpers', f)),
    );
    expect(missing, `.claude/helpers/ missing entries referenced by bootstrap: ${missing.join(', ')}`).toEqual([]);
  });

  it('package.json postinstall chains the bootstrap script', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts.postinstall).toContain('post-install-bootstrap.mjs');
  });

  it('package.json files[] ships the bootstrap script', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('scripts/post-install-bootstrap.mjs');
  });
});
