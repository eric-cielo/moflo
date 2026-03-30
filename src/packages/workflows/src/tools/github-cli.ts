/**
 * GitHub CLI Workflow Tool
 *
 * Reusable `gh` CLI adapter implementing WorkflowTool interface.
 * Extracted from the monolithic github step command (Issue #219)
 * so custom workflow steps can use GitHub operations via context.tools.
 *
 * Actions: issue-fetch, issue-edit, pr-create, pr-merge, pr-find,
 *          label, comment, repo-info
 */

import { exec } from 'node:child_process';
import type { WorkflowTool, ToolAction, ToolOutput } from '../types/workflow-tool.types.js';
import { commandExists } from '../core/prerequisite-checker.js';

// ============================================================================
// Types
// ============================================================================

export type GitHubCliAction =
  | 'issue-fetch'
  | 'issue-edit'
  | 'pr-create'
  | 'pr-merge'
  | 'pr-find'
  | 'label'
  | 'comment'
  | 'repo-info';

export const VALID_ACTIONS: readonly GitHubCliAction[] = [
  'issue-fetch', 'issue-edit', 'pr-create', 'pr-merge',
  'pr-find', 'label', 'comment', 'repo-info',
];

const VALID_MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;

// ============================================================================
// Shell helpers (exported for step command reuse)
// ============================================================================

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execAsync(command: string, timeout = 30000): Promise<ExecResult> {
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

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Action executors
// ============================================================================

async function executeIssueFetch(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  const issue = params.issue as number;
  const fields = (params.fields as string[])?.join(',') || 'number,title,body,labels,state,assignees';
  const result = await execAsync(`gh issue view ${issue} --json ${fields}`);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to fetch issue #${issue}`, duration: Date.now() - start };
  }
  return { success: true, data: JSON.parse(result.stdout), duration: Date.now() - start };
}

function appendLabelArgs(args: string[], labels: { add?: string[]; remove?: string[] } | undefined): void {
  if (labels?.add) {
    for (const l of labels.add) args.push(`--add-label ${escapeShellArg(l)}`);
  }
  if (labels?.remove) {
    for (const l of labels.remove) args.push(`--remove-label ${escapeShellArg(l)}`);
  }
}

async function executeIssueEdit(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  const issue = params.issue as number;
  const args: string[] = [`gh issue edit ${issue}`];
  if (params.title) args.push(`--title ${escapeShellArg(params.title as string)}`);
  if (params.body) args.push(`--body ${escapeShellArg(params.body as string)}`);
  appendLabelArgs(args, params.labels as { add?: string[]; remove?: string[] } | undefined);

  const result = await execAsync(args.join(' '));
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to edit issue #${issue}`, duration: Date.now() - start };
  }
  return { success: true, data: { issue, updated: true }, duration: Date.now() - start };
}

async function executePrCreate(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  const args: string[] = ['gh pr create'];
  args.push(`--title ${escapeShellArg(params.title as string)}`);
  if (params.body) args.push(`--body ${escapeShellArg(params.body as string)}`);
  if (params.base) args.push(`--base ${escapeShellArg(params.base as string)}`);
  if (params.head) args.push(`--head ${escapeShellArg(params.head as string)}`);
  const labels = params.labels as { add?: string[] } | undefined;
  if (labels?.add) {
    for (const l of labels.add) args.push(`--label ${escapeShellArg(l)}`);
  }

  const result = await execAsync(args.join(' '), 60000);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || 'Failed to create PR', duration: Date.now() - start };
  }

  const prUrl = result.stdout.trim();
  const prNumber = parseInt(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '0', 10);
  return { success: true, data: { prUrl, prNumber }, duration: Date.now() - start };
}

async function executePrMerge(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  const prRef = (params.pr ?? params.issue) as number;
  const mergeMethod = (params.mergeMethod as string) ?? 'squash';
  const args: string[] = [`gh pr merge ${prRef}`];
  args.push(`--${mergeMethod}`);
  if (params.deleteBranch !== false) args.push('--delete-branch');
  if (params.admin) args.push('--admin');

  const result = await execAsync(args.join(' '), 60000);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to merge PR #${prRef}`, duration: Date.now() - start };
  }
  return { success: true, data: { pr: prRef, merged: true, method: mergeMethod }, duration: Date.now() - start };
}

