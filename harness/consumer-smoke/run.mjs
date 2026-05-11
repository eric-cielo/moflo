#!/usr/bin/env node
/**
 * Consumer smoke-test harness
 *
 * Packs the current moflo working tree, installs it into a clean consumer
 * tempdir (just like a real consumer would), and exercises the Claude-Code-
 * facing surface: memory CRUD, spell list, MCP tools registration, hooks,
 * `/flo` skill packaging, and flo-search CLI.
 *
 * Also asserts forbidden-dep invariants in the installed dist tree:
 * `agentdb`, `agentic-flow`, `@ruvector/*`, `ruvector`, `@xenova/transformers`,
 * and any hash-embedding identifiers (HashEmbeddingProvider, createHashEmbedding,
 * generateHashEmbedding, RvfEmbeddingService, RvfEmbeddingCache,
 * `domain-aware-hash-*`). Also applies a structural guard over the swarm
 * dist: any file containing both `new Float32Array(` and `charCodeAt(` is
 * rejected regardless of method name. Asserts required deps present
 * (`fastembed`) and that postinstall pruned onnxruntime-node to the current
 * platform+arch.
 *
 * Usage:
 *   node harness/consumer-smoke/run.mjs                # full run
 *   node harness/consumer-smoke/run.mjs --skip-pack    # reuse last tarball
 *   node harness/consumer-smoke/run.mjs --keep         # keep .work for inspection
 *   node harness/consumer-smoke/run.mjs --verbose      # stream subprocess output
 *   node harness/consumer-smoke/run.mjs --json         # machine-readable summary
 *   node harness/consumer-smoke/run.mjs --summary      # suppress PASS rows; failures + tail only (auto-on when stdout is non-TTY)
 *   node harness/consumer-smoke/run.mjs --no-summary   # force verbose output even when piped
 *   node harness/consumer-smoke/run.mjs --tarball PATH # use an existing tarball
 *
 * Exit codes:
 *   0 — all smoke checks passed (warnings for known regressions allowed)
 *   1 — at least one hard-fail check failed
 *   2 — harness aborted before running checks (pack/install failure)
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import * as report from './lib/report.mjs';
import * as proc from './lib/proc.mjs';
import * as check from './lib/checks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
// #1088: workDir lives in os.tmpdir() so the consumer dir has NO moflo-repo
// ancestor with `CLAUDE.md+package.json` or `.moflo/moflo.db`. Without this,
// every walk-up resolver inside the consumer (findProjectRoot, the daemon's
// bridge, every bin/ script) lands on the moflo source repo and writes to
// the wrong DB. Nesting under `harness/consumer-smoke/.work` produced a
// recurring bug class — #1054 single-writer epic, #1057 unified resolver,
// #1058 daemon-routed reads, #1088 — each exposed the same path mismatch in
// a different code path. The fix is structural: put the consumer somewhere
// the resolver can't accidentally walk up out of.
const workDir = join(tmpdir(), 'moflo-consumer-smoke');

const argv = process.argv.slice(2);
const opts = {
  skipPack: argv.includes('--skip-pack'),
  keep: argv.includes('--keep'),
  verbose: argv.includes('--verbose') || argv.includes('-v'),
  json: argv.includes('--json'),
  summary: report.resolveSummaryMode(argv),
  tarball: null,
};
const tIdx = argv.indexOf('--tarball');
if (tIdx !== -1 && argv[tIdx + 1]) opts.tarball = resolve(argv[tIdx + 1]);

report.configure({ json: opts.json, summary: opts.summary });
proc.configure({ verbose: opts.verbose });

async function main() {
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
      // #1088 broken-window gate — must run FIRST. If the consumer dir isn't
      // its own project root, every downstream daemon/bridge/probe quietly
      // reads/writes the wrong DB and individual probe failures look like
      // unrelated bugs (we've debugged that pattern 3+ times). Fail here
      // with a single named error instead.
      () => check.verifyConsumerIsProjectRoot(consumerDir),
      () => check.verifyForbiddenDeps(consumerDir),
      () => check.verifyRequiredDeps(consumerDir),
      () => check.verifyNoBannedEmbeddings(consumerDir),
      () => check.verifyNoInlineHashEmbeddings(consumerDir),
      () => check.cliLoads(consumerDir),
      () => check.doctor(consumerDir),
      () => check.memoryInit(consumerDir),
      () => check.memoryCrud(consumerDir),
      () => check.crossProcessNoClobber(consumerDir),
      () => check.spellList(consumerDir),
      () => check.spellScheduleStrictCron(consumerDir),
      () => check.mcpTools(consumerDir),
      () => check.memoryTraversalProtocol(consumerDir),
      () => check.moflodbBridge(consumerDir),
      () => check.floSearch(consumerDir),
      () => check.hooks(consumerDir),
      () => check.floSkillPackaged(consumerDir),
      () => check.verifyShippedSkillArguments(consumerDir),
      () => check.consumerInvariants(consumerDir),
      () => check.installSurface(consumerDir),
      () => check.verifyPrunedBinaries(consumerDir),
      () => check.verifyTokenizerSubpackage(consumerDir),
      // Issue #585: probe every @moflo/* bare specifier the consumer install
      // exercises, including the four call sites loud-failed in #583.
      () => check.consumerInstallSensitivePaths(consumerDir, repoRoot),
      // Issue #575: must run LAST so it sees stderr from every preceding check.
      () => check.verifyNoPathResolutionErrors(),
    ];
    for (const fn of checks) {
      // Most checks are sync; #1060's crossProcessNoClobber is async. Await
      // every result so a thrown error OR a rejected Promise becomes a
      // recorded fail rather than an unhandled rejection that walks past the
      // reporter.
      try { await fn(); } catch (err) {
        report.record(fn.name || 'check', 'fail', `unexpected error: ${err.message}`);
      }
    }
  } catch (err) {
    report.log(`\nHarness aborted: ${err.message}`);
    report.printSummary();
    await check.cleanupWorkDir(workDir, { keep: opts.keep });
    process.exit(2);
  }

  await check.cleanupWorkDir(workDir, { keep: opts.keep });
  report.printSummary();
  const failed = report.getResults().filter(r => r.status === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  report.log(`\nHarness crashed: ${err?.stack || err?.message || err}`);
  process.exit(2);
});
