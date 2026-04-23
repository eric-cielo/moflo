#!/usr/bin/env node
/**
 * Consumer smoke-test harness
 *
 * Packs the current moflo working tree, installs it into a clean consumer
 * tempdir (just like a real consumer would), and exercises the Claude-Code-
 * facing surface: memory CRUD, spell list, MCP tools registration, hooks,
 * `/flo` skill packaging, and flo-search CLI.
 *
 * Epic #464 Gate 3 / Epic #501 Story 2 — also asserts the forbidden-dep
 * invariant: no `agentdb`, `agentic-flow`, `@ruvector/*`, `ruvector`, or
 * `onnxruntime-node` in a fresh consumer install.
 *
 * Epic #527 Story #532 — extends the invariant: no `@xenova/transformers`
 * and no hash-embedding identifiers (HashEmbeddingProvider, createHashEmbedding,
 * generateHashEmbedding, RvfEmbeddingService, RvfEmbeddingCache,
 * `domain-aware-hash-*`) in the installed dist tree. Also asserts the
 * required neural runtime (`fastembed`) is present.
 *
 * Usage:
 *   node harness/consumer-smoke/run.mjs                # full run
 *   node harness/consumer-smoke/run.mjs --skip-pack    # reuse last tarball
 *   node harness/consumer-smoke/run.mjs --keep         # keep .work for inspection
 *   node harness/consumer-smoke/run.mjs --verbose      # stream subprocess output
 *   node harness/consumer-smoke/run.mjs --json         # machine-readable summary
 *   node harness/consumer-smoke/run.mjs --tarball PATH # use an existing tarball
 *
 * Exit codes:
 *   0 — all smoke checks passed (warnings for known regressions allowed)
 *   1 — at least one hard-fail check failed
 *   2 — harness aborted before running checks (pack/install failure)
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as report from './lib/report.mjs';
import * as proc from './lib/proc.mjs';
import * as check from './lib/checks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const workDir = join(__dirname, '.work');

const argv = process.argv.slice(2);
const opts = {
  skipPack: argv.includes('--skip-pack'),
  keep: argv.includes('--keep'),
  verbose: argv.includes('--verbose') || argv.includes('-v'),
  json: argv.includes('--json'),
  tarball: null,
};
const tIdx = argv.indexOf('--tarball');
if (tIdx !== -1 && argv[tIdx + 1]) opts.tarball = resolve(argv[tIdx + 1]);

report.configure({ json: opts.json });
proc.configure({ verbose: opts.verbose });

function main() {
  let consumerDir;

  try {
    check.verifyDistHygiene(repoRoot);
    const tarball = check.packMoflo({
      repoRoot, workDir,
      tarballOverride: opts.tarball,
      skipPack: opts.skipPack,
    });
    consumerDir = check.installConsumer({ workDir, tarballPath: tarball });

    const checks = [
      () => check.verifyForbiddenDeps(consumerDir),
      () => check.verifyRequiredDeps(consumerDir),
      () => check.verifyNoBannedEmbeddings(consumerDir),
      () => check.cliLoads(consumerDir),
      () => check.doctor(consumerDir),
      () => check.memoryInit(consumerDir),
      () => check.memoryCrud(consumerDir),
      () => check.spellList(consumerDir),
      () => check.mcpTools(consumerDir),
      () => check.moflodbBridge(consumerDir),
      () => check.floSearch(consumerDir),
      () => check.hooks(consumerDir),
      () => check.floSkillPackaged(consumerDir),
      () => check.consumerInvariants(consumerDir),
      () => check.installSurface(consumerDir),
    ];
    for (const fn of checks) {
      try { fn(); } catch (err) {
        report.record(fn.name || 'check', 'fail', `unexpected error: ${err.message}`);
      }
    }
  } catch (err) {
    report.log(`\nHarness aborted: ${err.message}`);
    report.printSummary();
    check.cleanupWorkDir(workDir, { keep: opts.keep });
    process.exit(2);
  }

  check.cleanupWorkDir(workDir, { keep: opts.keep });
  report.printSummary();
  const failed = report.getResults().filter(r => r.status === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main();
