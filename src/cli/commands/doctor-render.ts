/**
 * Output rendering helpers for `flo doctor`:
 * formatted summary, JSON output, auto-fix loop, kill-zombies banner.
 */

import { output } from '../output.js';
import type { CommandResult } from '../types.js';
import { autoFixCheck } from './doctor-fixes.js';
import { checkClaudeCode, installClaudeCode } from './doctor-checks-runtime.js';
import {
  findZombieProcesses,
  formatZombieDetail,
  killTrackedProcesses,
  type ZombieDetail,
} from './doctor-zombies.js';
import type { CheckFn, HealthCheck } from './doctor-types.js';

/**
 * Issue #1122: action flags (`--fix`, `--install`, `--kill-zombies`) must
 * honor the JSON-output contract. These types describe the post-fix payload
 * the JSON document carries so automation (e.g. the shipped `/healer` skill)
 * can tell what changed without re-parsing prose.
 */
export interface FixOutcome {
  name: string;
  applied: boolean;
  error?: string;
}

export interface AutoFixResult {
  fixesApplied: FixOutcome[];
  /** Re-evaluated checks when at least one fix succeeded; null when nothing was applied. */
  reEvaluated: HealthCheck[] | null;
}

export interface KillZombiesResult {
  registryKilled: number;
  found: number;
  killed: number;
  details: ZombieDetail[];
}

export interface ClaudeCodeInstallResult {
  attempted: boolean;
  installed: boolean;
  postCheck?: HealthCheck;
}

export function formatCheck(check: HealthCheck): string {
  const icon = check.status === 'pass' ? output.success('✓') :
               check.status === 'warn' ? output.warning('⚠') :
               output.error('✗');
  return `${icon} ${check.name}: ${check.message}`;
}

interface SummaryCounts { passed: number; warnings: number; failed: number }

function tally(results: HealthCheck[]): SummaryCounts {
  return {
    passed: results.filter(r => r.status === 'pass').length,
    warnings: results.filter(r => r.status === 'warn').length,
    failed: results.filter(r => r.status === 'fail').length,
  };
}

/**
 * Run the kill-zombies scan, with optional rendering. Issue #1122: in JSON
 * mode the prose banner would corrupt the single-document contract, so the
 * caller passes `silent: true` and surfaces the structured result inside the
 * JSON payload instead.
 */
export async function runKillZombies(opts: { silent?: boolean } = {}): Promise<KillZombiesResult> {
  const silent = !!opts.silent;
  if (!silent) {
    output.writeln(output.bold('Zombie Process Scan'));
    output.writeln();
  }

  const registryKilled = killTrackedProcesses();
  if (!silent && registryKilled > 0) {
    output.writeln(output.success(`  Killed ${registryKilled} tracked background process(es) from registry`));
  }

  // Single OS-level scan + kill — the previous flow scanned twice.
  const result = await findZombieProcesses(true);
  const found = result.details.length;

  if (!silent) {
    if (found === 0) {
      if (registryKilled === 0) {
        output.writeln(output.success('  No orphaned moflo processes found'));
      }
    } else {
      output.writeln(output.warning(`  Found ${found} additional orphaned process(es):`));
      for (const d of result.details) {
        output.writeln(output.dim(`    ${formatZombieDetail(d)}`));
      }
      if (result.killed > 0) {
        output.writeln(output.success(`  Killed ${result.killed} zombie process(es)`));
      }
      if (result.killed < found) {
        output.writeln(output.warning(`  ${found - result.killed} process(es) could not be killed`));
      }
    }

    output.writeln();
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();
  }

  return { registryKilled, found, killed: result.killed, details: result.details };
}

interface JsonOutputOpts {
  results: HealthCheck[];
  strict: boolean;
  allowWarnList: string[];
  /** Issue #1122: per-fix outcomes when --fix ran on the JSON path. */
  fixesApplied?: FixOutcome[];
  /** Issue #1122: --kill-zombies scan summary when that flag was passed. */
  zombieScan?: KillZombiesResult;
  /** Issue #1122: --install outcome when that flag was passed. */
  claudeCodeInstall?: ClaudeCodeInstallResult;
}

/**
 * Issue #818: machine-readable output. Emits a single JSON document with
 * per-check fields (and any FunctionalCheckDetail entries from the swarm/
 * hive checks) and exits with the right code.
 *
 * Issue #1122: action flags (`--fix`, `--install`, `--kill-zombies`) now run
 * before this is called and their outcomes are passed in so automation can
 * tell what changed without re-parsing prose. `results` reflects post-fix
 * state when `fixesApplied` includes any successful fix.
 */
