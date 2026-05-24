/**
 * Tests for bin/lib/ subdirectory sync in session-start-launcher.mjs and executor.ts
 *
 * Validates that:
 * 1. hooks.mjs can import ./lib/process-manager.mjs when lib/ is synced
 * 2. session-start-launcher syncs bin/lib/ to .claude/scripts/lib/
 * 3. executor.ts upgrade path syncs bin/lib/ to .claude/scripts/lib/
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

function makeTempRoot(): string {
  const root = resolve(__dirname, '../../.testoutput/.test-lib-sync-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(resolve(root, '.moflo'), { recursive: true });
  mkdirSync(resolve(root, '.claude/scripts'), { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
}

/**
 * Statically extract the set of named ES-module exports from source, without
 * executing it. Covers every export form moflo's bin/lib uses today plus the
 * common ones (default, grouped, class) so a NEW export style added to bin/ but
 * not propagated to the twin still trips the parity check instead of silently
 * passing.
 *
 * Deliberately a text parser, not a dynamic import(): several bin/lib modules
 * have import-time side effects (suppress-sqlite-warning patches process
 * warnings; daemon/db helpers touch the filesystem) that must not run inside a
 * unit test.
 */
function extractNamedExports(src: string): string[] {
  const names = new Set<string>();
  // export [async] function[*] NAME | export class NAME | export const|let|var NAME
  const declRe = /\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) names.add(m[1]);
  // export default ...
  if (/\bexport\s+default\b/.test(src)) names.add('default');
  // export { a, b as c, type T } — capture the exported binding name
  const groupRe = /\bexport\s*\{([^}]*)\}/g;
  while ((m = groupRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg || seg.startsWith('type ')) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch ? asMatch[1] : seg.replace(/^type\s+/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

describe('bin/lib/ subdirectory sync', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  it('lib/ directory exists in bin/ source with required files', () => {
    const binLibDir = resolve(__dirname, '../../bin/lib');
    expect(existsSync(binLibDir)).toBe(true);

    const files = readdirSync(binLibDir);
    expect(files).toContain('process-manager.mjs');
    expect(files).toContain('registry-cleanup.cjs');
  });

  it('hooks.mjs imports ./lib/process-manager.mjs', () => {
    const hooksPath = resolve(__dirname, '../../bin/hooks.mjs');
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content).toContain('./lib/process-manager.mjs');
  });

  it('session-start-launcher.mjs syncs lib/ subdirectory', () => {
    const launcherPath = resolve(__dirname, '../../bin/session-start-launcher.mjs');
    const content = readFileSync(launcherPath, 'utf-8');

    // Verify the launcher has the lib/ sync logic
    expect(content).toContain("resolve(binDir, 'lib')");
    expect(content).toContain("resolve(scriptsDir, 'lib')");
  });

  it('executor.ts syncs lib/ subdirectory during upgrade', () => {
    const executorPath = resolve(__dirname, '../../src/cli/init/executor.ts');
    const content = readFileSync(executorPath, 'utf-8');

    // Verify the executor has the lib/ sync logic
    expect(content).toContain("path.join(binDir, 'lib')");
    expect(content).toContain("path.join(scriptsDir, 'lib')");
  });

  it('simulates lib/ sync and verifies all files are copied', () => {
    // Create a fake bin/lib/ source
    const fakeBinLib = join(root, 'bin', 'lib');
    mkdirSync(fakeBinLib, { recursive: true });
    writeFileSync(join(fakeBinLib, 'process-manager.mjs'), 'export function spawn() {}');
    writeFileSync(join(fakeBinLib, 'registry-cleanup.cjs'), 'module.exports = {}');
    writeFileSync(join(fakeBinLib, 'moflo-resolve.mjs'), 'export function resolve() {}');

    // Simulate the sync logic from session-start-launcher.mjs
    const libSrcDir = fakeBinLib;
    const libDestDir = join(root, '.claude', 'scripts', 'lib');
    if (!existsSync(libDestDir)) mkdirSync(libDestDir, { recursive: true });
    for (const file of readdirSync(libSrcDir)) {
      const src = join(libSrcDir, file);
      const dest = join(libDestDir, file);
      writeFileSync(dest, readFileSync(src));
    }

    // Verify all files synced
    expect(existsSync(join(libDestDir, 'process-manager.mjs'))).toBe(true);
    expect(existsSync(join(libDestDir, 'registry-cleanup.cjs'))).toBe(true);
    expect(existsSync(join(libDestDir, 'moflo-resolve.mjs'))).toBe(true);
  });
});

describe('bin/lib ↔ .claude/scripts/lib committed twin parity (#1196/#1205 launcher-crash guard)', () => {
  // The launcher runs from .claude/scripts/ and statically imports ./lib/*.mjs.
  // In the dogfood repo the launcher's own bin/lib→.claude/scripts/lib sync is
  // SKIPPED (committed dogfood copies are preserved), so the two trees are
  // hand-maintained twins that silently drift. Two drift modes have each shipped
  // a crash-dead launcher — caught here so neither recurs:
  //   #1196 — a MISSING twin (.claude/scripts/lib/internal-skills.mjs absent)
  //   #1205 — a twin that exists but DROPS a named export the launcher imports
  //           (.claude/scripts/lib/file-sync.mjs lacked syncDirRecursive) → an
  //           ESM SyntaxError at link time kills the module before any statement
  //           (even the diagnostic boot probe) runs.
  const binLibDir = resolve(__dirname, '../../bin/lib');
  const scriptsLibDir = resolve(__dirname, '../../.claude/scripts/lib');

  it('every bin/lib file is mirrored as a committed .claude/scripts/lib twin', () => {
    const missing = readdirSync(binLibDir).filter((f) => !existsSync(join(scriptsLibDir, f)));
    expect(missing, `bin/lib files with no .claude/scripts/lib twin: ${missing.join(', ')}`).toEqual([]);
  });

  it('every .mjs twin exports the exact same named exports as its bin/lib source', () => {
    const drift: string[] = [];
    for (const file of readdirSync(binLibDir).filter((f) => f.endsWith('.mjs'))) {
      const twin = join(scriptsLibDir, file);
      if (!existsSync(twin)) continue; // presence asserted by the test above
      const want = extractNamedExports(readFileSync(join(binLibDir, file), 'utf-8'));
      const got = extractNamedExports(readFileSync(twin, 'utf-8'));
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        const lost = want.filter((n) => !got.includes(n));
        const extra = got.filter((n) => !want.includes(n));
        drift.push(`${file}: missing=[${lost.join(',')}] extra=[${extra.join(',')}]`);
      }
    }
    expect(drift, `export-signature drift between bin/lib and .claude/scripts/lib:\n${drift.join('\n')}`).toEqual([]);
  });
});
