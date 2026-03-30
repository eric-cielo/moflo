/**
 * GitHub Step Command — typed GitHub operations via `gh` CLI.
 *
 * Story #194: First-class `github` step type for workflow engine.
 * Issue #219: Refactored to delegate to the `github-cli` workflow connector.
 *
 * This is now a thin step wrapper. The reusable gh CLI adapter logic
 * lives in `../connectors/github-cli.ts` so custom steps can also use it
 * via `context.tools.execute('github-cli', action, params)`.
 */

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
import {
  execAsync,
  escapeShellArg,
  validateGitHubAction,
  githubCliConnector,
  VALID_ACTIONS,
  type GitHubCliAction,
} from '../connectors/github-cli.js';

// ============================================================================
// Config
// ============================================================================

export type GitHubAction = GitHubCliAction;

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
// GitHub Step Command (thin wrapper delegating to github-cli tool)
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
    const errors = validateGitHubAction(config.action, config as unknown as Record<string, unknown>);
    return {
      valid: errors.length === 0,
      errors: errors.map(msg => ({ path: 'config', message: msg })),
    };
  },

  async execute(config: GitHubStepConfig, context: WorkflowContext): Promise<StepOutput> {
    // Interpolate string values before passing to tool
    const interp = (s: string | undefined) => s ? interpolateString(s, context) : s;

    // Build params with interpolated values
    const params: Record<string, unknown> = {
      ...config,
      title: interp(config.title),
      body: interp(config.body),
      base: interp(config.base),
      head: interp(config.head),
      search: interp(config.search),
    };

    // Prefer tool via context if available, otherwise use direct import
    if (context.tools?.has('github-cli')) {
      return context.tools.execute('github-cli', config.action, params);
    }

    return githubCliConnector.execute(config.action, params);
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
    if (config.action !== 'pr-create') return;
    if (config.head) {
      await execAsync(`gh pr close ${escapeShellArg(config.head)}`);
    }
  },
};
