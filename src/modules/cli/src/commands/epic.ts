/**
 * MoFlo Epic Command — Thin Spell Runner Wrapper
 *
 * Story #197: Refactored from ~1153-line ad-hoc orchestrator to thin wrapper
 * that loads spell YAML templates and runs them via SpellCaster.
 *
 * Usage:
 *   flo epic run 42                          Execute an epic from GitHub
 *   flo epic run 42 --dry-run                Show execution plan
 *   flo epic run 42 --strategy auto-merge    Use per-story PR strategy
 *   flo epic status <epic-number>            Check progress via memory
 *   flo epic reset <epic-number>             Clear epic memory state
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  isEpicIssue,
  fetchEpicIssue,
  extractStories,
  enrichStoryNames,
  resolveExecutionOrder,
} from '../epic/index.js';
import type { EpicStrategy } from '../epic/types.js';
import { runEpicSpell } from '../epic/runner-adapter.js';

// ============================================================================
// Spell Template Loader
// ============================================================================

const SPELLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'epic', 'spells');

function loadSpellTemplate(strategy: EpicStrategy): string {
  const filename = strategy === 'auto-merge' ? 'auto-merge.yaml' : 'single-branch.yaml';
  return readFileSync(join(SPELLS_DIR, filename), 'utf-8');
}

// ============================================================================
// Subcommand: run
// ============================================================================

async function runEpic(
  source: string,
  strategy: EpicStrategy,
  dryRun: boolean,
): Promise<CommandResult> {
  const issueNumber = parseInt(source, 10);
  if (isNaN(issueNumber)) {
    return { success: false, message: `Expected issue number, got: "${source}"` };
  }

  // 1. Fetch and validate epic
  console.log(`[epic] Fetching issue #${issueNumber}...`);
  const issue = await fetchEpicIssue(issueNumber);

  if (!isEpicIssue(issue)) {
    return {
      success: false,
      message: `Issue #${issueNumber} ("${issue.title}") is not an epic.\n` +
        `Add child stories as checklist items (- [ ] #123) or a ## Stories section.\n` +
        `For a single issue, use: /flo ${issueNumber}`,
    };
  }

  // 2. Extract and order stories
  const stories = extractStories(issue);
  if (stories.length === 0) {
    return { success: false, message: `No stories found in epic #${issueNumber}` };
  }

  await enrichStoryNames(stories);
  const plan = resolveExecutionOrder(stories);
  const storyById = new Map(stories.map(s => [s.id, s]));

  console.log(`[epic] ${issue.title}`);
  console.log(`[epic] Strategy: ${strategy}`);
  console.log(`[epic] Stories (${stories.length}):`);
  for (const id of plan.order) {
    const s = storyById.get(id);
    if (s) console.log(`  ${s.issue}: ${s.name}`);
  }
  console.log('');

  // 3. Check for prior state (resume support)
  let completedStories = new Set<number>();
  try {
    const stateResult = await runEpicSpell(
      `name: epic-resume-check\nsteps:\n  - id: check-state\n    type: memory\n    config:\n      action: search\n      namespace: epic-state\n      query: "epic ${issueNumber} story completed"`,
      { args: {} },
    );
    if (stateResult.success && stateResult.outputs['check-state']) {
      const stateData = stateResult.outputs['check-state'] as Record<string, unknown>;
      const results = (stateData as { results?: Array<{ key: string; value: { status: string } }> }).results;
      if (results) {
        for (const entry of results) {
          const match = entry.key.match(/story-(\d+)/);
          if (match && (entry.value?.status === 'completed' || entry.value?.status === 'merged')) {
            completedStories.add(parseInt(match[1], 10));
          }
        }
      }
    }
  } catch {
    // No prior state — fresh run
  }

  if (completedStories.size > 0) {
    console.log(`[epic] Resuming: ${completedStories.size} stories already completed`);
  }

  // 4. Build slug for branch name
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);

  // 5. Load spell template and execute
  const yaml = loadSpellTemplate(strategy);
  const allStoryNumbers = plan.order
    .map(id => storyById.get(id)?.issue)
    .filter((n): n is number => n != null);
  const storyNumbers = allStoryNumbers.filter(n => !completedStories.has(n));

  if (storyNumbers.length === 0) {
    console.log(`[epic] All ${allStoryNumbers.length} stories already completed`);
    return { success: true, message: 'Epic already completed' };
  }

  const args = {
    epic_number: issueNumber,
    base_branch: 'main',
    stories: storyNumbers.map(String),
    epic_slug: slug,
    admin_merge: false,
    merge_method: 'squash',
  };

  if (dryRun) {
    console.log('[epic] Dry-run mode — showing execution plan:');
    console.log(`[epic] Strategy: ${strategy}`);
    console.log(`[epic] Args: ${JSON.stringify(args, null, 2)}`);
    console.log('[epic] Stories would be processed in order:');
    for (const num of storyNumbers) {
      const s = stories.find(st => st.issue === num);
      console.log(`  #${num}: ${s?.name ?? '(unknown)'}`);
    }

    try {
      const result = await runEpicSpell(yaml, {
        args, dryRun: true,
      });

      if (result.success) {
        console.log('[epic] Dry-run: spell is valid');
      } else {
        console.log('[epic] Dry-run: spell has validation errors:');
        for (const err of result.errors) {
          console.log(`  - ${err.message}`);
          const details = (err as Record<string, unknown>).details;
          if (Array.isArray(details)) {
            for (const d of details) {
              console.log(`    ${d.path ?? ''}: ${d.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`[epic] Dry-run validation error: ${(err as Error).message}`);
    }

    return { success: true, message: 'Dry-run complete' };
  }

  // 6. Execute spell
  console.log(`[epic] Casting ${strategy} spell...`);
  let stepCount = 0;

  try {
    const result = await runEpicSpell(yaml, {
      args,
      onStepComplete: (stepResult, index, total) => {
        stepCount++;
        const status = stepResult.status === 'succeeded' ? '✓' :
          stepResult.status === 'skipped' ? '○' : '✗';
        console.log(`[epic] Step ${stepCount}/${total}: ${status} ${stepResult.stepId} (${stepResult.duration}ms)`);
        if (stepResult.status === 'failed' && stepResult.error) {
          console.log(`[epic]   └─ ${stepResult.error}`);
        }
      },
    });

    if (result.success) {
      console.log(`\n[epic] Epic #${issueNumber} completed successfully`);
      if (strategy === 'single-branch') {
        const prData = result.outputs['create-pr'] as Record<string, unknown> | undefined;
        if (prData?.prUrl) {
          console.log(`[epic] PR: ${prData.prUrl}`);
        }
      }
      return { success: true, message: 'Epic completed', data: result };
    } else {
      console.log(`\n[epic] Epic #${issueNumber} failed`);

      // Print step-level results for visibility
      if (result.steps && result.steps.length > 0) {
        for (const step of result.steps) {
          const icon = step.status === 'succeeded' ? '✓' : step.status === 'skipped' ? '○' : '✗';
          const line = `  ${icon} ${step.stepId} [${step.stepType}]: ${step.status} (${step.duration}ms)`;
          console.log(line);
          if (step.error) {
            console.log(`    Error: ${step.error}`);
          }
        }
      }

      // Print spell-level errors with full detail
      for (const err of result.errors) {
        const prefix = (err as Record<string, unknown>).stepId
          ? `  [${(err as Record<string, unknown>).stepId}]`
          : '  [spell]';
        console.log(`${prefix} ${(err as Record<string, unknown>).code ?? 'ERROR'}: ${err.message}`);
        const details = (err as Record<string, unknown>).details;
        if (Array.isArray(details)) {
          for (const d of details) {
            console.log(`    ${d.path ?? ''}: ${d.message ?? JSON.stringify(d)}`);
          }
        }
      }

      // Build actionable error message from first failure
      const firstErr = result.errors[0] as Record<string, unknown> | undefined;
      const rawMsg = firstErr?.message as string ?? 'Unknown error';
      const summary = buildFailureSummary(rawMsg, {
        stepId: firstErr?.stepId as string | undefined,
        stepType: result.steps?.find(s => s.status === 'failed')?.stepType,
      });
      return { success: false, message: summary, data: result };
    }
  } catch (err) {
    const error = err as Error;
    console.error(`[epic] Unhandled error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    return { success: false, message: buildFailureSummary(error.message) };
  }
}

// ============================================================================
// Subcommand: status
// ============================================================================

async function showStatus(epicNumber: string): Promise<CommandResult> {
  if (!epicNumber) {
    return { success: false, message: 'Usage: flo epic status <epic-number>' };
  }
  console.log(`[epic] Status for epic #${epicNumber}:`);
  console.log('[epic] Reading from spell memory...');

  try {
    const result = await runEpicSpell(
      `name: epic-status-check\nsteps:\n  - id: read-state\n    type: memory\n    config:\n      action: search\n      namespace: epic-state\n      query: "epic ${epicNumber}"`,
      { args: {} },
    );

    if (result.success && result.outputs['read-state']) {
      const data = result.outputs['read-state'] as Record<string, unknown>;
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`[epic] No state found for epic #${epicNumber}`);
    }
  } catch {
    console.log(`[epic] Could not read epic state. Memory may not be initialized.`);
  }

  return { success: true };
}

// ============================================================================
// Subcommand: reset
// ============================================================================

async function resetEpic(epicNumber: string): Promise<CommandResult> {
  if (!epicNumber) {
    return { success: false, message: 'Usage: flo epic reset <epic-number>' };
  }
  console.log(`[epic] Clearing state for epic #${epicNumber}...`);

  try {
    await runEpicSpell(
      `name: epic-reset\nsteps:\n  - id: clear-state\n    type: memory\n    config:\n      action: write\n      namespace: epic-state\n      key: "epic-${epicNumber}"\n      value: null`,
      { args: {} },
    );
    console.log(`[epic] State cleared for epic #${epicNumber}`);
  } catch {
    console.log(`[epic] Could not clear epic state.`);
  }

  return { success: true };
}

// ============================================================================
// Error remediation hints
// ============================================================================

const REMEDIATION_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /working tree is dirty/i, hint: 'Commit, stash, or discard your changes first: git stash --include-untracked' },
  { pattern: /unmerged files/i, hint: 'Resolve merge conflicts first: git status to see which files, then git add after fixing' },
  { pattern: /not an epic/i, hint: 'Add child stories as checklist items (- [ ] #123) or a ## Stories section to the issue body' },
  { pattern: /authentication|401|403/i, hint: 'Check your GitHub credentials: gh auth status' },
  { pattern: /branch.*already exists/i, hint: 'The epic branch already exists. Use: flo epic reset <number> then retry, or delete the branch manually' },
  { pattern: /conflict/i, hint: 'Merge conflicts detected. Pull latest changes and resolve: git pull origin main' },
  { pattern: /ENOENT|not found|cannot find/i, hint: 'A required file or command was not found. Check that all dependencies are installed' },
  { pattern: /timeout/i, hint: 'A step timed out. Retry the epic — it will resume from where it left off' },
];

/** Strip wrapper noise from bash command errors to surface the actual message. */
function cleanError(raw: string): string {
  // "Command exited with code 1: ERROR: actual message" → "actual message"
  let msg = raw.replace(/^Command exited with code \d+:\s*/i, '');
  msg = msg.replace(/^ERROR:\s*/i, '');
  return msg.trim() || raw;
}

