#!/usr/bin/env node
/**
 * Populated-consumer smoke harness (issue #736).
 *
 * Safety gate for stories #727 / #728 / #729 / #735 — proves that an upgrade
 * from a realistic pre-state preserves user-stored knowledge and announces
 * every state change. The clean-install harness in run.mjs verifies pack +
 * surface; this one verifies data preservation.
 *
 * Usage:
 *   node harness/consumer-smoke/run-populated.mjs              # full run
 *   node harness/consumer-smoke/run-populated.mjs --skip-pack  # reuse last tarball
 *   node harness/consumer-smoke/run-populated.mjs --keep       # keep .work for inspection
 *   node harness/consumer-smoke/run-populated.mjs --summary    # suppress PASS rows; failures + tail only (auto-on when stdout is non-TTY)
 *   node harness/consumer-smoke/run-populated.mjs --no-summary # force verbose output even when piped
 *   node harness/consumer-smoke/run-populated.mjs --tarball PATH
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — at least one assertion failed
 *   2 — harness aborted before running checks (pack/install failure)
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as report from './lib/report.mjs';
import * as proc from './lib/proc.mjs';
import * as check from './lib/checks.mjs';
import { runPopulatedConsumerProfile } from './lib/populated.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const workDir = join(__dirname, '.work');

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
    const tarball = check.packMoflo({
      repoRoot, workDir,
      tarballOverride: opts.tarball,
      skipPack: opts.skipPack,
    });
    consumerDir = check.installConsumer({ workDir, tarballPath: tarball });

    await runPopulatedConsumerProfile(consumerDir);
  } catch (err) {
    report.log(`\nHarness aborted: ${err.message}`);
    report.printSummary();
    if (consumerDir) check.stopConsumerDaemon(consumerDir);
    await check.cleanupWorkDir(workDir, { keep: opts.keep });
    process.exit(2);
  }

  if (consumerDir) check.stopConsumerDaemon(consumerDir);
  await check.cleanupWorkDir(workDir, { keep: opts.keep });
  report.printSummary();
  const failed = report.getResults().filter(r => r.status === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  report.log(`\nHarness crashed: ${err?.stack || err?.message || err}`);
  process.exit(2);
});
