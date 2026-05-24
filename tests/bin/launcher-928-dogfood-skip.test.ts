/**
 * Regression tests for #928 — drift heal silently reverted committed dogfood
 * edits in moflo's own repo.
 *
 * Symptom in the wild: story #927 grew `.claude/helpers/gate.cjs` from 15,147
 * to 19,379 bytes. The next session-start in moflo's own repo (before publish)
 * saw size mismatch vs the manifest that still pointed at the previously-
 * published 4.9.18 version, classified it as drift, and `copyFileSync`'d
 * `node_modules/moflo/bin/gate.cjs` (= old) over `.claude/helpers/gate.cjs`
 * (= the just-committed #927 content). Working tree silently reverted; only
 * signal was the "📦 install repaired" badge.
 *
 * Fix: when `package.json#name === "moflo"` (i.e. we're running inside the
 * moflo repo itself), `.claude/scripts/`, `.claude/helpers/`, and
 * `.claude/guidance/` are committed git files — they ARE source of truth,
 * not destinations to overwrite. The dogfood guard skips:
 *   - drift detection (size mismatch never triggers "repair")
 *   - file-sync stages (real version-change still recycles daemon + cherry-
 *     picks learnings + queues version stamp, but no copyFileSync runs)
 *
 * Coverage:
 *   - Source-invariant: the guard exists, gates the right paths.
 *   - End-to-end (consumer): drift IS healed — regression guard for normal
 *     consumers who depend on the repair flow.
 *   - End-to-end (moflo): drift is NOT healed — committed edits survive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs';
import { resolve, join } from 'path';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');

function makeTempRoot(label: string): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-launcher-928-' + label + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanTempRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows occasionally holds handles — non-fatal */
  }
}