export function emitJsonOutput({
  results,
  strict,
  allowWarnList,
  fixesApplied,
  zombieScan,
  claudeCodeInstall,
}: JsonOutputOpts): CommandResult {
  const { passed, warnings, failed } = tally(results);

  const allowSet = new Set(allowWarnList);
  const strictWarningFailures = strict
    ? results.filter(r => r.status === 'warn' && !allowSet.has(r.name)).map(r => r.name)
    : [];

  const exitCode = failed > 0 || strictWarningFailures.length > 0 ? 1 : 0;

  const payload: {
    summary: SummaryCounts;
    strict: { strictMode: true; warningsTriggeringFail: string[] } | { strictMode: false };
    results: HealthCheck[];
    fixesApplied?: FixOutcome[];
    zombieScan?: KillZombiesResult;
    claudeCodeInstall?: ClaudeCodeInstallResult;
  } = {
    summary: { passed, warnings, failed },
    strict: strict ? { strictMode: true, warningsTriggeringFail: strictWarningFailures } : { strictMode: false },
    results,
  };
  if (fixesApplied !== undefined) payload.fixesApplied = fixesApplied;
  if (zombieScan !== undefined) payload.zombieScan = zombieScan;
  if (claudeCodeInstall !== undefined) payload.claudeCodeInstall = claudeCodeInstall;

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');

  return { success: exitCode === 0, exitCode, data: { passed, warnings, failed, results } };
}

/**
 * Re-runs Claude Code CLI install + check if --install was passed and the
 * prior result wasn't pass. Issue #1122: accepts `{silent}` so the JSON path
 * runs the install without writing prose to the corrupted stdout, and
 * returns a structured outcome for inclusion in the JSON document.
 */
export async function maybeAutoInstallClaudeCode(
  results: HealthCheck[],
  fixes: string[],
  opts: { silent?: boolean } = {},
): Promise<ClaudeCodeInstallResult> {
  const silent = !!opts.silent;
  const claudeCodeResult = results.find(r => r.name === 'Claude Code CLI');
  if (!claudeCodeResult || claudeCodeResult.status === 'pass') {
    return { attempted: false, installed: false };
  }
  const installed = await installClaudeCode();
  if (!installed) return { attempted: true, installed: false };

  const newCheck = await checkClaudeCode();
  const idx = results.findIndex(r => r.name === 'Claude Code CLI');
  if (idx !== -1) {
    results[idx] = newCheck;
    const fixIdx = fixes.findIndex(f => f.startsWith('Claude Code CLI:'));
    if (fixIdx !== -1 && newCheck.status === 'pass') {
      fixes.splice(fixIdx, 1);
    }
  }
  if (!silent) output.writeln(formatCheck(newCheck));
  return { attempted: true, installed: true, postCheck: newCheck };
}

export function renderSummary(results: HealthCheck[]): SummaryCounts {
  const counts = tally(results);
  output.writeln();
  output.writeln(output.dim('─'.repeat(50)));
  output.writeln();

  const summaryParts = [
    output.success(`${counts.passed} passed`),
    counts.warnings > 0 ? output.warning(`${counts.warnings} warnings`) : null,
    counts.failed > 0 ? output.error(`${counts.failed} failed`) : null,
  ].filter(Boolean);

  output.writeln(`Summary: ${summaryParts.join(', ')}`);
  return counts;
}

/**
 * Auto-fix loop, including the post-fix re-run. Mutates `results` and `fixes`
 * in place when fixes succeed and returns a structured outcome.
 *
 * Issue #1122: accepts `{silent}` so the JSON path can run the same fix work
 * without writing prose to a stubbed stdout, and emit `fixesApplied` +
 * post-fix `results` from the returned data.
 */
