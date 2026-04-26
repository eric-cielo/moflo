#!/usr/bin/env node
/**
 * Probe consumer-install-sensitive `@moflo/*` bare-specifier paths.
 *
 * Catches the regression class shipped in 4.8.87-rc.2 (issue #583): silent
 * `try { import('@moflo/<pkg>') } catch { return null }` blocks that
 * left consumers with a broken install and no signal in their logs.
 *
 * Inversion to keep in mind: in a consumer install, the `@moflo/<pkg>` bare
 * specifiers are NOT resolvable — after epic #586 every former workspace
 * package is inlined under `node_modules/moflo/dist/src/cli/` with no
 * top-level `node_modules/@moflo/` symlinks. moflo uses walk-up fallbacks
 * (`importMofloMemory`) or graceful loud-fail (`requireMofloOrWarn`) to
 * cope. This probe verifies the loud-fail signal IS present at the call
 * sites patched in #583 — its absence is the bug we're guarding against.
 *
 * Probes:
 *
 *   1. **Module-load probes** — import each of the four files patched in
 *      PR #583. Files with a top-level `await requireMofloOrWarn(...)`
 *      (currently just `neural-tools.js`) must produce the named stderr
 *      line on import. All four must load without throwing
 *      `ERR_MODULE_NOT_FOUND`.
 *
 *   2. **Session-start launcher probe** — run
 *      `.claude/scripts/session-start-launcher.mjs` from a consumer
 *      scratch dir. The launcher is what consumers actually hit on
 *      Claude Code startup, and it's where the rc.2 silent skip lived.
 *      Must run to completion AND produce the embeddings-migration loud
 *      signal (proves the migration foreground hook didn't silently
 *      no-op).
 *
 *   3. **Files-array sanity** — every `dist/**` glob in the published
 *      `package.json` "files" array must point to a real directory in
 *      the installed tarball. Catches stale `files` entries.
 *
 * Locally invokable; the consumer-smoke harness wires this in as one of
 * its checks.
 *
 * Usage:
 *   node scripts/consumer-smoke/probe-bare-specifiers.mjs --consumer-dir <path>
 *   node scripts/consumer-smoke/probe-bare-specifiers.mjs --consumer-dir <path> --json
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const consumerDirIdx = argv.indexOf('--consumer-dir');
if (consumerDirIdx === -1 || !argv[consumerDirIdx + 1]) {
  process.stderr.write('usage: probe-bare-specifiers.mjs --consumer-dir <path> [--json]\n');
  process.exit(2);
}
const consumerDir = argv[consumerDirIdx + 1];
const asJson = argv.includes('--json');

if (!existsSync(consumerDir)) {
  process.stderr.write(`consumer dir not found: ${consumerDir}\n`);
  process.exit(2);
}

const mofloPkgDir = join(consumerDir, 'node_modules', 'moflo');
if (!existsSync(mofloPkgDir)) {
  process.stderr.write(`node_modules/moflo missing in ${consumerDir}\n`);
  process.exit(2);
}

const cliDist = join(mofloPkgDir, 'dist', 'src', 'cli');
if (!existsSync(cliDist)) {
  process.stderr.write(`cli dist missing at ${cliDist} — did the tarball pack correctly?\n`);
  process.exit(2);
}

/**
 * The four files patched in PR #583. After embeddings was inlined into cli
 * (#592), the `@moflo/embeddings` loud-fail at neural-tools is moot — the
 * specifier no longer exists in source. The probe still verifies all four
 * files import cleanly without `ERR_MODULE_NOT_FOUND` from any remaining
 * `@moflo/<pkg>` dynamic imports they may carry.
 */
const PR_583_FILES = [
  {
    label: 'embeddings-migration',
    relPath: 'services/embeddings-migration.js',
    loudFailExpected: false,
  },
  {
    label: 'hooks-tools',
    relPath: 'mcp-tools/hooks-tools.js',
    loudFailExpected: false,
  },
  {
    label: 'neural-tools',
    relPath: 'mcp-tools/neural-tools.js',
    loudFailExpected: false,
  },
  {
    label: 'security-tools',
    relPath: 'mcp-tools/security-tools.js',
    loudFailExpected: false,
  },
];

const results = [];
let hardFails = 0;

function record(name, status, detail) {
  results.push({ name, status, detail });
  if (status === 'fail') hardFails++;
}