function runLauncher(cwd: string): { stdout: string; stderr: string; status: number | null } {
  // CLAUDE_PROJECT_DIR anchors the unified findProjectRoot (#1057) on the
  // temp root; without it the walk-up would land on the moflo repo itself.
  const result = spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

/**
 * Stage the exact precondition that triggered the #927 clobber: a tracked
 * destination file exists at one size, the install manifest claims a
 * different size, `node_modules/moflo/bin/<file>` has the old content.
 *
 * Caller passes `pkgName` to choose dogfood vs consumer behavior.
 */
function stageDriftScenario(root: string, pkgName: string) {
  // Project-level package.json — the dogfood guard reads this one.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: pkgName, version: '0.0.0' }));

  // Pretend node_modules/moflo is installed at 4.9.18 with a small gate.cjs.
  const nmDir = join(root, 'node_modules/moflo');
  mkdirSync(join(nmDir, 'bin'), { recursive: true });
  writeFileSync(join(nmDir, 'package.json'), JSON.stringify({ name: 'moflo', version: '4.9.18' }));
  const oldGateContent = '// old gate cjs (4.9.18) — small\nmodule.exports = {};\n';
  writeFileSync(join(nmDir, 'bin/gate.cjs'), oldGateContent);
  // Stub the other bin entries the launcher tries to copy — empty files, so
  // syncFile() finds them and copies (size==0). They're not the focus here.
  for (const f of [
    'hooks.mjs', 'session-start-launcher.mjs', 'index-guidance.mjs',
    'build-embeddings.mjs', 'generate-code-map.mjs', 'semantic-search.mjs',
    'index-tests.mjs', 'index-patterns.mjs', 'index-reference.mjs', 'index-all.mjs',
    'setup-project.mjs', 'run-migrations.mjs', 'session-continuity.mjs',
    'gate-hook.mjs', 'prompt-hook.mjs', 'hook-handler.cjs', 'simplify-classify.cjs',
  ]) {
    writeFileSync(join(nmDir, 'bin', f), '');
  }

  // The launcher reads its sync lists from the canonical manifest in the
  // installed package's bin/lib (#1191). Mirror the real manifest into the fake
  // install so loadShippedScripts resolves the scripts + helpers to copy.
  mkdirSync(join(nmDir, 'bin/lib'), { recursive: true });
  writeFileSync(
    join(nmDir, 'bin/lib/shipped-scripts.json'),
    readFileSync(resolve(__dirname, '../../bin/lib/shipped-scripts.json'), 'utf-8'),
  );

  // Working-tree dogfood-edited gate.cjs — bigger than the 4.9.18 version,
  // simulating a just-committed edit.
  mkdirSync(join(root, '.claude/helpers'), { recursive: true });
  const newGateContent = '// new gate cjs (post-#927) — bigger because the file grew\nmodule.exports = { snapshotSkip: true, branchTrivial: true };\n';
  writeFileSync(join(root, '.claude/helpers/gate.cjs'), newGateContent);

  // Manifest pretends the destination matched the old (4.9.18) size at last
  // sync. Drift detection sees `statSync(dest).size != manifest.size` and
  // triggers the repair path in non-dogfood mode.
  mkdirSync(join(root, '.moflo'), { recursive: true });
  writeFileSync(
    join(root, '.moflo', 'installed-files.json'),
    JSON.stringify([{ path: '.claude/helpers/gate.cjs', size: oldGateContent.length }]),
  );
  // Version stamp matches the installed version → versions are equal, ONLY
  // manifest drift can trigger the repair branch.
  writeFileSync(join(root, '.moflo', 'moflo-version'), '4.9.18');

  return { oldGateContent, newGateContent };
}

describe('session-start-launcher — dogfood drift skip (#928)', () => {
  describe('source-invariant', () => {
    const src = readFileSync(LAUNCHER, 'utf-8');

    it('detects moflo dogfood mode via package.json#name', () => {
      // The guard is named isMofloDogfood and reads the project-level
      // package.json (NOT node_modules/moflo/package.json).
      expect(src).toMatch(/isMofloDogfood/);
      expect(src).toMatch(/projectPkg\?\.\s*name\s*===\s*['"]moflo['"]/);
    });

    it('forces manifestDrifted to false in dogfood mode', () => {
      // After the size-mismatch loop, dogfood override sets manifestDrifted
      // back to false unconditionally — drift heal never fires in our repo.
      expect(src).toMatch(/if\s*\(\s*isMofloDogfood\s*\)\s*manifestDrifted\s*=\s*false/);
    });

    it('skips file-sync stages in dogfood mode but still commits version stamp', () => {
      // The if/else fork wraps the entire manifest-based sync block. Dogfood
      // path commits the version stamp eagerly (so we don't re-enter forever)
      // and emits a visible mutation; consumer path runs the full sync. The
      // stamp commits here on sync success rather than being deferred to the end
      // of §3 — see the eager-commit fix for the "updating…" re-detect loop.
      expect(src).toMatch(/if\s*\(\s*isMofloDogfood\s*\)\s*\{[\s\S]*?commitVersionStamp\(/);
      expect(src).toMatch(/skipped file-sync/);
      expect(src).toMatch(/end !isMofloDogfood file-sync branch/);
    });
  });

  describe('end-to-end', () => {
    let root: string;
    afterEach(() => { if (root) cleanTempRoot(root); });

    it('CONSUMER mode: drift is healed (regression guard for non-moflo consumers)', () => {
      root = makeTempRoot('consumer');
      const { oldGateContent, newGateContent } = stageDriftScenario(root, 'some-consumer-app');

      const result = runLauncher(root);

      // Pre-condition sanity: working-tree gate.cjs started at NEW content.
      // Post-condition: launcher detected drift and reverted it to OLD content.
      const after = readFileSync(join(root, '.claude/helpers/gate.cjs'), 'utf-8');
      expect(after).toBe(oldGateContent);
      expect(after).not.toBe(newGateContent);
      expect(result.stdout).toMatch(/repaired stale install|manifest drift detected/);
    });

    it('DOGFOOD mode: drift is preserved (committed edits survive)', () => {
      root = makeTempRoot('dogfood');
      const { newGateContent } = stageDriftScenario(root, 'moflo');

      const result = runLauncher(root);

      // Working-tree gate.cjs untouched — the whole point of the fix.
      const after = readFileSync(join(root, '.claude/helpers/gate.cjs'), 'utf-8');
      expect(after).toBe(newGateContent);
      // No "install repaired" / "manifest drift" mutation emitted.
      expect(result.stdout).not.toMatch(/repaired stale install/);
      expect(result.stdout).not.toMatch(/manifest drift detected/);
    });

    it('DOGFOOD mode: real version-change still skips file-sync', () => {
      // Stage a version mismatch (cached=4.9.17, installed=4.9.18) — without
      // the dogfood guard the launcher would copy node_modules content over
      // .claude/helpers. With the guard, the upgrade branch enters but the
      // file-sync block is skipped and the dogfood file is preserved.
      root = makeTempRoot('dogfood-vchange');
      const { newGateContent } = stageDriftScenario(root, 'moflo');
      writeFileSync(join(root, '.moflo', 'moflo-version'), '4.9.17'); // force version-change branch

      const result = runLauncher(root);

      const after = readFileSync(join(root, '.claude/helpers/gate.cjs'), 'utf-8');
      expect(after).toBe(newGateContent);
      // The dogfood-skip mutation surfaces so the user sees what happened.
      expect(result.stdout).toMatch(/skipped file-sync/);
      expect(result.stdout).toMatch(/moflo dogfood/);
    });
  });
});
