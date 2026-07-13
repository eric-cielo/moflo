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
 *   flo epic run 42 --no-merge               Force single-branch (alias for --strategy single-branch)
 *   flo epic run 42 --verbose                Echo each step's stdout/stderr after it completes
 *   flo epic status <epic-number>            Check progress via memory
 *   flo epic reset <epic-number>             Clear epic memory state
 *   flo epic checkoff <epic> <story>         Check a story off; close the epic if it was the last
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  isEpicIssue,
  fetchEpicIssue,
  extractStories,
  enrichStoryNames,
  checkOffStoryInEpic,
} from '../epic/index.js';
import type { EpicStrategy } from '../epic/types.js';
import {
  runEpicSpell,
  type PreflightWarning,
  type PreflightWarningDecision,
} from '../epic/runner-adapter.js';
import { locateMofloModulePath } from '../services/moflo-require.js';
import { select } from '../prompt.js';

// ============================================================================
// Spell Template Loader
// ============================================================================
//
// Epic spells live in the canonical shipped directory (`src/cli/spells/definitions/`)
// alongside any other future shipped spells, so `flo spell grimoire list` discovers
// them through the standard resolution path used by `grimoire-builder.ts`. This is
// not a bespoke `import.meta.url` walkup — same locator as every other shipped
// asset. (Issue #755.)

function loadSpellTemplate(strategy: EpicStrategy): string {
  const shippedDir = locateMofloModulePath('cli', 'spells/definitions');
  if (!shippedDir) {
    throw new Error(
      'Cannot locate shipped spell definitions directory (src/cli/spells/definitions/). ' +
        'This indicates a broken moflo install — the directory is in package.json files but missing from the tarball.',
    );
  }
  const filename = strategy === 'auto-merge' ? 'epic-auto-merge.yaml' : 'epic-single-branch.yaml';
  return readFileSync(join(shippedDir, filename), 'utf-8');
}

// ============================================================================
// Subcommand: run
// ============================================================================

