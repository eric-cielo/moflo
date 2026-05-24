/**
 * V3 CLI Doctor Command
 * System diagnostics, dependency checks, config validation
 *
 * The check implementations live in focused sibling modules
 * (`doctor-checks-*.ts`, `doctor-zombies.ts`, `doctor-version.ts`,
 * `doctor-fixes.ts`); the registry of which checks run lives in
 * `doctor-registry.ts`; rendering helpers live in `doctor-render.ts`.
 * This file is orchestration only.
 *
 * Created with motailz.com
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { allChecks, componentMap, zombieScanCheck } from './doctor-registry.js';
import type { HealthCheck } from './doctor-types.js';
import {
  emitJsonOutput,
  finalize,
  formatCheck,
  maybeAutoInstallClaudeCode,
  renderSummary,
  runAutoFix,
  runKillZombies,
  type ClaudeCodeInstallResult,
  type FixOutcome,
  type KillZombiesResult,
} from './doctor-render.js';
import { checkEmbeddings } from './doctor-checks-memory.js';
import { checkMofloYamlCompliance } from './doctor-checks-config.js';

export type { HealthCheck } from './doctor-types.js';

// Re-export for tests + external consumers (#639 stale-vector-stats test
// imports `checkEmbeddings`; init/upgrade flows import `checkMofloYamlCompliance`).
export { checkEmbeddings, checkMofloYamlCompliance };

export const doctorCommand: Command = {
  name: 'doctor',
  aliases: ['healer'],
  description: 'System diagnostics and health checks',
  options: [
    {
      name: 'fix',
      short: 'f',
      description: 'Automatically fix issues where possible',
      type: 'boolean',
      default: false,
    },
    {
      name: 'install',
      short: 'i',
      description: 'Auto-install missing dependencies (Claude Code CLI)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'component',
      short: 'c',
      description: 'Check specific component (version, version-skew, node, npm, config, daemon, writers-audit, memory, embeddings, coverage-truth, git, mcp, claude, disk, typescript, semantic, intelligence, swarm, hive-mind)',
      type: 'string',
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose output',
      type: 'boolean',
      default: false,
    },
    {
      name: 'kill-zombies',
      short: 'k',
      description: 'Find and kill orphaned moflo/claude-flow node processes',
      type: 'boolean',
      default: false,
    },
    {
      // Issue #784: fail on warnings. Used by consumer-install-smoke so a
      // single regressed check (like the 4.9.0-rc.11 Sandbox-Tier silent
      // warn) blocks merge instead of slipping into a published tarball.
      name: 'strict',
      description: 'Treat warnings as failures (non-zero exit). Used by CI.',
      type: 'boolean',
      default: false,
    },
    {
      // Companion to --strict. CI-legitimate warnings (e.g. "Sandbox Tier"
      // on a runner without Docker) are explicitly allowlisted by name so
      // the test owner's intent is on record. Comma-separated; matches the
      // `name` field of each check (case-sensitive substring).
      name: 'allow-warn',
      description: 'In --strict mode, comma-separated check names whose warnings are tolerated.',
      type: 'string',
    },
    {
      // Issue #818: machine-readable output. Suppresses banner/spinner/auto-fix
      // and emits a single JSON document so CI gates and smoke harnesses can
      // consume per-check details (including FunctionalCheckDetail entries).
      name: 'json',
      description: 'Emit a single JSON document with per-check + per-subcheck details. Suppresses formatted output.',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'flo doctor', description: 'Run full health check' },
    { command: 'flo doctor --fix', description: 'Show fixes for issues' },
    { command: 'flo doctor --install', description: 'Auto-install missing dependencies' },
    { command: 'flo doctor --kill-zombies', description: 'Find and kill zombie processes' },
    { command: 'flo doctor -c version', description: 'Check for stale npx cache' },
    { command: 'flo doctor -c claude', description: 'Check Claude Code CLI only' },
    { command: 'flo doctor --strict', description: 'Fail (exit 1) on any warning — used by CI' },
    { command: 'flo doctor --json', description: 'Emit a single JSON doc with per-check + per-subcheck details (for CI/smoke gates)' },
    { command: 'flo doctor -c swarm', description: 'Run only the swarm + agent + task coordinator-path tripwire (epic #798)' },
    { command: 'flo doctor -c hive-mind', description: 'Run only the hive-mind MessageBus + shared-coordinator tripwire' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const showFix = ctx.flags.fix as boolean;
    const autoInstall = ctx.flags.install as boolean;
    const component = ctx.flags.component as string;
    const killZombies = ctx.flags.killZombies as boolean;
    const strict = ctx.flags.strict as boolean;
    // Parser normalises kebab-case flag names to camelCase: `--allow-warn`
    // arrives as `ctx.flags.allowWarn`. Reading the dashed form returns
    // undefined and silently disables the allowlist (was the bug that made
    // every smoke run fail until 4.9.0-rc.13).
    const allowWarnRaw = ctx.flags.allowWarn as string | undefined;
    const allowWarnList = allowWarnRaw
      ? allowWarnRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const jsonOutput = ctx.flags.json as boolean;

    if (!jsonOutput) {
      output.writeln();
      output.writeln(output.bold('MoFlo Doctor'));
      output.writeln(output.dim('System diagnostics and health check'));
      output.writeln(output.dim('─'.repeat(50)));
      output.writeln();
    }

    // --allow-warn is meaningless without --strict; surface the misuse
    // under the banner so it reads as doctor output, not orphaned text.
    if (allowWarnList.length > 0 && !strict && !jsonOutput) {
      output.writeln(output.warning(
        '--allow-warn requires --strict; ignoring (warnings are tolerated by default).',
      ));
      output.writeln();
    }

    const checksToRun = component && componentMap[component]
      ? [componentMap[component]]
      : allChecks;

    const results: HealthCheck[] = [];
    const fixes: string[] = [];
    let zombieScan: KillZombiesResult | undefined;
    let claudeCodeInstall: ClaudeCodeInstallResult | undefined;
    let fixesApplied: FixOutcome[] | undefined;

    // Issue #818: in --json mode, several deep checks (spell engine probe,
    // mcp-spell bridge, etc.) write `[spell] ...` log lines straight to
    // stdout — that breaks the single-JSON-document contract. Capture and
    // discard stdout writes while checks AND post-check actions run; restore
    // in `finally` so a throw can't leave the process with a stubbed stdout.
    // Issue #1122: extended to wrap zombie-kill banner, --install, and
    // --fix work so each runs on the JSON path with prose suppressed.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    const restoreStdout = () => {
      if (jsonOutput) {
        (process.stdout as unknown as { write: typeof realStdoutWrite }).write = realStdoutWrite;
      }
    };
    if (jsonOutput) {
      (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write =
        (..._args: unknown[]) => true;
    }

    // OPTIMIZATION: Run all checks in parallel for 3-5x faster execution
    const spinner = jsonOutput
      ? null
      : output.createSpinner({ text: 'Running health checks in parallel...', spinner: 'dots' });

    try {
      // Issue #1122: kill-zombies prose used to write BEFORE the JSON
      // suppression activated, corrupting the JSON document. Now runs
      // under suppression and feeds a structured result into the payload.
      if (killZombies) {
        zombieScan = await runKillZombies({ silent: jsonOutput });
      }

      spinner?.start();
      let checkResults: PromiseSettledResult<HealthCheck>[];
      try {
        checkResults = await Promise.allSettled(checksToRun.map(check => check()));
        // Issue #992: zombie scan must follow the parallel batch, not race it.
        // Several parallel checks spawn short-lived subprocesses (notably
        // `checkBuildTools` running `npx tsc --version`); on Windows the npx
        // shim exits before its tsc child, leaving a transient orphan that
        // the zombie scan would otherwise flag as a real leak. Skip in
        // single-component (`-c`) runs since those are targeted diagnostics.
        if (!component) {
          try {
            checkResults.push({ status: 'fulfilled', value: await zombieScanCheck() });
          } catch (reason) {
            checkResults.push({ status: 'rejected', reason });
          }
        }
      } finally {
        spinner?.stop();
      }

      for (const settledResult of checkResults) {
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          results.push(result);
          if (!jsonOutput) output.writeln(formatCheck(result));

          if (result.fix && (result.status === 'fail' || result.status === 'warn')) {
            fixes.push(`${result.name}: ${result.fix}`);
          }
        } else {
          const errorResult: HealthCheck = {
            name: 'Check',
            status: 'fail',
            message: settledResult.reason?.message || 'Unknown error',
          };
          results.push(errorResult);
          if (!jsonOutput) output.writeln(formatCheck(errorResult));
        }
      }

      // Issue #1122: action flags must run on BOTH the JSON path and the
      // formatted path. Previously the JSON branch early-returned before
      // any of this ran, so `--json --fix` (and `--json --install`) silently
      // no-op'd. Now they execute under stdout suppression and their
      // outcomes feed the JSON payload below.
      if (autoInstall) {
        claudeCodeInstall = await maybeAutoInstallClaudeCode(results, fixes, { silent: jsonOutput });
      }

      if (!jsonOutput) renderSummary(results);

      if (showFix && fixes.length > 0) {
        const outcome = await runAutoFix(results, fixes, checksToRun, { silent: jsonOutput });
        fixesApplied = outcome.fixesApplied;
        // Replace `results` with post-fix state so JSON consumers see the
        // re-evaluated truth, not the pre-fix snapshot. Mirror the #992
        // post-parallel zombie-scan append so the post-fix shape matches
        // pre-fix shape (otherwise `--json --fix` silently drops the
        // Zombie Processes entry from the JSON `results[]`).
        if (outcome.reEvaluated) {
          const finalChecks = [...outcome.reEvaluated];
          if (!component) {
            try {
              finalChecks.push(await zombieScanCheck());
            } catch (reason) {
              finalChecks.push({
                name: 'Zombie Processes',
                status: 'fail',
                message: (reason as { message?: string } | undefined)?.message ?? 'Unknown error',
              });
            }
          }
          results.length = 0;
          results.push(...finalChecks);
        }
      } else if (fixes.length > 0 && !showFix && !jsonOutput) {
        output.writeln();
        output.writeln(output.dim(`Run with --fix to auto-fix ${fixes.length} issue${fixes.length > 1 ? 's' : ''}`));
      }
    } catch {
      spinner?.stop();
      if (!jsonOutput) output.writeln(output.error('Failed to run health checks'));
    } finally {
      restoreStdout();
    }

    if (jsonOutput) {
      return emitJsonOutput({
        results,
        strict,
        allowWarnList,
        fixesApplied,
        zombieScan,
        claudeCodeInstall,
      });
    }

    return finalize({ results, strict, allowWarnList });
  },
};

export default doctorCommand;
