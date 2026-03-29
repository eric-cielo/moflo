/**
 * GitHub Step Command — typed GitHub operations via `gh` CLI.
 *
 * Story #194: First-class `github` step type for workflow engine.
 * Wraps the `gh` CLI to avoid new HTTP dependencies while providing
 * structured validation, JSON output parsing, and rollback for PR creation.
 */

import { exec } from 'node:child_process';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  Prerequisite,
} from '../types/step-command.types.js';
import { interpolateString } from '../core/interpolation.js';
import { commandExists } from '../core/prerequisite-checker.js';

// ============================================================================
// Config
// ============================================================================

export type GitHubAction =
  | 'issue-fetch'
  | 'issue-edit'
  | 'pr-create'
  | 'pr-merge'
  | 'pr-find'
  | 'label'
  | 'comment'
  | 'repo-info';

export interface GitHubStepConfig extends StepConfig {
  readonly action: GitHubAction;
  readonly issue?: number;
  readonly pr?: number;
  readonly title?: string;
  readonly body?: string;
  readonly base?: string;
  readonly head?: string;
  readonly labels?: { add?: string[]; remove?: string[] };
  readonly search?: string;
  readonly mergeMethod?: 'squash' | 'merge' | 'rebase';
  readonly deleteBranch?: boolean;
  readonly admin?: boolean;
  readonly fields?: string[];
}

// ============================================================================
// Prerequisites
// ============================================================================

const githubPrerequisites: readonly Prerequisite[] = [
  {
    name: 'gh',
    check: () => commandExists('gh'),
    installHint: 'Install GitHub CLI: https://cli.github.com — then run: gh auth login',
    url: 'https://cli.github.com',
  },
  {
    name: 'gh-auth',
    check: async () => {
      try {
        const result = await execAsync('gh auth status', 5000);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    installHint: 'Authenticate GitHub CLI: gh auth login',
    url: 'https://cli.github.com/manual/gh_auth_login',
  },
];

// ============================================================================
// Shell helper
// ============================================================================

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execAsync(command: string, timeout = 30000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = exec(command, { timeout, shell: 'bash' }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: child.exitCode ?? (error ? 1 : 0),
      });
    });
  });
}

// ============================================================================
// Action validators
// ============================================================================

const VALID_ACTIONS: readonly GitHubAction[] = [
  'issue-fetch', 'issue-edit', 'pr-create', 'pr-merge',
  'pr-find', 'label', 'comment', 'repo-info',
];

const VALID_MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;

function validateAction(config: GitHubStepConfig): string[] {
  const errors: string[] = [];

  if (!config.action || !VALID_ACTIONS.includes(config.action)) {
    errors.push(`action must be one of: ${VALID_ACTIONS.join(', ')}`);
    return errors;
  }

  switch (config.action) {
    case 'issue-fetch':
      if (!config.issue) errors.push('issue-fetch requires issue number');
      break;
    case 'issue-edit':
      if (!config.issue) errors.push('issue-edit requires issue number');
      break;
    case 'pr-create':
      if (!config.title) errors.push('pr-create requires title');
      break;
    case 'pr-merge':
      if (!config.pr && !config.issue) errors.push('pr-merge requires pr or issue number');
      if (config.mergeMethod && !VALID_MERGE_METHODS.includes(config.mergeMethod as typeof VALID_MERGE_METHODS[number])) {
        errors.push(`mergeMethod must be one of: ${VALID_MERGE_METHODS.join(', ')}`);
      }
      break;
    case 'pr-find':
      if (!config.head && !config.search) errors.push('pr-find requires head branch or search query');
      break;
    case 'label':
      if (!config.issue && !config.pr) errors.push('label requires issue or pr number');
      if (!config.labels) errors.push('label requires labels config');
      break;
    case 'comment':
      if (!config.issue && !config.pr) errors.push('comment requires issue or pr number');
      if (!config.body) errors.push('comment requires body');
      break;
    case 'repo-info':
      break;
  }

  return errors;
}