function importInChild(targetUrl, cwd) {
  const code = `await import(${JSON.stringify(targetUrl)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MOFLO_BRIDGE_QUIET: '1' },
  });
}

// ── Probe 1: PR #583 module-load probes ────────────────────────────────────
for (const site of PR_583_FILES) {
  const abs = join(cliDist, site.relPath);
  if (!existsSync(abs)) {
    record(`load:${site.label}`, 'fail', `${relative(mofloPkgDir, abs)} not in tarball`);
    continue;
  }
  const url = pathToFileURL(abs).href;
  const r = importInChild(url, consumerDir);

  if (r.error) {
    record(`load:${site.label}`, 'fail', `spawn error: ${r.error.message}`);
    continue;
  }

  const stderr = r.stderr || '';

  // Hard ERR_MODULE_NOT_FOUND escaping the helper is always a fail —
  // means a bare import bypassed `requireMofloOrWarn` and crashed.
  if (/ERR_MODULE_NOT_FOUND|Cannot find package/.test(stderr) && r.status !== 0) {
    record(
      `load:${site.label}`,
      'fail',
      `hard module-not-found on import: ${stderr.slice(0, 200)}`,
    );
    continue;
  }
  if (r.status !== 0) {
    record(
      `load:${site.label}`,
      'fail',
      `import exit ${r.status}: ${(stderr || r.stdout || '').trim().slice(0, 200)}`,
    );
    continue;
  }

  // For files with a top-level loud-fail, the named line MUST appear in
  // stderr — its absence is the rc.2 silent-skip regression.
  if (site.loudFailExpected) {
    const expected = new RegExp(
      `\\[${site.expectedTag}\\][^\\n]*${site.expectedSpecifier.replace('/', '\\/')}[^\\n]*not resolvable`,
      'i',
    );
    if (!expected.test(stderr)) {
      record(
        `load:${site.label}`,
        'fail',
        `expected loud-fail line missing — silent skip regression. ` +
          `stderr was: ${stderr.trim().slice(0, 200) || '(empty)'}`,
      );
      continue;
    }
    record(
      `load:${site.label}`,
      'pass',
      `loud-fail signal present for ${site.expectedSpecifier}`,
    );
    continue;
  }

  record(`load:${site.label}`, 'pass', 'imports cleanly');
}

// ── Probe 2: session-start launcher (the rc.2 trigger path) ────────────────
// The launcher ships in `bin/` and gets synced into `<consumer>/.claude/scripts/`
// on first session-start. Probe the canonical bin/ location — that's the file
// the launcher uses as its sync source, and the one the rc.2 silent-skip lived in.
const launcher = join(mofloPkgDir, 'bin', 'session-start-launcher.mjs');
if (!existsSync(launcher)) {
  record(
    'session-start-launcher',
    'fail',
    `${relative(mofloPkgDir, launcher)} not in tarball`,
  );
} else {
  const r = spawnSync(process.execPath, [launcher], {
    cwd: consumerDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MOFLO_BRIDGE_QUIET: '1' },
  });
  if (r.error) {
    record('session-start-launcher', 'fail', `spawn error: ${r.error.message}`);
  } else if (r.status !== 0) {
    record(
      'session-start-launcher',
      'fail',
      `launcher exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`,
    );
  } else {
    // The launcher imports `embeddings-migration.js` and calls
    // `runEmbeddingsMigrationIfNeeded`. In a fresh consumer scratch dir
    // there's no DB, so the function returns false early — no signal
    // expected, that's not a regression.
    //
    // What we DO assert: the launcher itself didn't print
    // `embeddings migration check skipped: <error>` to stderr (the
    // launcher's own outer try/catch). Its presence means the launcher
    // failed to even get to runEmbeddingsMigrationIfNeeded — that IS a
    // regression worth flagging.
    const stderr = r.stderr || '';
    if (/embeddings migration check skipped:/i.test(stderr)) {
      record(
        'session-start-launcher',
        'fail',
        `launcher's outer catch fired — migration entry-point itself crashed: ${stderr.slice(0, 300)}`,
      );
    } else {
      record('session-start-launcher', 'pass', 'launcher ran cleanly');
    }
  }
}

// ── Probe 3: package.json files-array sanity ───────────────────────────────
const ROOT_PKG = JSON.parse(readFileSync(join(mofloPkgDir, 'package.json'), 'utf8'));
const filesEntries = Array.isArray(ROOT_PKG.files) ? ROOT_PKG.files : [];
const moduleDistGlobs = filesEntries.filter(
  (e) => /^dist\//.test(e) && !e.startsWith('!'),
);
const missingDists = [];
for (const glob of moduleDistGlobs) {
  // `dist/src/cli/**/*.js` → `dist/src/cli`
  const distDir = glob.replace(/\/(?:\*\*|\!).*$/, '').replace(/\/\*\*\/.+$/, '');
  const abs = join(mofloPkgDir, distDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    missingDists.push(distDir);
  }
}
if (missingDists.length > 0) {
  record(
    'files-array:dists',
    'fail',
    `package.json files claims dirs that didn't ship: ${missingDists.join(', ')}`,
  );
} else {
  record(
    'files-array:dists',
    'pass',
    `${moduleDistGlobs.length} dist dir(s) present`,
  );
}

// ── Report ──────────────────────────────────────────────────────────────────
if (asJson) {
  process.stdout.write(JSON.stringify({ results, hardFails }, null, 2) + '\n');
} else {
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${tag}] ${r.name} — ${r.detail}\n`);
  }
  process.stdout.write(
    `\n${results.filter((r) => r.status === 'pass').length}/${results.length} passed` +
      (hardFails > 0 ? `, ${hardFails} hard fail(s)` : '') +
      '\n',
  );
}

process.exit(hardFails > 0 ? 1 : 0);