async function executePrFind(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  let cmd: string;
  if (params.head) {
    cmd = `gh pr list --head ${escapeShellArg(params.head as string)} --json number,title,state,url --limit 1`;
  } else {
    cmd = `gh pr list --search ${escapeShellArg(params.search as string)} --json number,title,state,url --limit 10`;
  }

  const result = await execAsync(cmd);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || 'Failed to find PR', duration: Date.now() - start };
  }

  const prs = JSON.parse(result.stdout);
  return { success: true, data: { prs, count: prs.length }, duration: Date.now() - start };
}

async function executeLabel(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  const ref = (params.issue ?? params.pr) as number;
  const args: string[] = [`gh issue edit ${ref}`];
  appendLabelArgs(args, params.labels as { add?: string[]; remove?: string[] } | undefined);

  const result = await execAsync(args.join(' '));
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to update labels for #${ref}`, duration: Date.now() - start };
  }
  const labels = params.labels as { add?: string[]; remove?: string[] } | undefined;
  return { success: true, data: { ref, labelsAdded: labels?.add, labelsRemoved: labels?.remove }, duration: Date.now() - start };
}

async function executeComment(params: Record<string, unknown>, start: number): Promise<ToolOutput> {
  const ref = (params.issue ?? params.pr) as number;
  const body = params.body as string;
  const result = await execAsync(`gh issue comment ${ref} --body ${escapeShellArg(body)}`);
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || `Failed to comment on #${ref}`, duration: Date.now() - start };
  }
  return { success: true, data: { ref, commented: true }, duration: Date.now() - start };
}

async function executeRepoInfo(start: number): Promise<ToolOutput> {
  const result = await execAsync('gh repo view --json name,owner,url,defaultBranchRef,description');
  if (result.exitCode !== 0) {
    return { success: false, data: {}, error: result.stderr || 'Failed to get repo info', duration: Date.now() - start };
  }
  return { success: true, data: JSON.parse(result.stdout), duration: Date.now() - start };
}

// ============================================================================
// Validation (exported for step command reuse)
// ============================================================================

export function validateGitHubAction(action: string, params: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (!action || !VALID_ACTIONS.includes(action as GitHubCliAction)) {
    errors.push(`action must be one of: ${VALID_ACTIONS.join(', ')}`);
    return errors;
  }

  switch (action) {
    case 'issue-fetch':
      if (!params.issue) errors.push('issue-fetch requires issue number');
      break;
    case 'issue-edit':
      if (!params.issue) errors.push('issue-edit requires issue number');
      break;
    case 'pr-create':
      if (!params.title) errors.push('pr-create requires title');
      break;
    case 'pr-merge':
      if (!params.pr && !params.issue) errors.push('pr-merge requires pr or issue number');
      if (params.mergeMethod && !VALID_MERGE_METHODS.includes(params.mergeMethod as typeof VALID_MERGE_METHODS[number])) {
        errors.push(`mergeMethod must be one of: ${VALID_MERGE_METHODS.join(', ')}`);
      }
      break;
    case 'pr-find':
      if (!params.head && !params.search) errors.push('pr-find requires head branch or search query');
      break;
    case 'label':
      if (!params.issue && !params.pr) errors.push('label requires issue or pr number');
      if (!params.labels) errors.push('label requires labels config');
      break;
    case 'comment':
      if (!params.issue && !params.pr) errors.push('comment requires issue or pr number');
      if (!params.body) errors.push('comment requires body');
      break;
    case 'repo-info':
      break;
  }

  return errors;
}

// ============================================================================
// Action schemas
// ============================================================================