// ============================================================================
// Action executors
// ============================================================================

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function executeAction(config: GitHubStepConfig, context: WorkflowContext): Promise<StepOutput> {
  const start = Date.now();
  const interp = (s: string | undefined) => s ? interpolateString(s, context) : s;

  switch (config.action) {
    case 'issue-fetch':
      return executeIssueFetch(config, start);
    case 'issue-edit':
      return executeIssueEdit(config, interp, start);
    case 'pr-create':
      return executePrCreate(config, interp, start);
    case 'pr-merge':
      return executePrMerge(config, start);
    case 'pr-find':
      return executePrFind(config, interp, start);
    case 'label':
      return executeLabel(config, start);
    case 'comment':
      return executeComment(config, interp, start);
    case 'repo-info':
      return executeRepoInfo(start);
    default:
      return { success: false, data: {}, error: `Unknown action: ${config.action}`, duration: Date.now() - start };
  }
}

async function executeIssueFetch(config: GitHubStepConfig, start: number): Promise<StepOutput> {
  const fields = config.fields?.join(',') || 'number,title,body,labels,state,assignees';
  const result = await execAsync(`gh issue view ${config.issue} --json ${fields}`);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to fetch issue #${config.issue}`, duration: Date.now() - start };
  }
  return { success: true, data: JSON.parse(result.stdout), duration: Date.now() - start };
}

async function executeIssueEdit(config: GitHubStepConfig, interp: (s: string | undefined) => string | undefined, start: number): Promise<StepOutput> {
  const args: string[] = [`gh issue edit ${config.issue}`];
  if (config.title) args.push(`--title ${escapeShellArg(interp(config.title)!)}`);
  if (config.body) args.push(`--body ${escapeShellArg(interp(config.body)!)}`);
  if (config.labels?.add) {
    for (const l of config.labels.add) args.push(`--add-label ${escapeShellArg(l)}`);
  }
  if (config.labels?.remove) {
    for (const l of config.labels.remove) args.push(`--remove-label ${escapeShellArg(l)}`);
  }

  const result = await execAsync(args.join(' '));
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to edit issue #${config.issue}`, duration: Date.now() - start };
  }
  return { success: true, data: { issue: config.issue, updated: true }, duration: Date.now() - start };
}

async function executePrCreate(config: GitHubStepConfig, interp: (s: string | undefined) => string | undefined, start: number): Promise<StepOutput> {
  const args: string[] = ['gh pr create'];
  args.push(`--title ${escapeShellArg(interp(config.title)!)}`);
  if (config.body) args.push(`--body ${escapeShellArg(interp(config.body)!)}`);
  if (config.base) args.push(`--base ${escapeShellArg(interp(config.base)!)}`);
  if (config.head) args.push(`--head ${escapeShellArg(interp(config.head)!)}`);
  if (config.labels?.add) {
    for (const l of config.labels.add) args.push(`--label ${escapeShellArg(l)}`);
  }

  const result = await execAsync(args.join(' '), 60000);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || 'Failed to create PR', duration: Date.now() - start };
  }

  // gh pr create outputs the PR URL
  const prUrl = result.stdout.trim();
  const prNumber = parseInt(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '0', 10);

  return { success: true, data: { prUrl, prNumber }, duration: Date.now() - start };
}

async function executePrMerge(config: GitHubStepConfig, start: number): Promise<StepOutput> {
  const prRef = config.pr ?? config.issue;
  const args: string[] = [`gh pr merge ${prRef}`];
  args.push(`--${config.mergeMethod ?? 'squash'}`);
  if (config.deleteBranch !== false) args.push('--delete-branch');
  if (config.admin) args.push('--admin');

  const result = await execAsync(args.join(' '), 60000);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to merge PR #${prRef}`, duration: Date.now() - start };
  }
  return { success: true, data: { pr: prRef, merged: true, method: config.mergeMethod ?? 'squash' }, duration: Date.now() - start };
}

async function executePrFind(config: GitHubStepConfig, interp: (s: string | undefined) => string | undefined, start: number): Promise<StepOutput> {
  let cmd: string;
  if (config.head) {
    cmd = `gh pr list --head ${escapeShellArg(interp(config.head)!)} --json number,title,state,url --limit 1`;
  } else {
    cmd = `gh pr list --search ${escapeShellArg(interp(config.search)!)} --json number,title,state,url --limit 10`;
  }

  const result = await execAsync(cmd);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || 'Failed to find PR', duration: Date.now() - start };
  }

  const prs = JSON.parse(result.stdout);
  return { success: true, data: { prs, count: prs.length }, duration: Date.now() - start };
}

