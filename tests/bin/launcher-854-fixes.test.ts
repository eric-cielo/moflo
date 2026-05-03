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

  it('syncFile records per-file copy failures instead of swallowing them', () => {
    // Pre-#854: the bare `catch { /* non-fatal */ }` meant a Windows file
    // lock / AV race / EBUSY on a single file disappeared silently and the
    // file stayed at its pre-upgrade content forever. The fix records
    // failures so they can be surfaced.
    expect(src).toMatch(/const\s+syncFailures\s*=\s*\[\]/);
    expect(src).toMatch(/syncFailures\.push/);
    // No bare "non-fatal" sync swallow remains in the helper sync block.
    const helperBlock = src.match(/binHelperFiles[\s\S]{0,1500}?sourceHelperFiles/);
    expect(helperBlock, 'helper sync block must exist').toBeTruthy();
    expect(helperBlock![0]).not.toMatch(/catch\s*\{\s*\/\*\s*non-fatal\s*\*\/\s*\}/);
  });

  it('syncFile uses standard retry + circuit breaker for transient errors', () => {
    // Per the codified rule (`.claude/guidance/shipped/moflo-error-handling.md`):
    // any transient-error op MUST use standard retry with exponential backoff
    // and a circuit breaker. One-shot retries are forbidden.
    expect(src).toMatch(/syncWithRetry\s*\(/);
    expect(src).toMatch(/RETRY_BACKOFF_MS\s*=\s*\[\s*50\s*,\s*200\s*,\s*800/);
    expect(src).toMatch(/TRANSIENT_CODES\s*=\s*new\s+Set\(\s*\[\s*['"]EBUSY['"]/);
    expect(src).toMatch(/CIRCUIT_BREAK_THRESHOLD/);
    expect(src).toMatch(/circuitOpen\b/);
  });

  it('syncWithRetry is async — never busy-waits', () => {
    // Sync busy-waits in async ESM are forbidden — pin the async shape
    // so a future "simplification" can't accidentally convert it back.
    expect(src).toMatch(/async\s+function\s+syncWithRetry\s*\(/);
    expect(src).toMatch(/await\s+sleep\s*\(/);
    // The original `delaySync` busy-wait pattern must not creep back.
    expect(src).not.toMatch(/while\s*\(\s*Date\.now\(\)\s*<\s*end\s*\)/);
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