/**
 * Build an actionable failure summary.
 * Always includes the cleaned error. Adds a remediation hint when a known
 * pattern matches. When no pattern matches, includes the raw error so
 * Claude (or any AI assistant in the session) can interpret it for the user.
 */
function buildFailureSummary(rawError: string, context?: { stepId?: string; stepType?: string }): string {
  const cleaned = cleanError(rawError);
  const hint = getRemediation(rawError);

  const lines: string[] = [];
  if (context?.stepId) {
    lines.push(`Epic failed at step "${context.stepId}" [${context.stepType ?? 'unknown'}]`);
  } else {
    lines.push('Epic failed');
  }
  lines.push(`  Error: ${cleaned}`);
  if (hint) {
    lines.push(`  Fix: ${hint}`);
  }
  if (rawError !== cleaned) {
    lines.push(`  Raw: ${rawError}`);
  }
  return lines.join('\n');
}

function getRemediation(errorMessage: string): string | undefined {
  for (const { pattern, hint } of REMEDIATION_PATTERNS) {
    if (pattern.test(errorMessage)) return hint;
  }
  return undefined;
}

// ============================================================================
// Command Definition
// ============================================================================

const epicCommand: Command = {
  name: 'epic',
  description: 'Epic orchestrator — runs GitHub epics through spell engine',
  options: [],
  examples: [
    { command: 'flo epic 42', description: 'Execute epic (default: run with single-branch strategy)' },
    { command: 'flo epic 42 --strategy auto-merge', description: 'Execute with per-story PRs and auto-merge' },
    { command: 'flo epic 42 --dry-run', description: 'Show execution plan' },
    { command: 'flo epic run 42', description: 'Explicit run subcommand (same as above)' },
    { command: 'flo epic status 42', description: 'Check epic progress' },
    { command: 'flo epic reset 42', description: 'Reset epic state for re-run' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const subcommand = ctx.args?.[0];

    if (!subcommand) {
      console.log('Usage: flo epic <issue-number> [flags]');
      console.log('       flo epic <command> [args] [flags]');
      console.log('');
      console.log('Commands:');
      console.log('  <issue-number>           Execute epic (shorthand for "run")');
      console.log('  run <issue-number>       Execute a GitHub epic via spell engine');
      console.log('  status <epic-number>     Check epic progress');
      console.log('  reset <epic-number>      Reset epic state for re-run');
      console.log('');
      console.log('Flags:');
      console.log('  --strategy <name>        single-branch (default) or auto-merge');
      console.log('  --dry-run                Show plan without executing');
      return { success: true };
    }

    // If the first arg is a number, default to "run"
    const isNumeric = /^\d+$/.test(subcommand);
    const effectiveCommand = isNumeric ? 'run' : subcommand;
    const commandArgs = isNumeric ? [subcommand, ...ctx.args.slice(1)] : ctx.args.slice(1);

    switch (effectiveCommand) {
      case 'run': {
        const source = commandArgs[0];
        if (!source) {
          return { success: false, message: 'Usage: flo epic <issue-number> [--strategy] [--dry-run]' };
        }
        const dryRun = ctx.flags['dry-run'] === true || ctx.flags['dryRun'] === true;
        const strategyFlag = ctx.flags['strategy'] as string | undefined;
        let strategy: EpicStrategy = 'single-branch';
        if (strategyFlag) {
          if (strategyFlag !== 'single-branch' && strategyFlag !== 'auto-merge') {
            return { success: false, message: `Unknown strategy: "${strategyFlag}". Use "single-branch" or "auto-merge".` };
          }
          strategy = strategyFlag;
        }
        return runEpic(source, strategy, dryRun);
      }

      case 'status':
        return showStatus(commandArgs[0] || '');

      case 'reset':
        return resetEpic(commandArgs[0] || '');

      default:
        return { success: false, message: `Unknown subcommand: ${subcommand}. Available: run, status, reset` };
    }
  },
};

export default epicCommand;