export async function runAutoFix(
  results: HealthCheck[],
  fixes: string[],
  checksToRun: CheckFn[],
  opts: { silent?: boolean } = {},
): Promise<AutoFixResult> {
  const silent = !!opts.silent;
  if (fixes.length === 0) return { fixesApplied: [], reEvaluated: null };

  if (!silent) {
    output.writeln();
    output.writeln(output.bold('Auto-fixing issues...'));
    output.writeln();
  }

  const fixableResults = results.filter(r => r.fix && (r.status === 'fail' || r.status === 'warn'));
  const fixesApplied: FixOutcome[] = [];

  for (const check of fixableResults) {
    const success = await autoFixCheck(check);
    fixesApplied.push({ name: check.name, applied: success });
  }

  const fixed = fixesApplied.filter(f => f.applied).length;
  const unfixed = fixesApplied.filter(f => !f.applied);

  if (!silent) {
    if (fixed > 0) {
      output.writeln();
      output.writeln(output.success(`Auto-fixed ${fixed} issue${fixed > 1 ? 's' : ''}`));
    }
    if (unfixed.length > 0) {
      output.writeln();
      output.writeln(output.bold('Manual fixes needed:'));
      for (const f of unfixed) {
        const check = results.find(r => r.name === f.name);
        output.writeln(output.dim(`  ${f.name}: ${check?.fix ?? ''}`));
      }
    }
  }

  if (fixed === 0) return { fixesApplied, reEvaluated: null };

  const reSettled = await Promise.allSettled(checksToRun.map(check => check()));
  const reEvaluated: HealthCheck[] = reSettled.map((sr) =>
    sr.status === 'fulfilled'
      ? sr.value
      : { name: 'Check', status: 'fail' as const, message: (sr.reason as { message?: string } | undefined)?.message ?? 'Unknown error' },
  );

  if (!silent) {
    output.writeln();
    output.writeln(output.dim('Re-checking...'));
    output.writeln();
    let rePassed = 0, reWarnings = 0, reFailed = 0;
    for (const r of reEvaluated) {
      output.writeln(formatCheck(r));
      if (r.status === 'pass') rePassed++;
      else if (r.status === 'warn') reWarnings++;
      else reFailed++;
    }
    output.writeln();
    output.writeln(output.dim('─'.repeat(50)));
    const reSummary = [
      output.success(`${rePassed} passed`),
      reWarnings > 0 ? output.warning(`${reWarnings} warnings`) : null,
      reFailed > 0 ? output.error(`${reFailed} failed`) : null,
    ].filter(Boolean);
    output.writeln(`After fix: ${reSummary.join(', ')}`);
  }

  return { fixesApplied, reEvaluated };
}

interface FinalizeOpts {
  results: HealthCheck[];
  strict: boolean;
  allowWarnList: string[];
}

/**
 * Build the final CommandResult based on pass/warn/fail counts and --strict
 * mode. Issue #784: in strict mode any non-allowlisted warning fails the run.
 * Equality (not substring) match — an allowlist entry tolerates exactly that
 * check, never accidentally suppresses neighboring checks like "Git"
 * allowlisting "Git Repository".
 */
export function finalize({ results, strict, allowWarnList }: FinalizeOpts): CommandResult {
  const { passed, warnings, failed } = tally(results);

  if (failed > 0) {
    output.writeln();
    output.writeln(output.error('Some checks failed. Please address the issues above.'));
    return { success: false, exitCode: 1, data: { passed, warnings, failed, results } };
  }
  if (warnings > 0) {
    if (strict) {
      const warnResults = results.filter((r) => r.status === 'warn');
      const allowSet = new Set(allowWarnList);
      const offending = warnResults.filter((r) => !r.name || !allowSet.has(r.name));
      if (offending.length > 0) {
        output.writeln();
        output.writeln(output.error(
          `--strict: ${offending.length} warning${offending.length > 1 ? 's' : ''} not allowlisted ` +
            `(use --allow-warn "<name>,<name>" to tolerate intentional warnings):`,
        ));
        for (const r of offending) {
          output.writeln(output.error(`  ✗ ${r.name}: ${r.message ?? ''}`));
        }
        return { success: false, exitCode: 1, data: { passed, warnings, failed, results } };
      }
      output.writeln();
      output.writeln(output.success(
        `--strict: ${warnResults.length} warning${warnResults.length > 1 ? 's' : ''} all allowlisted (--allow-warn).`,
      ));
      return { success: true, data: { passed, warnings, failed, results } };
    }
    output.writeln();
    output.writeln(output.warning('All checks passed with some warnings.'));
    return { success: true, data: { passed, warnings, failed, results } };
  }
  output.writeln();
  output.writeln(output.success('All checks passed! System is healthy.'));
  return { success: true, data: { passed, warnings, failed, results } };
}
