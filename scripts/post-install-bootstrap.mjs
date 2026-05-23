#!/usr/bin/env node
/**
 * Postinstall self-update bootstrap (#857).
 *
 * Problem this solves:
 *   The launcher in <consumer>/.claude/scripts/session-start-launcher.mjs
 *   is responsible for copying itself + helpers from node_modules/moflo/
 *   on every upgrade. Pre-#854 launchers wrap each copyFileSync in a bare
 *   `catch { /* non-fatal *\/ }` and can't reliably replace themselves on
 *   Windows under file-lock contention (EBUSY/EPERM/EACCES from concurrent
 *   helper invocation, AV real-time scan, npm verification handles).
 *
 *   The fix for that lives in the new launcher (#854/#855), but the old
 *   launcher has to work to deploy the new one. It doesn't, and consumers
 *   stay stuck across 8+ version bumps until manually unstuck.
 *
 * Fix:
 *   This script runs at npm postinstall — driven by npm, not by the broken
 *   launcher — and copies bin/ scripts + helpers DIRECTLY into the
 *   consumer's .claude/scripts/ and .claude/helpers/. After the bootstrap
 *   runs, the next session-start launches the NEW launcher, which then
 *   handles the rest of the upgrade work (guidance sync, manifest, version
 *   stamp, daemon recycle, HNSW rebuild).
 *
 *   The bootstrap only has to do enough to break the deadlock.
 *
 * The lists below MUST stay aligned with bin/session-start-launcher.mjs
 * section 3 (the launcher's own sync). A unit test asserts list parity
 * (mcp-tools-drift-guard pattern). See SCRIPT_FILES / BIN_HELPER_FILES /
 * SOURCE_HELPER_FILES exports.
 *
 * Failure posture:
 *   - Surface per-file failures on stderr with `flo doctor --fix` advice
 *   - Skip silently if <consumer>/.claude doesn't exist (consumer hasn't
 *     run `flo init` yet — bootstrap is a no-op for first-time installs)
 *   - Never exit non-zero (postinstall failures block npm install)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errMessage, makeSyncer } from '../bin/lib/file-sync.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MOFLO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

// ── Sync lists — keep in lockstep with bin/session-start-launcher.mjs §3 ─────
//
// Drift guard: tests/unit/post-install-bootstrap-drift.test.ts asserts these
// arrays match the launcher's section-3 sync lists by parsing both files.

export const SCRIPT_FILES = [
  'hooks.mjs',
  'session-start-launcher.mjs',
  'index-guidance.mjs',
  'build-embeddings.mjs',
  'generate-code-map.mjs',
  'semantic-search.mjs',
  'index-tests.mjs',
  'index-patterns.mjs',
  'index-reference.mjs',
  'index-all.mjs',
  'setup-project.mjs',
  'run-migrations.mjs',
];

export const BIN_HELPER_FILES = [
  'gate.cjs',
  'gate-hook.mjs',
  'prompt-hook.mjs',
  'hook-handler.cjs',
  'simplify-classify.cjs',
];

export const SOURCE_HELPER_FILES = [
  'auto-memory-hook.mjs',
  'statusline.cjs',
  'intelligence.cjs',
  'subagent-start.cjs',
  'subagent-bootstrap.json',
  'pre-commit',
  'post-commit',
];

// ── Retry + atomic copy + circuit breaker (#854 / #975) ─────────────────────
//
// Implementation lives in `bin/lib/file-sync.mjs` so the launcher's section 3
// shares the same hash-skip + atomic + verify path. Backoff [50,200,800]ms
// covers Windows EBUSY windows from concurrent helper invocation + AV scan;
// breaker opens after 5 distinct exhausted-retry failures.

// ── Project root discovery ──────────────────────────────────────────────────
//
// npm sets INIT_CWD to the directory where the user originally ran
// `npm install`. That's the consumer's project root regardless of which
// package's postinstall is running. Falls back to cwd for direct execution.

function consumerProjectRoot() {
  return process.env.INIT_CWD || process.cwd();
}

// ── Main bootstrap ──────────────────────────────────────────────────────────

export async function runBootstrap({
  projectRoot = consumerProjectRoot(),
  mofloRoot = MOFLO_ROOT,
  log = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  const claudeDir = resolve(projectRoot, '.claude');
  if (!existsSync(claudeDir)) {
    return { ran: false, reason: 'no-claude-dir' };
  }

  // moflo's own dogfood install: don't bootstrap into the source repo.
  // The source repo's .claude/ IS the truth source — we'd be copying
  // the very files we just built ON TOP of themselves, which on Windows
  // hits the same file-lock issues we're trying to avoid.
  //
  // Two paths can hit this branch:
  //   1. The source's own postinstall: mofloRoot === projectRoot (path equality).
  //   2. The DEPENDENCY's postinstall on `npm ci` of the moflo source repo:
  //      mofloRoot = <src>/node_modules/moflo/, projectRoot = <src>/. Path
  //      equality fails — moflo-as-its-own-devDep would clobber the source
  //      .claude/helpers/ with the OLDER published artifacts, breaking CI
  //      against any in-flight fixes. Detect by reading projectRoot's
  //      package.json name and bailing whenever it's "moflo".
  if (resolve(projectRoot) === resolve(mofloRoot)) {
    return { ran: false, reason: 'moflo-self-install' };
  }
  try {
    const projectPkgPath = resolve(projectRoot, 'package.json');
    if (existsSync(projectPkgPath)) {
      const projectPkg = JSON.parse(readFileSync(projectPkgPath, 'utf-8'));
      if (projectPkg.name === 'moflo') {
        return { ran: false, reason: 'moflo-self-dev-install' };
      }
    }
  } catch { /* unparseable package.json — fall through, treat as consumer */ }

  const binDir = resolve(mofloRoot, 'bin');
  if (!existsSync(binDir)) {
    return { ran: false, reason: 'no-bin-dir' };
  }

  const { syncFile, failures } = makeSyncer();
  let synced = 0;

  // 1. Top-level scripts → .claude/scripts/
  const scriptsDir = resolve(claudeDir, 'scripts');
  if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
  for (const file of SCRIPT_FILES) {
    const result = await syncFile(
      resolve(binDir, file),
      resolve(scriptsDir, file),
      `.claude/scripts/${file}`,
    );
    if (result.ok) synced++;
  }

  // 2. bin/lib/ → .claude/scripts/lib/ (read entire dir)
  const libSrcDir = resolve(binDir, 'lib');
  const libDestDir = resolve(scriptsDir, 'lib');
  if (existsSync(libSrcDir)) {
    if (!existsSync(libDestDir)) mkdirSync(libDestDir, { recursive: true });
    let libEntries;
    try {
      libEntries = readdirSync(libSrcDir);
    } catch (err) {
      log(`bootstrap: lib readdir failed (${errMessage(err)})`);
      libEntries = [];
    }
    for (const file of libEntries) {
      const src = resolve(libSrcDir, file);
      try {
        if (!statSync(src).isFile()) continue;
      } catch { continue; }
      const result = await syncFile(src, resolve(libDestDir, file), `.claude/scripts/lib/${file}`);
      if (result.ok) synced++;
    }
  }

  // 3. bin/migrations/ → .claude/scripts/migrations/ (recursive)
  const migrationsSrcDir = resolve(binDir, 'migrations');
  const migrationsDestDir = resolve(scriptsDir, 'migrations');
  if (existsSync(migrationsSrcDir)) {
    if (!existsSync(migrationsDestDir)) mkdirSync(migrationsDestDir, { recursive: true });
    let migEntries;
    try {
      migEntries = readdirSync(migrationsSrcDir, { recursive: true, withFileTypes: true });
    } catch (err) {
      log(`bootstrap: migrations readdir failed (${errMessage(err)})`);
      migEntries = [];
    }
    for (const entry of migEntries) {
      if (!entry.isFile()) continue;
      const parent = entry.parentPath || entry.path || migrationsSrcDir;
      const absSrc = resolve(parent, entry.name);
      const rel = absSrc.slice(migrationsSrcDir.length + 1).split(/[\\/]/).join('/');
      const result = await syncFile(absSrc, resolve(migrationsDestDir, rel), `.claude/scripts/migrations/${rel}`);
      if (result.ok) synced++;
    }
  }

  // 4. bin/ helpers → .claude/helpers/
  const helpersDir = resolve(claudeDir, 'helpers');
  if (!existsSync(helpersDir)) mkdirSync(helpersDir, { recursive: true });
  for (const file of BIN_HELPER_FILES) {
    const result = await syncFile(
      resolve(binDir, file),
      resolve(helpersDir, file),
      `.claude/helpers/${file}`,
    );
    if (result.ok) synced++;
  }

  // 5. moflo's own .claude/helpers/ → consumer .claude/helpers/
  // (these never lived in bin/ — they're shipped via .claude/helpers/** in files[])
  const sourceHelpersDir = resolve(mofloRoot, '.claude/helpers');
  if (existsSync(sourceHelpersDir)) {
    for (const file of SOURCE_HELPER_FILES) {
      const src = resolve(sourceHelpersDir, file);
      if (!existsSync(src)) continue;
      const result = await syncFile(src, resolve(helpersDir, file), `.claude/helpers/${file}`);
      if (result.ok) synced++;
    }
  }

  // Surface failures so npm log + Claude relay catches them, with the same
  // healer advice the launcher uses.
  if (failures.length > 0) {
    const sample = failures.slice(0, 5).map((f) => `  - ${f.key}: ${f.message}`).join('\n');
    const more = failures.length > 5 ? `\n  …and ${failures.length - 5} more` : '';
    log(
      `moflo: postinstall bootstrap left ${failures.length} file(s) unsynced — run 'flo doctor --fix' to repair:\n${sample}${more}`,
    );

    // #975: write a sentinel that session-start picks up so the user gets a
    // visible "upgrade left work undone" prompt instead of a silent stale
    // launcher. The bootstrap's stderr alone is buried in `npm install`
    // output noise. Best-effort write — we never block install on this.
    try {
      const mofloDir = resolve(projectRoot, '.moflo');
      mkdirSync(mofloDir, { recursive: true });
      let mofloVersion = 'unknown';
      try {
        const pkgPath = resolve(mofloRoot, 'package.json');
        if (existsSync(pkgPath)) {
          mofloVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version || 'unknown';
        }
      } catch { /* version is informational only */ }
      const sentinel = {
        timestamp: new Date().toISOString(),
        mofloVersion,
        failures: failures.map((f) => ({
          key: f.key,
          message: f.message,
          src: f.src,
          dest: f.dest,
        })),
      };
      writeFileSync(
        resolve(mofloDir, 'bootstrap-failed.json'),
        JSON.stringify(sentinel, null, 2),
        'utf-8',
      );
    } catch { /* sentinel write must not block install */ }
  }

  return { ran: true, synced, failed: failures.length, failures };
}

// ── Entry point ─────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBootstrap()
    .catch((err) => {
      // Never block install. Log and exit 0.
      process.stderr.write(`moflo: bootstrap failed (${errMessage(err)})\n`);
    })
    .finally(() => process.exit(0));
}