async function runEpic(
  source: string,
  strategy: EpicStrategy,
  dryRun: boolean,
  verbose: boolean,
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

  // 2. Extract stories
  const stories = extractStories(issue);
  if (stories.length === 0) {
    return { success: false, message: `No stories found in epic #${issueNumber}` };
  }

  await enrichStoryNames(stories);

  console.log(`[epic] ${issue.title}`);
  console.log(`[epic] Strategy: ${strategy}`);
  console.log(`[epic] Stories (${stories.length}):`);
  for (const s of stories) {
    console.log(`  ${s.issue}: ${s.name}`);
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

  // 3b. Reconcile memory with branch state — if the branch doesn't exist
  //     or has no commits ahead of main, memory is stale (e.g. after a reset)
  if (completedStories.size > 0) {
    const slug = issue.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    const epicBranch = `epic/${issueNumber}-${slug}`;

    let branchHasCommits = false;
    try {
      // Check if the epic branch exists (local or remote) and has commits ahead of main
      const revCheck = execSync(
        `git rev-parse --verify refs/heads/${epicBranch} 2>/dev/null || git rev-parse --verify refs/remotes/origin/${epicBranch} 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      if (revCheck) {
        const aheadCount = execSync(
          `git rev-list --count main..${revCheck}`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        branchHasCommits = parseInt(aheadCount, 10) > 0;
      }
    } catch {
      // Branch doesn't exist — memory is stale
    }

    if (branchHasCommits) {
      console.log(`[epic] Resuming: ${completedStories.size} stories already completed (branch verified)`);
    } else {
      console.log(`[epic] Memory shows ${completedStories.size} completed stories, but epic branch is missing or empty — starting fresh`);
      completedStories = new Set<number>();
    }
  }

  // 4. Build slug for branch name
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);

  // 5. Load spell template and execute
  const yaml = loadSpellTemplate(strategy);
  const allStoryNumbers = stories.map(s => s.issue);
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
        // --verbose: echo captured bash stdout/stderr after the step completes.
        // (Not real-time streaming — the spell engine captures stdio.)
        if (verbose) {
          echoStepOutput(stepResult.output?.data as Record<string, unknown> | undefined, '');
        }
      },
      onPreflightWarnings: isInteractive() ? resolvePreflightWarningsInteractively : undefined,
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
      const firstErr = result.errors[0] as Record<string, unknown> | undefined;
      const errCode = firstErr?.code as string | undefined;

      // Preflight failures are user environment problems, not epic bugs.
      // Show only the friendly prerequisite message, nothing else.
      if (errCode === 'PREFLIGHT_FAILED' && typeof firstErr?.message === 'string') {
        console.log(`\n${firstErr.message}`);
        console.log('\nThe epic was not started. Fix the item(s) above and try again.');
        return { success: false, message: firstErr.message, data: result };
      }

      console.log(`\n[epic] Epic #${issueNumber} failed`);

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
// --verbose output echo
// ============================================================================

function echoStream(stream: string, indent: string, kind: 'stdout' | 'stderr'): void {
  for (const line of stream.split(/\r?\n/)) {
    if (line) {
      const prefix = kind === 'stderr' ? '(stderr) ' : '';
      console.log(`[epic] ${indent}│ ${prefix}${line}`);
    }
  }
}

function echoStepOutput(data: Record<string, unknown> | undefined, indent: string): void {
  if (!data) return;

  const stdout = typeof data.stdout === 'string' ? data.stdout : undefined;
  const stderr = typeof data.stderr === 'string' ? data.stderr : undefined;
  if (stdout) echoStream(stdout, indent, 'stdout');
  if (stderr) echoStream(stderr, indent, 'stderr');

  // Loop step: walk each iteration's nested-step outputs.
  const iterationOutputs = data.iterationOutputs;
  if (Array.isArray(iterationOutputs)) {
    for (let i = 0; i < iterationOutputs.length; i++) {
      const iter = iterationOutputs[i];
      if (!iter || typeof iter !== 'object') continue;
      console.log(`[epic] ${indent}├─ iteration ${i + 1}/${iterationOutputs.length}`);
      for (const [stepId, stepData] of Object.entries(iter as Record<string, unknown>)) {
        console.log(`[epic] ${indent}│  ├─ ${stepId}`);
        echoStepOutput(stepData as Record<string, unknown> | undefined, indent + '│  │  ');
      }
    }
  }

  // Parallel step: walk each branch's output.
  const stepOutputs = data.stepOutputs;
  if (stepOutputs && typeof stepOutputs === 'object' && !Array.isArray(stepOutputs)) {
    for (const [stepId, stepData] of Object.entries(stepOutputs as Record<string, unknown>)) {
      console.log(`[epic] ${indent}├─ ${stepId}`);
      echoStepOutput(stepData as Record<string, unknown> | undefined, indent + '│  ');
    }
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

  // 1. Find all story keys for this epic from memory
  let storyKeys: string[] = [];
  try {
    const searchResult = await runEpicSpell(
      `name: epic-reset-search\nsteps:\n  - id: find-stories\n    type: memory\n    config:\n      action: search\n      namespace: epic-state\n      query: "epic ${epicNumber} story completed"`,
      { args: {} },
    );
    if (searchResult.success && searchResult.outputs['find-stories']) {
      const data = searchResult.outputs['find-stories'] as { results?: Array<{ key: string }> };
      if (data.results) {
        storyKeys = data.results.map(r => r.key).filter(k => k.startsWith('story-'));
      }
    }
  } catch {
    // Couldn't search — just clear the epic key below
  }

  // 2. Clear epic key + all story keys
  const keysToDelete = [`epic-${epicNumber}`, ...storyKeys];
  let cleared = 0;
  for (const key of keysToDelete) {
    try {
      await runEpicSpell(
        `name: epic-reset-delete\nsteps:\n  - id: delete-key\n    type: memory\n    config:\n      action: write\n      namespace: epic-state\n      key: "${key}"\n      value: null`,
        { args: {} },
      );
      cleared++;
    } catch {
      // Key may not exist — safe to ignore
    }
  }

  console.log(`[epic] Cleared ${cleared} memory entries for epic #${epicNumber}`);
  return { success: true };
}

// ============================================================================
// Subcommand: checkoff
// ============================================================================

async function checkOffStory(epicArg: string, storyArg: string): Promise<CommandResult> {
  const epic = parseInt(epicArg, 10);
  const story = parseInt(storyArg, 10);
  if (isNaN(epic) || isNaN(story)) {
    return { success: false, message: 'Usage: flo epic checkoff <epic-number> <story-number>' };
  }

  try {
    const { checked, epicClosed, alreadyClosed } = await checkOffStoryInEpic(epic, story);
    const parts: string[] = [];
    parts.push(
      checked
        ? `Checked off story #${story} in epic #${epic}.`
        : `Story #${story} was already checked (or not listed) in epic #${epic}.`,
    );
    if (epicClosed) parts.push(`All stories complete — closed epic #${epic}.`);
    else if (alreadyClosed) parts.push(`Epic #${epic} was already closed.`);
    const message = parts.join(' ');
    console.log(`[epic] ${message}`);
    return { success: true, message };
  } catch (err) {
    return {
      success: false,
      message: buildFailureSummary((err as Error).message, { stepId: 'checkoff' }),
    };
  }
}

// ============================================================================
// Preflight warning interactive resolver
// ============================================================================

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.CI !== 'true';
}

async function resolvePreflightWarningsInteractively(
  warnings: readonly PreflightWarning[],
): Promise<readonly PreflightWarningDecision[]> {
  console.log('\nBefore this spell starts, some things need your attention:\n');

  const decisions: PreflightWarningDecision[] = [];
  for (let i = 0; i < warnings.length; i++) {
    const w = warnings[i];
    const choices = [
      ...w.resolutions.map((r, idx) => ({
        label: r.label,
        value: { action: 'resolve', resolutionIndex: idx } as PreflightWarningDecision,
      })),
      { label: "Continue anyway (I'll handle it)", value: { action: 'continue' } as PreflightWarningDecision },
      { label: 'Abort the spell', value: { action: 'abort' } as PreflightWarningDecision },
    ];

    const decision = await select<PreflightWarningDecision>({
      message: `${i + 1}. ${w.reason}`,
      options: choices,
    });
    decisions.push(decision);

    if (decision.action === 'abort') {
      while (decisions.length < warnings.length) decisions.push({ action: 'abort' });
      break;
    }
  }
  return decisions;
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
    { command: 'flo epic 42 --no-merge', description: 'Force single-branch strategy (alias for --strategy single-branch)' },
    { command: 'flo epic 42 --verbose', description: 'Echo each step\'s captured stdout/stderr after it completes' },
    { command: 'flo epic 42 --dry-run', description: 'Show execution plan' },
    { command: 'flo epic run 42', description: 'Explicit run subcommand (same as above)' },
    { command: 'flo epic status 42', description: 'Check epic progress' },
    { command: 'flo epic reset 42', description: 'Reset epic state for re-run' },
    { command: 'flo epic checkoff 42 43', description: 'Check story #43 off in epic #42; close #42 if it was the last story' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const subcommand = ctx.args?.[0];

    if (!subcommand) {
      console.log('Usage: flo epic <issue-number> [flags]');
      console.log('       flo epic <command> [args] [flags]');
      console.log('');
      console.log('Commands:');
      console.log('  <issue-number>              Execute epic (shorthand for "run")');
      console.log('  run <issue-number>          Execute a GitHub epic via spell engine');
      console.log('  status <epic-number>        Check epic progress');
      console.log('  reset <epic-number>         Reset epic state for re-run');
      console.log('  checkoff <epic> <story>     Check a story off in its epic; close the epic if it was the last');
      console.log('');
      console.log('Flags:');
      console.log('  --strategy <name>        single-branch (default) or auto-merge');
      console.log('  --no-merge               Force single-branch (alias for --strategy single-branch)');
      console.log('  --verbose                Echo each step\'s captured stdout/stderr after it completes');
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
          return { success: false, message: 'Usage: flo epic <issue-number> [--strategy] [--no-merge] [--verbose] [--dry-run]' };
        }
        const dryRun = ctx.flags.dryRun === true;
        const noMerge = ctx.flags.noMerge === true;
        const verbose = ctx.flags['verbose'] === true;
        const strategyFlag = ctx.flags['strategy'] as string | undefined;
        let strategy: EpicStrategy = 'single-branch';
        if (strategyFlag) {
          if (strategyFlag !== 'single-branch' && strategyFlag !== 'auto-merge') {
            return { success: false, message: `Unknown strategy: "${strategyFlag}". Use "single-branch" or "auto-merge".` };
          }
          strategy = strategyFlag;
        }
        // --no-merge is an alias for single-branch. Reject when paired with auto-merge.
        if (noMerge) {
          if (strategyFlag === 'auto-merge') {
            return {
              success: false,
              message: '--no-merge cannot be combined with --strategy auto-merge. --no-merge is an alias for --strategy single-branch.',
            };
          }
          strategy = 'single-branch';
        }
        return runEpic(source, strategy, dryRun, verbose);
      }

      case 'status':
        return showStatus(commandArgs[0] || '');

      case 'reset':
        return resetEpic(commandArgs[0] || '');

      case 'checkoff':
        return checkOffStory(commandArgs[0] || '', commandArgs[1] || '');

      default:
        return { success: false, message: `Unknown subcommand: ${subcommand}. Available: run, status, reset, checkoff` };
    }
  },
};

export default epicCommand;