const ACTIONS: ToolAction[] = [
  {
    name: 'issue-fetch',
    description: 'Fetch issue details as JSON',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number', description: 'Issue number' },
        fields: { type: 'array', items: { type: 'string' }, description: 'JSON fields to fetch' },
      },
      required: ['issue'],
    },
    outputSchema: { type: 'object', description: 'Issue data from GitHub' },
  },
  {
    name: 'issue-edit',
    description: 'Edit issue title, body, or labels',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number', description: 'Issue number' },
        title: { type: 'string', description: 'New title' },
        body: { type: 'string', description: 'New body' },
        labels: { type: 'object', description: 'Labels to add/remove' },
      },
      required: ['issue'],
    },
    outputSchema: { type: 'object', properties: { issue: { type: 'number' }, updated: { type: 'boolean' } } },
  },
  {
    name: 'pr-create',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR body' },
        base: { type: 'string', description: 'Base branch' },
        head: { type: 'string', description: 'Head branch' },
        labels: { type: 'object', description: 'Labels to add' },
      },
      required: ['title'],
    },
    outputSchema: { type: 'object', properties: { prUrl: { type: 'string' }, prNumber: { type: 'number' } } },
  },
  {
    name: 'pr-merge',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'number', description: 'PR number' },
        issue: { type: 'number', description: 'Issue number (alternative to pr)' },
        mergeMethod: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'Merge method' },
        deleteBranch: { type: 'boolean', description: 'Delete branch after merge', default: true },
        admin: { type: 'boolean', description: 'Use admin privileges' },
      },
    },
    outputSchema: { type: 'object', properties: { pr: { type: 'number' }, merged: { type: 'boolean' }, method: { type: 'string' } } },
  },
  {
    name: 'pr-find',
    description: 'Find pull requests by head branch or search query',
    inputSchema: {
      type: 'object',
      properties: {
        head: { type: 'string', description: 'Head branch name' },
        search: { type: 'string', description: 'Search query' },
      },
    },
    outputSchema: { type: 'object', properties: { prs: { type: 'array' }, count: { type: 'number' } } },
  },
  {
    name: 'label',
    description: 'Add or remove labels on an issue or PR',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number', description: 'Issue number' },
        pr: { type: 'number', description: 'PR number' },
        labels: { type: 'object', description: 'Labels to add/remove' },
      },
    },
    outputSchema: { type: 'object', properties: { ref: { type: 'number' }, labelsAdded: { type: 'array' }, labelsRemoved: { type: 'array' } } },
  },
  {
    name: 'comment',
    description: 'Add a comment to an issue or PR',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number', description: 'Issue number' },
        pr: { type: 'number', description: 'PR number' },
        body: { type: 'string', description: 'Comment body' },
      },
    },
    outputSchema: { type: 'object', properties: { ref: { type: 'number' }, commented: { type: 'boolean' } } },
  },
  {
    name: 'repo-info',
    description: 'Get repository metadata',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', description: 'Repository metadata from GitHub' },
  },
];

// ============================================================================
// GitHub CLI Tool
// ============================================================================

export const githubCliTool: WorkflowTool = {
  name: 'github-cli',
  description: 'GitHub operations via gh CLI (issues, PRs, labels, comments)',
  version: '1.0.0',
  capabilities: ['read', 'write'],

  async initialize(): Promise<void> {
    const ghInstalled = await commandExists('gh');
    if (!ghInstalled) {
      throw new Error('GitHub CLI (gh) is not installed. Install from https://cli.github.com');
    }
    const authResult = await execAsync('gh auth status', 5000);
    if (authResult.exitCode !== 0) {
      throw new Error('GitHub CLI is not authenticated. Run: gh auth login');
    }
  },

  async dispose(): Promise<void> {
    // No cleanup needed
  },

  async execute(action: string, params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now();
    const errors = validateGitHubAction(action, params);
    if (errors.length > 0) {
      return { success: false, data: {}, error: errors.join('; '), duration: Date.now() - start };
    }

    switch (action) {
      case 'issue-fetch':
        return executeIssueFetch(params, start);
      case 'issue-edit':
        return executeIssueEdit(params, start);
      case 'pr-create':
        return executePrCreate(params, start);
      case 'pr-merge':
        return executePrMerge(params, start);
      case 'pr-find':
        return executePrFind(params, start);
      case 'label':
        return executeLabel(params, start);
      case 'comment':
        return executeComment(params, start);
      case 'repo-info':
        return executeRepoInfo(start);
      default:
        return { success: false, data: {}, error: `Unknown action: ${action}`, duration: Date.now() - start };
    }
  },

  listActions(): ToolAction[] {
    return ACTIONS;
  },
};
