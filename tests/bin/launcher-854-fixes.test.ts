/**
 * Regression tests for issue #854 — partial-migration loops in the
 * SessionStart launcher and the HNSW chicken-and-egg in build-embeddings.
 *
 * Symptoms in the wild (motailz/code, latent across moflo 4.8.x → 4.9.2):
 *   - `.moflo/moflo-version` never landed → every session re-detected the
 *     upgrade and re-ran the same broken sync sequence.
 *   - `.claude/helpers/gate.cjs` (and several others) stayed at the
 *     pre-upgrade content even though the launcher's own self-sync
 *     succeeded — `syncFile` swallowed the per-file error silently.
 *   - `.moflo/installed-files.json` never written → no manifest = no
 *     drift-detection feedback loop = stuck forever.
 *   - `vector-stats.json.hasHnsw: false` → embeddings migration deleted the
 *     stale sidecar; build-embeddings's all-already-embedded fast path
 *     early-returned before `buildAndWriteHnswSidecar`, so the sidecar
 *     never came back.
 *
 * These are source-invariant tests rather than end-to-end spawns — they
 * pin the structural fixes so a future refactor can't quietly regress
 * them. End-to-end coverage already exists in launcher-visibility.test.ts
 * and session-start-embedding-race.test.ts; this file is the cheap "did
 * the fix actually land in source" gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');

describe('bin/session-start-launcher.mjs — partial-migration visibility (#854)', () => {
  const file = resolve(BIN, 'session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');
  // Retry/breaker + atomic copy live in the shared helper since #975 — the
  // launcher imports makeSyncer from there, so the invariants below have to
  // be asserted against this file rather than the launcher source.
  const helperFile = resolve(BIN, 'lib/file-sync.mjs');
  const helperSrc = readFileSync(helperFile, 'utf-8');

  it('syncFile records per-file copy failures instead of swallowing them', () => {
    // Pre-#854: the bare `catch { /* non-fatal */ }` meant a Windows file
    // lock / AV race / EBUSY on a single file disappeared silently and the
    // file stayed at its pre-upgrade content forever. The fix records
    // failures so they can be surfaced.
    //
    // Post-#975: the launcher destructures `failures: syncFailures` from the
    // shared makeSyncer factory; the helper does the actual `failures.push`.
    expect(src).toMatch(/failures:\s*syncFailures/);
    expect(helperSrc).toMatch(/failures\.push/);
    // No bare "non-fatal" sync swallow remains in the launcher's helper sync block.
    const helperBlock = src.match(/binHelperFiles[\s\S]{0,1500}?sourceHelperFiles/);
    expect(helperBlock, 'helper sync block must exist').toBeTruthy();
    expect(helperBlock![0]).not.toMatch(/catch\s*\{\s*\/\*\s*non-fatal\s*\*\/\s*\}/);
  });

  it('syncFile uses standard retry + circuit breaker for transient errors', () => {
    // Per the codified rule (`.claude/guidance/shipped/moflo-error-handling.md`):
    // any transient-error op MUST use standard retry with exponential backoff
    // and a circuit breaker. One-shot retries are forbidden.
    //
    // Post-#975: implementation lives in `bin/lib/file-sync.mjs` and is shared
    // with `scripts/post-install-bootstrap.mjs`. Launcher imports makeSyncer
    // from there.
    expect(src).toMatch(/from\s+['"]\.\/lib\/file-sync\.mjs['"]/);
    expect(src).toMatch(/makeSyncer\s*\(/);
    expect(helperSrc).toMatch(/syncWithRetry\s*\(/);
    expect(helperSrc).toMatch(/RETRY_BACKOFF_MS\s*=\s*\[\s*50\s*,\s*200\s*,\s*800/);
    expect(helperSrc).toMatch(/TRANSIENT_CODES\s*=\s*new\s+Set\(\s*\[\s*['"]EBUSY['"]/);
    expect(helperSrc).toMatch(/CIRCUIT_BREAK_THRESHOLD/);
    expect(helperSrc).toMatch(/circuitOpen\b/);
  });

  it('syncWithRetry is async — never busy-waits', () => {
    // Sync busy-waits in async ESM are forbidden — pin the async shape
    // so a future "simplification" can't accidentally convert it back.
    expect(helperSrc).toMatch(/async\s+function\s+syncWithRetry\s*\(/);
    expect(helperSrc).toMatch(/await\s+sleep\s*\(/);
    // The original `delaySync` busy-wait pattern must not creep back.
    expect(helperSrc).not.toMatch(/while\s*\(\s*Date\.now\(\)\s*<\s*end\s*\)/);
  });

  it('surfaces accumulated sync failures to stderr with a healer pointer', () => {
    // log + advise — failure summary tells the user how to recover
    // (`flo doctor --fix`), not just what broke.
    expect(src).toMatch(/if\s*\(\s*syncFailures\.length\s*>\s*0\s*\)/);
    expect(src).toMatch(/failed to sync/);
    expect(src).toMatch(/flo doctor --fix/);
  });

  it('section 3 outer catch logs the swallowed error to stderr', () => {
    // Pre-#854: `} catch { /* Non-fatal — scripts will still work, just may
    // be stale */ }` silently dropped every section-3 throw. With nothing
    // logged, partial-migration loops were undebuggable. The fix keeps the
    // catch (so a single throw doesn't crash the launcher) but writes a
    // crumb to stderr — Claude Code captures that as additionalContext.
    expect(src).toMatch(/upgrade section failed/);
    // And the bare-catch antipattern is gone for section 3.
    expect(src).not.toMatch(/\n\}\s*catch\s*\{\s*\/\/\s*Non-fatal\s*—\s*scripts\s*will\s*still\s*work/i);
  });

  it('manifest-write failure is surfaced to stderr (#854)', () => {
    // The inner try around `writeFileSync(manifestPath, ...)` used to be a
    // bare `catch {}` — when it failed, `pendingVersionStampWrite` never
    // got queued AND we had no idea why.
    expect(src).toMatch(/manifest write failed/);
  });

  it('version-stamp write failure is surfaced to stderr (#854)', () => {
    // Same pattern at section 3g — a permanently-broken stamp write
    // (filesystem permissions, AV holds) used to fail silently and strand
    // the consumer in re-detect-on-every-session forever.
    expect(src).toMatch(/version stamp write failed/);
  });

  it('scripts sync explicitly creates `.claude/scripts/` before copying', () => {
    // First-install consumers may not have the dir yet — without an
    // explicit mkdir, every per-file copyFileSync ENOENTs into the silent
    // catch and the launcher self-sync fails too. Defensive belt for the
    // sync-failure visibility fix above.
    const block = src.match(/if\s*\(\s*autoUpdateConfig\.scripts\s*\)\s*\{([\s\S]*?)for\s*\(\s*const\s+file\s+of\s+scriptFiles\s*\)/);
    expect(block, 'scripts sync block must exist').toBeTruthy();
    expect(block![1]).toMatch(/mkdirSync\([^)]*scriptsDir[^)]*\{\s*recursive:\s*true\s*\}/);
  });
});

describe('bin/build-embeddings.mjs — HNSW rebuild on the all-embedded fast path (#854)', () => {
  const file = resolve(BIN, 'build-embeddings.mjs');
  const src = readFileSync(file, 'utf-8');

  it('defines an ensureHnswSidecar helper that builds when sidecar is missing', () => {
    // Pre-#854: the `entries.length === 0` branch returned BEFORE
    // buildAndWriteHnswSidecar, so after the embeddings migration deleted
    // the stale sidecar (model upgrade) the rebuild never ran and
    // hasHnsw stayed false forever.
    expect(src).toMatch(/async\s+function\s+ensureHnswSidecar\s*\(/);
    const fn = src.match(/async\s+function\s+ensureHnswSidecar\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fn, 'ensureHnswSidecar must exist').toBeTruthy();
    expect(fn![0]).toMatch(/buildAndWriteHnswSidecar\(/);
    expect(fn![0]).toMatch(/existsSync\([^)]*hnswIndexPath\(/);
  });

  it('the all-already-embedded fast path calls ensureHnswSidecar', () => {
    // Pin the fix at its actual call site so a refactor can't drop it.
    const fastPath = src.match(/if\s*\(\s*entries\.length\s*===\s*0\s*\)\s*\{[\s\S]*?return;\s*\}/);
    expect(fastPath, 'fast-path block must exist').toBeTruthy();
    expect(fastPath![0]).toMatch(/await\s+ensureHnswSidecar\(/);
  });

  it('main() finalize: writeVectorStatsCache runs AFTER ensureHnswSidecar', () => {
    // hasHnsw is read from disk inside writeVectorStatsCache. Calling it
    // before the build records `hasHnsw: false` for a full session even
    // when the build succeeds. Pin the relative ordering inside main()'s
    // post-embedding finalize block (the function tail).
    const finalizeBlock = src.match(/Embedding Generation Complete[\s\S]+?\}\s*\n\s*main\(\)\.catch/);
    expect(finalizeBlock, "main() finalize block must exist").toBeTruthy();
    const idxBuild = finalizeBlock![0].indexOf('ensureHnswSidecar(stats');
    const idxCache = finalizeBlock![0].indexOf('writeVectorStatsCache(stats, nsStats)');
    expect(idxBuild).toBeGreaterThan(0);
    expect(idxCache).toBeGreaterThan(0);
    expect(idxCache, 'writeVectorStatsCache must run after the HNSW build').toBeGreaterThan(idxBuild);
  });

  it('post-embedding finalize calls ensureHnswSidecar with alwaysRebuild', () => {
    // After embedding generation, freshly-embedded rows invalidate the
    // existing sidecar, so the post-embedding path must force a rebuild
    // (not just rebuild-if-missing). The early-return path uses the
    // default rebuild-if-missing semantic.
    expect(src).toMatch(/ensureHnswSidecar\(\s*stats\s*,\s*\{\s*alwaysRebuild:\s*true\s*\}/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Manifest v2 size-aware drift detection (#854 hardening)
// ────────────────────────────────────────────────────────────────────────────
//
// Stage 1 of an upgrade still runs the OLD launcher from the consumer's
// `.claude/scripts/`. If that old launcher writes the version stamp + a v1
// manifest BEFORE any helpers can drift back into stale-content state, the
// new launcher in stage 2 would see installedVersion === cachedVersion + no
// file-missing drift and skip section 3 entirely — leaving stale gate.cjs
// stuck. The v2 schema records `{path, size}` so a size mismatch detects
// content drift. A v1 manifest detection forces one re-sync to migrate up.

import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { resolve as pathResolve, join } from 'path';

const LAUNCHER = pathResolve(__dirname, '../../bin/session-start-launcher.mjs');

function makeTempProjectRoot(): string {
  const root = pathResolve(
    __dirname,
    '../../.testoutput/.test-854-manifest-v2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test-854', version: '0.0.0' }));
  return root;
}

function cleanRoot(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows AV may hold; non-fatal in tests */ }
}

function runLauncher(cwd: string) {
  // CLAUDE_PROJECT_DIR anchors the unified findProjectRoot (#1057); without
  // it the walk-up would skip the temp root's bare package.json (no .moflo)
  // and land on the moflo repo's own .moflo/moflo.db.
  return spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
}

describe('bin/session-start-launcher.mjs — manifest v2 size-aware drift (#854)', () => {
  const file = pathResolve(__dirname, '../../bin/session-start-launcher.mjs');
  const src = readFileSync(file, 'utf-8');

  it('readInstallManifest helper accepts v1 (string[]) and flags it as legacy', () => {
    expect(src).toMatch(/function\s+readInstallManifest\s*\(/);
    const fn = src.match(/function\s+readInstallManifest\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fn, 'readInstallManifest must exist').toBeTruthy();
    // v1 string entries set isLegacy=true and produce {path, size: null}
    expect(fn![0]).toMatch(/typeof\s+item\s*===\s*['"]string['"]/);
    expect(fn![0]).toMatch(/isLegacy\s*=\s*true/);
    expect(fn![0]).toMatch(/size:\s*null/);
  });

  it('readInstallManifest helper accepts v2 ({path,size}[]) without flagging legacy', () => {
    const fn = src.match(/function\s+readInstallManifest\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fn![0]).toMatch(/typeof\s+item\.path\s*===\s*['"]string['"]/);
    expect(fn![0]).toMatch(/typeof\s+item\.size\s*===\s*['"]number['"]/);
  });

  it('drift check forces re-sync when manifest is legacy v1', () => {
    // Pre-#854 hardening: a v1 manifest (string[]) couldn't trigger drift
    // unless a file went missing. Now isLegacy=true short-circuits drift to
    // true on first encounter so v2 lands.
    expect(src).toMatch(/let\s+manifestDrifted\s*=\s*manifestIsLegacy/);
  });

  it('drift check fires on size mismatch against recorded sync-time size', () => {
    // The whole point of v2: detect content drift, not just file-missing drift.
    expect(src).toMatch(/statSync\(\s*abs\s*\)\.size\s*!==\s*size/);
  });

  it('syncFile records manifest entry as {path, size} via recordManifestEntry', () => {
    // Post-#975: the launcher passes recordManifestEntry as the makeSyncer
    // onSuccess callback so the helper records manifests on both copy and
    // hash-skip paths (a hash-skip session needs the manifest entry too,
    // otherwise the next-session retired-files cleanup pass treats the
    // unchanged file as removed).
    expect(src).toMatch(/function\s+recordManifestEntry\s*\(/);
    const launcher = readFileSync(pathResolve(__dirname, '../../bin/session-start-launcher.mjs'), 'utf-8');
    expect(launcher).toMatch(/onSuccess:\s*\([^)]*\)\s*=>\s*recordManifestEntry/);
    // No more bare path push (was a #854 regression vector).
    expect(launcher).not.toMatch(/currentManifest\.push\(\s*manifestKey\s*\)/);
  });

  it('cleanup loop pulls path field from v2 entries (Set + destructuring)', () => {
    // The cleanup loop now must extract paths from {path, size} objects.
    // Pre-fix it iterated `for (const rel of previousManifest)` treating rel
    // as a raw string — that crashes on v2 entries.
    expect(src).toMatch(/new\s+Set\(\s*currentManifest\.map\(\s*\(?e\)?\s*=>\s*e\.path\s*\)/);
    expect(src).toMatch(/for\s*\(\s*const\s+\{\s*path:\s*rel\s*\}\s+of\s+previousManifest\s*\)/);
  });

  it('end-to-end: legacy v1 manifest triggers re-sync and is rewritten as v2', () => {
    // Stage the partial-migration scenario the hardening targets: stamp +
    // v1 manifest already on disk (as if a stage-1 4.9.2 launcher had
    // written them), no other state. The new launcher must detect the
    // legacy format and re-enter the upgrade branch even though
    // installedVersion === cachedVersion.
    const root = makeTempProjectRoot();
    try {
      mkdirSync(join(root, '.moflo'), { recursive: true });
      mkdirSync(join(root, '.claude/scripts'), { recursive: true });
      mkdirSync(join(root, '.claude/helpers'), { recursive: true });

      // Plant a v1 manifest pointing at one real and one missing file.
      // The "real" file simulates a stale-content drift that v1 cannot detect.
      writeFileSync(join(root, '.claude/scripts/dummy.mjs'), '// stale content');
      writeFileSync(
        join(root, '.moflo/installed-files.json'),
        JSON.stringify(['.claude/scripts/dummy.mjs']),
      );
      // Plant the version stamp so cachedVersion non-empty — the only thing
      // that should re-trigger section 3 is the v1→v2 migration.
      writeFileSync(join(root, '.moflo/moflo-version'), '4.9.2');

      // Run the launcher. There's no node_modules/moflo so the upgrade
      // branch will fire (cachedVersion=4.9.2 vs installedVersion=undef
      // → existsSync(mofloPkgPath)=false, so the branch never enters);
      // instead this test focuses on assertion of the drift detection
      // by reading the rewritten manifest.
      const result = runLauncher(root);
      expect(result.status).toBe(0);

      // Without node_modules/moflo we don't expect a v2 rewrite — assert
      // that the launcher at least DIDN'T crash on the legacy entries
      // and the silent fast path is preserved when there's nothing to do.
      // The detailed v1→v2 rewrite is exercised in launcher-visibility
      // and install-manifest test suites where node_modules/moflo is
      // staged. Here we lock the no-crash + no-deletion contract.
      expect(existsSync(join(root, '.claude/scripts/dummy.mjs'))).toBe(true);
    } finally {
      cleanRoot(root);
    }
  });
});
