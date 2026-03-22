/**
 * V3 CLI GitHub Command
 * Repository setup: CI/CD pipeline generation, branch protection, repo settings.
 *
 * Uses `gh` CLI for GitHub API calls and project detection from moflo.yaml.
 *
 * Created with motailz.com
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// ============================================================================
// Helpers
// ============================================================================

function runGh(args: string, cwd: string, timeout = 15000, stdin?: string): string {
  return execSync(`gh ${args}`, {
    encoding: 'utf8',
    cwd,
    timeout,
    windowsHide: true,
    input: stdin,
    stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function ghAvailable(): boolean {
  try {
    execSync('gh --version', { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function ghAuthenticated(): boolean {
  try {
    execSync('gh auth status', { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/** Read moflo.yaml and extract project info for CI generation */
function readProjectConfig(cwd: string): {
  name: string;
  extensions: string[];
  testDirs: string[];
  srcDirs: string[];
  hasTypeScript: boolean;
  hasTests: boolean;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
} {
  const defaults = {
    name: '',
    extensions: ['.ts', '.js'],
    testDirs: ['tests'],
    srcDirs: ['src'],
    hasTypeScript: false,
    hasTests: false,
    packageManager: 'npm' as 'npm' | 'pnpm' | 'yarn' | 'bun',
  };

  // Detect project name from package.json
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      defaults.name = pkg.name || '';
    } catch { /* ignore */ }
  }

  // Detect package manager
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) defaults.packageManager = 'bun' as const;
  else if (existsSync(join(cwd, 'pnpm-lock.yaml'))) defaults.packageManager = 'pnpm' as const;
  else if (existsSync(join(cwd, 'yarn.lock'))) defaults.packageManager = 'yarn' as const;

  // Detect TypeScript
  defaults.hasTypeScript = existsSync(join(cwd, 'tsconfig.json'));

  // Read moflo.yaml for detected dirs/extensions
  const yamlPath = join(cwd, 'moflo.yaml');
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf8');

      // Parse extensions
      const extMatch = content.match(/extensions:\s*\[([^\]]+)\]/);
      if (extMatch) {
        defaults.extensions = extMatch[1].split(',').map(e => e.trim().replace(/"/g, ''));
      }

      // Parse test directories
      const testsBlock = content.match(/tests:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (testsBlock) {
        const items = testsBlock[1].match(/-\s+(.+)/g);
        if (items) defaults.testDirs = items.map(i => i.replace(/^-\s+/, '').trim());
      }

      // Parse source directories
      const codeBlock = content.match(/code_map:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (codeBlock) {
        const items = codeBlock[1].match(/-\s+(.+)/g);
        if (items) defaults.srcDirs = items.map(i => i.replace(/^-\s+/, '').trim());
      }
    } catch { /* ignore parse errors */ }
  }

  // Check if test dirs actually exist
  defaults.hasTests = defaults.testDirs.some(d => existsSync(join(cwd, d)));

  return defaults;
}

/** Get the default branch name for the current repo */
function getDefaultBranch(cwd: string): string {
  try {
    return runGh('repo view --json defaultBranchRef --jq .defaultBranchRef.name', cwd);
  } catch {
    // Fallback: check local git
    try {
      return execSync('git symbolic-ref refs/remotes/origin/HEAD', {
        encoding: 'utf8', cwd, timeout: 5000, windowsHide: true, stdio: 'pipe',
      }).trim().replace('refs/remotes/origin/', '');
    } catch {
      return 'main';
    }
  }
}

/** Get the repo owner/name from gh */
function getRepoSlug(cwd: string): string | null {
  try {
    return runGh('repo view --json nameWithOwner --jq .nameWithOwner', cwd);
  } catch {
    return null;
  }
}

// ============================================================================
// CI Workflow Generation
// ============================================================================

function generateCIWorkflow(config: ReturnType<typeof readProjectConfig>, defaultBranch: string): string {
  const pm = config.packageManager;
  const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile'
    : pm === 'yarn' ? 'yarn install --frozen-lockfile'
    : pm === 'bun' ? 'bun install --frozen-lockfile'
    : 'npm ci';
  const run = pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bun run' : 'npm run';

  const setupPm = pm === 'pnpm' ? `
      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: latest
` : '';

  const nodeCache = pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? '' : 'npm';
  const setupNode = nodeCache ? `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: '${nodeCache}'
` : `
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
`;

  const setupBun = pm === 'bun' ? `
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
` : '';

  const lintStep = `
      - name: Lint
        run: ${run} lint --max-warnings 0
        continue-on-error: true`;

  const typeCheckStep = config.hasTypeScript ? `

      - name: Type check
        run: ${run} typecheck` : '';

  const testStep = config.hasTests ? `

      - name: Test
        run: ${run} test` : '';

  return `# CI pipeline — generated by moflo (https://github.com/eric-cielo/moflo)
# Runs on every push to ${defaultBranch} and on all pull requests.

name: CI

on:
  push:
    branches: [${defaultBranch}]
  pull_request:
    branches: [${defaultBranch}]

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout
        uses: actions/checkout@v4
${setupPm}${setupNode}${setupBun}
      - name: Install dependencies
        run: ${install}

      - name: Build
        run: ${run} build
${lintStep}${typeCheckStep}${testStep}
`;
}

// ============================================================================
// Subcommands
// ============================================================================

const ciCommand: Command = {
  name: 'ci',
  description: 'Generate a GitHub Actions CI workflow based on your project',
  options: [
    { name: 'force', short: 'f', type: 'boolean', description: 'Overwrite existing workflow', default: false },
    { name: 'dry-run', short: 'd', type: 'boolean', description: 'Print workflow to stdout instead of writing', default: false },
  ],
  examples: [
    { command: 'flo github ci', description: 'Generate .github/workflows/ci.yml' },
    { command: 'flo github ci --dry-run', description: 'Preview without writing' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;
    const dryRun = (ctx.flags['dry-run'] || ctx.flags.dryRun) as boolean;
    const cwd = ctx.cwd;

    const config = readProjectConfig(cwd);
    const defaultBranch = getDefaultBranch(cwd);
    const workflow = generateCIWorkflow(config, defaultBranch);

    if (dryRun) {
      output.writeln(workflow);
      return { success: true };
    }

    const workflowPath = join(cwd, '.github', 'workflows', 'ci.yml');
    if (existsSync(workflowPath) && !force) {
      output.printWarning('.github/workflows/ci.yml already exists (use --force to overwrite)');
      return { success: false, exitCode: 1 };
    }

    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
    writeFileSync(workflowPath, workflow, 'utf8');

    output.writeln();
    output.writeln(output.bold('CI Workflow Generated'));
    output.writeln();
    output.writeln(`  ${output.success('✓')} .github/workflows/ci.yml`);
    output.writeln();
    output.writeln(output.dim(`  Package manager: ${config.packageManager}`));
    output.writeln(output.dim(`  TypeScript:      ${config.hasTypeScript ? 'yes' : 'no'}`));
    output.writeln(output.dim(`  Tests:           ${config.hasTests ? config.testDirs.join(', ') : 'none detected'}`));
    output.writeln(output.dim(`  Default branch:  ${defaultBranch}`));
    output.writeln();
    output.printInfo('Review the workflow, then commit and push to activate it.');

    return { success: true };
  },
};

const settingsCommand: Command = {
  name: 'settings',
  description: 'Apply recommended repo settings and branch protection via gh CLI',
  options: [
    { name: 'dry-run', short: 'd', type: 'boolean', description: 'Show what would be applied without making changes', default: false },
    { name: 'branch', short: 'b', type: 'string', description: 'Branch to protect (default: repo default branch)' },
    { name: 'skip-protection', type: 'boolean', description: 'Skip branch protection rules', default: false },
    { name: 'skip-repo', type: 'boolean', description: 'Skip repo-level settings', default: false },
    { name: 'required-reviews', type: 'string', description: 'Required approving reviews (0 to disable)', default: '1' },
    { name: 'require-ci', type: 'boolean', description: 'Require CI status checks to pass before merge', default: true },
  ],
  examples: [
    { command: 'flo github settings', description: 'Apply all recommended settings' },
    { command: 'flo github settings --dry-run', description: 'Preview changes' },
    { command: 'flo github settings --required-reviews 2', description: 'Require 2 approving reviews' },
    { command: 'flo github settings --skip-protection', description: 'Only apply repo-level settings' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dryRun = (ctx.flags['dry-run'] || ctx.flags.dryRun) as boolean;
    const skipProtection = (ctx.flags['skip-protection'] || ctx.flags.skipProtection) as boolean;
    const skipRepo = (ctx.flags['skip-repo'] || ctx.flags.skipRepo) as boolean;
    const requiredReviews = parseInt((ctx.flags['required-reviews'] || ctx.flags.requiredReviews) as string || '1', 10);
    const requireCi = (ctx.flags['require-ci'] ?? ctx.flags.requireCi ?? true) as boolean;
    const cwd = ctx.cwd;

    if (!ghAvailable()) {
      output.printError('GitHub CLI (gh) is required but not installed.');
      output.printInfo('Install: https://cli.github.com');
      return { success: false, exitCode: 1 };
    }

    if (!ghAuthenticated()) {
      output.printError('Not authenticated with GitHub CLI.');
      output.printInfo('Run: gh auth login');
      return { success: false, exitCode: 1 };
    }

    const slug = getRepoSlug(cwd);
    if (!slug) {
      output.printError('Could not determine repository. Are you in a git repo linked to GitHub?');
      return { success: false, exitCode: 1 };
    }

    const branch = ctx.flags.branch as string || getDefaultBranch(cwd);

    output.writeln();
    output.writeln(output.bold('GitHub Repository Settings'));
    output.writeln(output.dim(`  Repository: ${slug}`));
    output.writeln(output.dim(`  Branch:     ${branch}`));
    if (dryRun) output.writeln(output.warning('  DRY RUN — no changes will be made'));
    output.writeln();

    const applied: string[] = [];
    const errors: string[] = [];

    // ── Repo-level settings ──────────────────────────────────────────
    if (!skipRepo) {
      // Group settings into batches — some fields must be set together
      const settingsBatches: { payload: Record<string, unknown>; labels: string[] }[] = [
        {
          payload: {
            delete_branch_on_merge: true,
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            allow_auto_merge: true,
            allow_update_branch: true,
            // Title + message must be set together or message fails
            squash_merge_commit_title: 'PR_TITLE',
            squash_merge_commit_message: 'PR_BODY',
          },
          labels: [
            'Delete branch on merge',
            'Allow squash merge',
            'Allow merge commits',
            'Allow rebase merge',
            'Squash defaults: PR title + body',
            'Allow auto-merge',
            'Allow update branch button',
          ],
        },
      ];

      for (const batch of settingsBatches) {
        if (dryRun) {
          for (const label of batch.labels) {
            output.writeln(`  ${output.dim('○')} ${label}`);
          }
          applied.push(...batch.labels);
          continue;
        }
        try {
          runGh(`api repos/${slug} -X PATCH --input -`, cwd, 15000, JSON.stringify(batch.payload));
          for (const label of batch.labels) {
            output.writeln(`  ${output.success('✓')} ${label}`);
          }
          applied.push(...batch.labels);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          for (const label of batch.labels) {
            output.writeln(`  ${output.warning('⚠')} ${label} — ${msg.split('\n')[0]}`);
          }
          errors.push(...batch.labels);
        }
      }

      output.writeln();
    }

    // ── Branch protection ────────────────────────────────────────────
    if (!skipProtection) {
      output.writeln(output.bold('  Branch Protection'));
      output.writeln();

      // Build branch protection payload
      const protection: Record<string, unknown> = {
        enforce_admins: false,
        required_pull_request_reviews: requiredReviews > 0 ? {
          required_approving_review_count: requiredReviews,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
        } : null,
        required_status_checks: requireCi ? {
          strict: true,
          contexts: [],  // Empty = any passing check counts
        } : null,
        restrictions: null,
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
      };

      const protectionItems = [
        requiredReviews > 0 ? `Require ${requiredReviews} approving review${requiredReviews > 1 ? 's' : ''}` : null,
        requiredReviews > 0 ? 'Dismiss stale reviews on new commits' : null,
        requireCi ? 'Require status checks to pass' : null,
        requireCi ? 'Require branch to be up to date' : null,
        'Require linear history',
        'Block force pushes',
        'Block branch deletion',
      ].filter(Boolean) as string[];

      if (dryRun) {
        for (const item of protectionItems) {
          output.writeln(`  ${output.dim('○')} ${item}`);
        }
        applied.push(...protectionItems);
      } else {
        try {
          const payload = JSON.stringify(protection);
          runGh(`api repos/${slug}/branches/${branch}/protection -X PUT --input -`, cwd, 15000, payload);

          for (const item of protectionItems) {
            output.writeln(`  ${output.success('✓')} ${item}`);
          }
          applied.push(...protectionItems);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('not found') || msg.includes('404')) {
            output.writeln(`  ${output.warning('⚠')} Branch protection requires GitHub Pro, Team, or Enterprise`);
          } else if (msg.includes('403')) {
            output.writeln(`  ${output.warning('⚠')} Insufficient permissions — need admin access to set branch protection`);
          } else {
            output.writeln(`  ${output.error('✗')} Failed to set branch protection: ${msg.split('\n')[0]}`);
          }
          errors.push('Branch protection');
        }
      }
    }

    // ── Summary ──────────────────────────────────────────────────────
    output.writeln();
    output.writeln(output.dim('─'.repeat(50)));

    if (dryRun) {
      output.writeln();
      output.printInfo(`Would apply ${applied.length} settings. Run without --dry-run to apply.`);
    } else if (errors.length === 0) {
      output.writeln();
      output.printSuccess(`Applied ${applied.length} settings to ${slug}`);
    } else {
      output.writeln();
      output.printWarning(`Applied ${applied.length} settings, ${errors.length} had issues`);
    }

    return { success: errors.length === 0 || dryRun };
  },
};

const setupCommand: Command = {
  name: 'setup',
  description: 'One-shot: generate CI workflow + apply repo settings and branch protection',
  options: [
    { name: 'dry-run', short: 'd', type: 'boolean', description: 'Preview all changes without applying', default: false },
    { name: 'force', short: 'f', type: 'boolean', description: 'Overwrite existing CI workflow', default: false },
    { name: 'required-reviews', type: 'string', description: 'Required approving reviews (0 to disable)', default: '1' },
    { name: 'skip-ci', type: 'boolean', description: 'Skip CI workflow generation', default: false },
    { name: 'skip-protection', type: 'boolean', description: 'Skip branch protection rules', default: false },
    { name: 'skip-repo', type: 'boolean', description: 'Skip repo-level settings', default: false },
  ],
  examples: [
    { command: 'flo github setup', description: 'Generate CI + apply all settings' },
    { command: 'flo github setup --dry-run', description: 'Preview everything' },
    { command: 'flo github setup --skip-ci', description: 'Only apply repo settings' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dryRun = (ctx.flags['dry-run'] || ctx.flags.dryRun) as boolean;
    const skipCi = (ctx.flags['skip-ci'] || ctx.flags.skipCi) as boolean;

    output.writeln();
    output.writeln(output.bold('GitHub Project Setup'));
    output.writeln(output.dim('CI workflow + repo settings + branch protection'));
    output.writeln();

    let ciOk = true;
    let settingsOk = true;

    // Step 1: CI workflow
    if (!skipCi) {
      output.writeln(output.bold('Step 1: CI Workflow'));
      output.writeln();
      const ciResult = await ciCommand.action!(ctx);
      ciOk = ciResult?.success ?? false;
      output.writeln();
    }

    // Step 2: Repo settings + branch protection
    output.writeln(output.bold(skipCi ? 'Repository Settings' : 'Step 2: Repository Settings'));
    output.writeln();
    const settingsResult = await settingsCommand.action!(ctx);
    settingsOk = settingsResult?.success ?? false;

    return { success: ciOk && settingsOk };
  },
};

// ============================================================================
// Main command
// ============================================================================

export const githubCommand: Command = {
  name: 'github',
  aliases: ['gh'],
  description: 'GitHub repository setup: CI pipeline, branch protection, repo settings',
  subcommands: [setupCommand, ciCommand, settingsCommand],
  options: [],
  examples: [
    { command: 'flo github setup', description: 'One-shot: CI + settings + branch protection' },
    { command: 'flo github ci', description: 'Generate CI workflow from project config' },
    { command: 'flo github settings', description: 'Apply repo settings and branch protection' },
    { command: 'flo github setup --dry-run', description: 'Preview all changes' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('flo github — Repository Setup'));
    output.writeln();
    output.writeln('Subcommands:');
    output.writeln(`  ${output.highlight('setup')}      One-shot: CI workflow + repo settings + branch protection`);
    output.writeln(`  ${output.highlight('ci')}         Generate .github/workflows/ci.yml from project config`);
    output.writeln(`  ${output.highlight('settings')}   Apply repo settings and branch protection via gh CLI`);
    output.writeln();
    output.writeln(output.dim('Run flo github <subcommand> --help for details.'));
    return { success: true };
  },
};

export default githubCommand;