async function executeLabel(config: GitHubStepConfig, start: number): Promise<StepOutput> {
  const ref = config.issue ?? config.pr;
  const args: string[] = [`gh issue edit ${ref}`];
  if (config.labels?.add) {
    for (const l of config.labels.add) args.push(`--add-label ${escapeShellArg(l)}`);
  }
  if (config.labels?.remove) {
    for (const l of config.labels.remove) args.push(`--remove-label ${escapeShellArg(l)}`);
  }

  const result = await execAsync(args.join(' '));
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to update labels for #${ref}`, duration: Date.now() - start };
  }
  return { success: true, data: { ref, labelsAdded: config.labels?.add, labelsRemoved: config.labels?.remove }, duration: Date.now() - start };
}

async function executeComment(config: GitHubStepConfig, interp: (s: string | undefined) => string | undefined, start: number): Promise<StepOutput> {
  const ref = config.issue ?? config.pr;
  const body = interp(config.body)!;
  const result = await execAsync(`gh issue comment ${ref} --body ${escapeShellArg(body)}`);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to comment on #${ref}`, duration: Date.now() - start };
  }
  return { success: true, data: { ref, commented: true }, duration: Date.now() - start };
}

async function executeRepoInfo(start: number): Promise<StepOutput> {
  const result = await execAsync('gh repo view --json name,owner,url,defaultBranchRef,description');
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || 'Failed to get repo info', duration: Date.now() - start };
  }
  return { success: true, data: JSON.parse(result.stdout), duration: Date.now() - start };
}

// ============================================================================
// GitHub Step Command
// ============================================================================

export const githubCommand: StepCommand<GitHubStepConfig> = {
  type: 'github',
  description: 'GitHub operations via gh CLI (issues, PRs, labels, comments)',
  capabilities: [{ type: 'shell' }],
  defaultMofloLevel: 'none',
  prerequisites: githubPrerequisites,

  configSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...VALID_ACTIONS],
        description: 'GitHub operation to perform',
      },
      issue: { type: 'number', description: 'Issue number' },
      pr: { type: 'number', description: 'PR number' },
      title: { type: 'string', description: 'Title for PR or issue' },
      body: { type: 'string', description: 'Body text for PR, issue, or comment' },
      base: { type: 'string', description: 'Base branch for PR' },
      head: { type: 'string', description: 'Head branch for PR' },
      labels: {
        type: 'object',
        description: 'Labels to add/remove',
        properties: {
          add: { type: 'array', items: { type: 'string' } },
          remove: { type: 'array', items: { type: 'string' } },
        },
      },
      search: { type: 'string', description: 'Search query for pr-find' },
      mergeMethod: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'PR merge method' },
      deleteBranch: { type: 'boolean', description: 'Delete branch after merge', default: true },
      admin: { type: 'boolean', description: 'Use admin privileges for merge' },
      fields: { type: 'array', items: { type: 'string' }, description: 'JSON fields to fetch' },
    },
    required: ['action'],
  } satisfies JSONSchema,

  validate(config: GitHubStepConfig): ValidationResult {
    const actionErrors = validateAction(config);
    return {
      valid: actionErrors.length === 0,
      errors: actionErrors.map(msg => ({ path: 'config', message: msg })),
    };
  },

  async execute(config: GitHubStepConfig, context: WorkflowContext): Promise<StepOutput> {
    return executeAction(config, context);
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'prUrl', type: 'string', description: 'PR URL (pr-create)' },
      { name: 'prNumber', type: 'number', description: 'PR number (pr-create)' },
      { name: 'merged', type: 'boolean', description: 'Whether PR was merged (pr-merge)' },
      { name: 'prs', type: 'array', description: 'Found PRs (pr-find)' },
      { name: 'updated', type: 'boolean', description: 'Whether issue was updated (issue-edit)' },
      { name: 'commented', type: 'boolean', description: 'Whether comment was added' },
    ];
  },

  async rollback(config: GitHubStepConfig): Promise<void> {
    // Only pr-create is rollback-able (close the PR)
    if (config.action !== 'pr-create') return;
    // The PR URL/number would be in the step output, but rollback receives config.
    // We find the most recent PR by head branch and close it.
    if (config.head) {
      await execAsync(`gh pr close ${escapeShellArg(config.head)}`);
    }
  },
};
