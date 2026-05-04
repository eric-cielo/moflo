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
} from './doctor-zombies.js';
import type { CheckFn, HealthCheck } from './doctor-types.js';

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

export async function runKillZombiesBanner(): Promise<void> {
  output.writeln(output.bold('Zombie Process Scan'));
  output.writeln();

  const registryKilled = killTrackedProcesses();
  if (registryKilled > 0) {
    output.writeln(output.success(`  Killed ${registryKilled} tracked background process(es) from registry`));
  }

  // Single OS-level scan + kill — the previous flow scanned twice.
  const result = await findZombieProcesses(true);
  const found = result.details.length;

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

interface JsonOutputOpts {
  results: HealthCheck[];
  strict: boolean;
  allowWarnList: string[];
}

/**
 * Issue #818: machine-readable output. Emits a single JSON document with
 * per-check fields (and any FunctionalCheckDetail entries from the swarm/
 * hive checks) and exits with the right code. Skips auto-fix entirely —
 * --json is read-only by intent so CI gates can consume it without
 * mutating the working tree.
 */
export function emitJsonOutput({ results, strict, allowWarnList }: JsonOutputOpts): CommandResult {
  const { passed, warnings, failed } = tally(results);

  const allowSet = new Set(allowWarnList);
  const strictWarningFailures = strict
    ? results.filter(r => r.status === 'warn' && !allowSet.has(r.name)).map(r => r.name)
    : [];

  const exitCode = failed > 0 || strictWarningFailures.length > 0 ? 1 : 0;

  process.stdout.write(JSON.stringify({
    summary: { passed, warnings, failed },
    strict: strict ? { strictMode: true, warningsTriggeringFail: strictWarningFailures } : { strictMode: false },
    results,
  }, null, 2) + '\n');

  return { success: exitCode === 0, exitCode, data: { passed, warnings, failed, results } };
}

/** Re-runs Claude Code CLI install + check if --install was passed and the prior result wasn't pass. */
export async function maybeAutoInstallClaudeCode(
  results: HealthCheck[],
  fixes: string[],
): Promise<void> {
  const claudeCodeResult = results.find(r => r.name === 'Claude Code CLI');
  if (!claudeCodeResult || claudeCodeResult.status === 'pass') return;
  const installed = await installClaudeCode();
  if (!installed) return;
  const newCheck = await checkClaudeCode();
  const idx = results.findIndex(r => r.name === 'Claude Code CLI');
  if (idx !== -1) {
    results[idx] = newCheck;
    const fixIdx = fixes.findIndex(f => f.startsWith('Claude Code CLI:'));
    if (fixIdx !== -1 && newCheck.status === 'pass') {
      fixes.splice(fixIdx, 1);
    }
  }
  output.writeln(formatCheck(newCheck));
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

/** Auto-fix loop, including the post-fix re-run. Mutates `results` and `fixes` in place when fixes succeed. */
export async function runAutoFix(
  results: HealthCheck[],
  fixes: string[],
  checksToRun: CheckFn[],
): Promise<void> {
  if (fixes.length === 0) return;

  output.writeln();
  output.writeln(output.bold('Auto-fixing issues...'));
  output.writeln();

  const fixableResults = results.filter(r => r.fix && (r.status === 'fail' || r.status === 'warn'));
  let fixed = 0;
  const unfixed: string[] = [];

  for (const check of fixableResults) {
    const success = await autoFixCheck(check);
    if (success) {
      fixed++;
    } else {
      unfixed.push(`${check.name}: ${check.fix}`);
    }
  }

  if (fixed > 0) {
    output.writeln();
    output.writeln(output.success(`Auto-fixed ${fixed} issue${fixed > 1 ? 's' : ''}`));
  }
  if (unfixed.length > 0) {
    output.writeln();
    output.writeln(output.bold('Manual fixes needed:'));
    for (const fix of unfixed) {
      output.writeln(output.dim(`  ${fix}`));
    }
  }

  if (fixed === 0) return;

  output.writeln();
  output.writeln(output.dim('Re-checking...'));
  output.writeln();
  const reResults = await Promise.allSettled(checksToRun.map(check => check()));
  let rePassed = 0, reWarnings = 0, reFailed = 0;
  for (const sr of reResults) {
    if (sr.status === 'fulfilled') {
      output.writeln(formatCheck(sr.value));
      if (sr.value.status === 'pass') rePassed++;
      else if (sr.value.status === 'warn') reWarnings++;
      else reFailed++;
    }
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
