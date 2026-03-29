/**
 * MoFlo Epic Command — Thin Workflow Runner Wrapper
 *
 * Story #197: Refactored from ~1153-line ad-hoc orchestrator to thin wrapper
 * that loads workflow YAML templates and runs them via WorkflowRunner.
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
import { runEpicWorkflow } from '../epic/runner-adapter.js';

// ============================================================================
// Workflow Template Loader
// ============================================================================

const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'epic', 'workflows');

function loadWorkflowTemplate(strategy: EpicStrategy): string {
  const filename = strategy === 'auto-merge' ? 'auto-merge.yaml' : 'single-branch.yaml';
  return readFileSync(join(WORKFLOWS_DIR, filename), 'utf-8');
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

  console.log(`[epic] ${issue.title}`);
  console.log(`[epic] Strategy: ${strategy}`);
  console.log(`[epic] Stories (${stories.length}):`);
  for (const id of plan.order) {
    const s = stories.find(st => st.id === id)!;
    console.log(`  ${s.issue}: ${s.name}`);
  }
  console.log('');

  // 3. Build slug for branch name
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);

  // 4. Load workflow template and execute
  const yaml = loadWorkflowTemplate(strategy);
  const storyNumbers = plan.order.map(id => {
    const s = stories.find(st => st.id === id)!;
    return s.issue;
  });

  const args = {
    epic_number: issueNumber,
    base_branch: 'main',
    stories: JSON.stringify(storyNumbers),
    epic_slug: slug,
    admin_merge: false,
    merge_method: 'squash',
  };

  if (dryRun) {
    console.log('[epic] Dry-run mode — showing execution plan:');
    console.log(`[epic] Workflow: ${strategy}`);
    console.log(`[epic] Args: ${JSON.stringify(args, null, 2)}`);
    console.log('[epic] Stories would be processed in order:');
    for (const num of storyNumbers) {
      const s = stories.find(st => st.issue === num)!;
      console.log(`  #${num}: ${s.name}`);
    }

    try {
      const result = await runEpicWorkflow(yaml, undefined, {
        args, dryRun: true,
      });

      if (result.success) {
        console.log('[epic] Dry-run: workflow is valid');
      } else {
        console.log('[epic] Dry-run: workflow has validation errors:');
        for (const err of result.errors) {
          console.log(`  - ${err.message}`);
        }
      }
    } catch (err) {
      console.log(`[epic] Dry-run validation error: ${(err as Error).message}`);
    }

    return { success: true, message: 'Dry-run complete' };
  }

  // 5. Execute workflow
  console.log(`[epic] Executing ${strategy} workflow...`);
  let stepCount = 0;

  try {
    const result = await runEpicWorkflow(yaml, undefined, {
      args,
      onStepComplete: (stepResult, index, total) => {
        stepCount++;
        const status = stepResult.status === 'succeeded' ? '✓' : '✗';
        console.log(`[epic] Step ${stepCount}/${total}: ${status} ${stepResult.stepId} (${stepResult.duration}ms)`);
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
      for (const err of result.errors) {
        console.log(`  Error: ${err.message}`);
      }
      return { success: false, message: 'Epic failed', data: result };
    }
  } catch (err) {
    return { success: false, message: `Epic execution error: ${(err as Error).message}` };
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
  console.log('[epic] Reading from workflow memory...');

  try {
    const result = await runEpicWorkflow(
      `name: epic-status-check\nsteps:\n  - id: read-state\n    type: memory\n    config:\n      action: search\n      namespace: epic-state\n      query: "epic ${epicNumber}"`,
      undefined,
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
    await runEpicWorkflow(
      `name: epic-reset\nsteps:\n  - id: clear-state\n    type: memory\n    config:\n      action: write\n      namespace: epic-state\n      key: "epic-${epicNumber}"\n      value: null`,
      undefined,
      { args: {} },
    );
    console.log(`[epic] State cleared for epic #${epicNumber}`);
  } catch {
    console.log(`[epic] Could not clear epic state.`);
  }

  return { success: true };
}

// ============================================================================
// Command Definition
// ============================================================================

const epicCommand: Command = {
  name: 'epic',
  description: 'Epic orchestrator — runs GitHub epics through workflow engine',
  options: [],
  examples: [
    { command: 'flo epic run 42', description: 'Execute epic (default: single-branch strategy)' },
    { command: 'flo epic run 42 --strategy auto-merge', description: 'Execute with per-story PRs and auto-merge' },
    { command: 'flo epic run 42 --dry-run', description: 'Show execution plan' },
    { command: 'flo epic status 42', description: 'Check epic progress' },
    { command: 'flo epic reset 42', description: 'Reset epic state for re-run' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const subcommand = ctx.args?.[0];

    if (!subcommand) {
      console.log('Usage: flo epic <command> [args] [flags]');
      console.log('');
      console.log('Commands:');
      console.log('  run <issue-number>       Execute a GitHub epic via workflow engine');
      console.log('  status <epic-number>     Check epic progress');
      console.log('  reset <epic-number>      Reset epic state for re-run');
      console.log('');
      console.log('Flags:');
      console.log('  --strategy <name>        single-branch (default) or auto-merge');
      console.log('  --dry-run                Show plan without executing');
      return { success: true };
    }

    switch (subcommand) {
      case 'run': {
        const source = ctx.args[1];
        if (!source) {
          return { success: false, message: 'Usage: flo epic run <issue-number> [--strategy] [--dry-run]' };
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
        return showStatus(ctx.args[1] || '');

      case 'reset':
        return resetEpic(ctx.args[1] || '');

      default:
        return { success: false, message: `Unknown subcommand: ${subcommand}. Available: run, status, reset` };
    }
  },
};

export default epicCommand;
