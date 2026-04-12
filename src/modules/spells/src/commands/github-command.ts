/**
 * GitHub Step Command — typed GitHub operations via `gh` CLI.
 *
 * Story #194: First-class `github` step type for spell engine.
 * Issue #219: Refactored to delegate to the `github-cli` spell connector.
 *
 * This is now a thin step wrapper. The reusable gh CLI adapter logic
 * lives in `../connectors/github-cli.ts` so custom steps can also use it
 * via `context.tools.execute('github-cli', action, params)`.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  Prerequisite,
  PreflightCheck,
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
// Preflights — runtime state checks
// ============================================================================

/** Confirm an issue/PR number referenced in config actually exists. */
const githubPreflights: readonly PreflightCheck<GitHubStepConfig>[] = [
  {
    name: 'issue-exists',
    check: async (config) => {
      if (typeof config.issue !== 'number') return { passed: true };
      // Skip for create-type actions that don't require the issue to exist.
      if (config.action === 'issue-edit' || config.action === 'issue-fetch' || config.action === 'comment' || config.action === 'label') {
        const result = await execAsync(`gh issue view ${config.issue} --json number`, 5000);
        if (result.exitCode === 0) return { passed: true };
        return { passed: false, reason: `issue #${config.issue} not found or not accessible` };
      }
      return { passed: true };
    },
  },
  {
    name: 'pr-exists',
    check: async (config) => {
      if (typeof config.pr !== 'number') return { passed: true };
      if (config.action === 'pr-merge' || config.action === 'pr-find') {
        const result = await execAsync(`gh pr view ${config.pr} --json number`, 5000);
        if (result.exitCode === 0) return { passed: true };
        return { passed: false, reason: `PR #${config.pr} not found or not accessible` };
      }
      return { passed: true };
    },
  },
];

// ============================================================================
// GitHub Step Command (thin wrapper delegating to github-cli tool)
// ============================================================================

export const githubCommand: StepCommand<GitHubStepConfig> = {
  type: 'github',
  description: 'GitHub operations via gh CLI (issues, PRs, labels, comments)',
  capabilities: [{ type: 'shell' }, { type: 'net' }],
  defaultMofloLevel: 'none',
  prerequisites: githubPrerequisites,
  preflight: githubPreflights,

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

  async execute(config: GitHubStepConfig, context: CastingContext): Promise<StepOutput> {
    // Enforce shell capability scope on the gh action (Issue #258 — gateway enforcement)
    try {
      context.gateway.checkShell(`gh ${config.action}`);
    } catch (err) {
      return {
        success: false,
        data: { action: config.action },
        error: (err as Error).message,
      };
    }

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
