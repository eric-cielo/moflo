/**
 * V3 Progress MCP Tools
 *
 * Provides MCP tools for checking and syncing V3 implementation progress.
 *
 * @module moflo/mcp-tools/progress
 */

import type { MCPTool } from './types.js';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findMofloPackageRoot } from '../services/moflo-require.js';

// Anchor on the moflo package root via the shared walk-up helper. Works under
// both src/cli/mcp-tools/ (dev) and dist/src/cli/mcp-tools/ (built) layouts.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = findMofloPackageRoot() ?? __dirname;

// Utility/service packages follow DDD differently - their services ARE the application layer
const UTILITY_PACKAGES = new Set([
  'cli', 'hooks', 'mcp', 'shared', 'testing', 'agents', 'integration',
  'embeddings', 'deployment', 'performance', 'plugins', 'providers'
]);

// Target metrics for 100% completion
const TARGETS = {
  CLI_COMMANDS: 28,
  MCP_TOOLS: 100,
  HOOKS_SUBCOMMANDS: 27, // 27 hooks documented in CLAUDE.md
  PACKAGES: 17,
};

// Weight distribution for overall progress
const WEIGHTS = {
  CLI: 0.25,
  MCP: 0.25,
  HOOKS: 0.20,
  PACKAGES: 0.15,
  DDD: 0.15,
};

interface V3ProgressMetrics {
  overall: number;
  cli: { commands: number; target: number; progress: number };
  mcp: { tools: number; target: number; progress: number };
  hooks: { subcommands: number; target: number; progress: number };
  packages: { total: number; withDDD: number; target: number; progress: number; list: string[] };
  ddd: { explicit: number; utility: number; progress: number };
  codebase: { totalFiles: number; totalLines: number };
  lastUpdated: string;
  source: string;
}

function countFilesAndLines(dir: string, ext = '.ts'): { files: number; lines: number } {
  let files = 0;
  let lines = 0;

  function walk(currentDir: string) {
    if (!existsSync(currentDir)) return;

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory() && !entry.name.includes('node_modules') && !entry.name.startsWith('.')) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          files++;
          try {
            const content = readFileSync(fullPath, 'utf-8');
            lines += content.split(/\r?\n/).length;
          } catch (_e) { /* ignore */ }
        }
      }
    } catch (_e) { /* ignore */ }
  }

  walk(dir);
  return { files, lines };
}

function calculateModuleProgress(moduleDir: string): number {
  if (!existsSync(moduleDir)) return 0;

  const moduleName = basename(moduleDir);

  // Utility packages are 100% complete by design
  if (UTILITY_PACKAGES.has(moduleName)) {
    return 100;
  }

  let progress = 0;

  // Check for DDD structure
  if (existsSync(join(moduleDir, 'src/domain'))) progress += 30;
  if (existsSync(join(moduleDir, 'src/application'))) progress += 30;
  if (existsSync(join(moduleDir, 'src'))) progress += 10;
  if (existsSync(join(moduleDir, 'src/index.ts')) || existsSync(join(moduleDir, 'index.ts'))) progress += 10;
  if (existsSync(join(moduleDir, '__tests__')) || existsSync(join(moduleDir, 'tests'))) progress += 10;
  if (existsSync(join(moduleDir, 'package.json'))) progress += 10;

  return Math.min(progress, 100);
}

async function calculateProgress(): Promise<V3ProgressMetrics> {
  const now = new Date().toISOString();

  // Pre-collapse this scanned `<repo>/@claude-flow/<pkg>/` to fan progress
  // metrics across the workspace tree. After epic #586 there's exactly one
  // package — moflo itself — so the modules list is fixed and the per-module
  // walk would have produced empty results anyway.
  const modules: { name: string; files: number; lines: number; progress: number }[] = [
    { name: 'cli', files: 0, lines: 0, progress: 100 },
  ];
  const utilityDDD = 1;
  const explicitDDD = 0;

  const avgProgress = modules[0].progress;
  const totalStats = countFilesAndLines(PROJECT_ROOT);

  // Count CLI commands (from commands/index.ts)
  let cliCommands = 28; // Default to known count
  const commandsIndexPath = join(PROJECT_ROOT, 'src/cli/commands/index.ts');
  if (existsSync(commandsIndexPath)) {
    try {
      const content = readFileSync(commandsIndexPath, 'utf-8');
      const matches = content.match(/export const commands.*\[([^\]]+)\]/s);
      if (matches) {
        cliCommands = (matches[1].match(/Command/g) || []).length || 28;
      }
    } catch (_e) { /* ignore */ }
  }

  // Count MCP tools
  let mcpTools = 100; // Approximate
  const toolsIndexPath = join(PROJECT_ROOT, 'src/cli/mcp-tools/index.ts');
  if (existsSync(toolsIndexPath)) {
    try {
      const content = readFileSync(toolsIndexPath, 'utf-8');
      mcpTools = (content.match(/export.*Tools/g) || []).length * 10 || 100;
    } catch (_e) { /* ignore */ }
  }

  // Count hooks subcommands (count const *Command definitions)
  let hooksSubcommands = 27; // Default to documented count
  const hooksPath = join(PROJECT_ROOT, 'src/cli/commands/hooks.ts');
  if (existsSync(hooksPath)) {
    try {
      const content = readFileSync(hooksPath, 'utf-8');
      // Count command definitions like "const fooCommand: Command = {"
      const commandDefs = content.match(/const\s+\w+Command\s*:\s*Command\s*=/g);
      if (commandDefs && commandDefs.length > 0) {
        hooksSubcommands = commandDefs.length;
      }
    } catch (_e) { /* ignore */ }
  }

  // Calculate component progress
  const cliProgress = Math.min(100, Math.round((cliCommands / TARGETS.CLI_COMMANDS) * 100));
  const mcpProgress = Math.min(100, Math.round((mcpTools / TARGETS.MCP_TOOLS) * 100));
  const hooksProgress = Math.min(100, Math.round((hooksSubcommands / TARGETS.HOOKS_SUBCOMMANDS) * 100));
  const packagesProgress = Math.min(100, Math.round((modules.length / TARGETS.PACKAGES) * 100));

  // Calculate overall weighted progress
  const overall = Math.round(
    cliProgress * WEIGHTS.CLI +
    mcpProgress * WEIGHTS.MCP +
    hooksProgress * WEIGHTS.HOOKS +
    packagesProgress * WEIGHTS.PACKAGES +
    avgProgress * WEIGHTS.DDD
  );

  return {
    overall,
    cli: { commands: cliCommands, target: TARGETS.CLI_COMMANDS, progress: cliProgress },
    mcp: { tools: mcpTools, target: TARGETS.MCP_TOOLS, progress: mcpProgress },
    hooks: { subcommands: hooksSubcommands, target: TARGETS.HOOKS_SUBCOMMANDS, progress: hooksProgress },
    packages: {
      total: modules.length,
      withDDD: explicitDDD + utilityDDD,
      target: TARGETS.PACKAGES,
      progress: packagesProgress,
      list: modules.map(m => m.name),
    },
    ddd: { explicit: explicitDDD, utility: utilityDDD, progress: avgProgress },
    codebase: { totalFiles: totalStats.files, totalLines: totalStats.lines },
    lastUpdated: now,
    source: 'V3ProgressService',
  };
}

async function syncProgress(): Promise<V3ProgressMetrics> {
  const metrics = await calculateProgress();

  // Persist to file
  const metricsDir = join(PROJECT_ROOT, '.claude-flow/metrics');
  if (!existsSync(metricsDir)) {
    mkdirSync(metricsDir, { recursive: true });
  }

  const outputPath = join(metricsDir, 'v3-progress.json');
  writeFileSync(outputPath, JSON.stringify({
    domains: { completed: Math.floor(metrics.packages.withDDD / 3), total: 5 },
    ddd: {
      progress: metrics.ddd.progress,
      modules: metrics.packages.total,
      totalFiles: metrics.codebase.totalFiles,
      totalLines: metrics.codebase.totalLines,
    },
    swarm: { activeAgents: 0, totalAgents: 15 },
    lastUpdated: metrics.lastUpdated,
    source: 'V3ProgressService',
  }, null, 2));

  return metrics;
}

function getSummary(metrics: V3ProgressMetrics): string {
  const lines = [
    '═══════════════════════════════════════════════════',
    '           V3 Implementation Progress',
    '═══════════════════════════════════════════════════',
    '',
    `  Overall Progress: ${metrics.overall}%`,
    '',
    `  CLI Commands:     ${metrics.cli.progress}% (${metrics.cli.commands}/${metrics.cli.target})`,
    `  MCP Tools:        ${metrics.mcp.progress}% (${metrics.mcp.tools}/${metrics.mcp.target})`,
    `  Hooks:            ${metrics.hooks.progress}% (${metrics.hooks.subcommands}/${metrics.hooks.target})`,
    `  Packages:         ${metrics.packages.progress}% (${metrics.packages.total}/${metrics.packages.target})`,
    `  DDD Structure:    ${metrics.ddd.progress}%`,
    '',
    `  Codebase: ${metrics.codebase.totalFiles} files, ${metrics.codebase.totalLines.toLocaleString()} lines`,
    '',
    `  Last Updated: ${metrics.lastUpdated}`,
    '═══════════════════════════════════════════════════',
  ];
  return lines.join('\n');
}

/**
 * progress/check - Get current V3 implementation progress
 */
const progressCheck: MCPTool = {
  name: 'progress_check',
  description: 'Get current V3 implementation progress percentage and metrics',
  inputSchema: {
    type: 'object',
    properties: {
      detailed: {
        type: 'boolean',
        description: 'Include detailed breakdown by category',
      },
    },
    required: [],
  },
  handler: async (params: Record<string, unknown>) => {
    const detailed = params.detailed as boolean;
    const metrics = await calculateProgress();

    if (detailed) {
      return {
        overall: metrics.overall,
        cli: metrics.cli,
        mcp: metrics.mcp,
        hooks: metrics.hooks,
        packages: metrics.packages,
        ddd: metrics.ddd,
        codebase: metrics.codebase,
        lastUpdated: metrics.lastUpdated,
      };
    }

    return {
      progress: metrics.overall,
      summary: `V3 Implementation: ${metrics.overall}% complete`,
      breakdown: {
        cli: `${metrics.cli.progress}%`,
        mcp: `${metrics.mcp.progress}%`,
        hooks: `${metrics.hooks.progress}%`,
        packages: `${metrics.packages.progress}%`,
        ddd: `${metrics.ddd.progress}%`,
      },
    };
  },
};

/**
 * progress/sync - Calculate and persist V3 progress
 */
const progressSync: MCPTool = {
  name: 'progress_sync',
  description: 'Calculate and persist V3 progress metrics to file',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const metrics = await syncProgress();
    return {
      progress: metrics.overall,
      message: `Progress synced: ${metrics.overall}%`,
      persisted: true,
      lastUpdated: metrics.lastUpdated,
    };
  },
};

/**
 * progress/summary - Get human-readable progress summary
 */
const progressSummary: MCPTool = {
  name: 'progress_summary',
  description: 'Get human-readable V3 implementation progress summary',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const metrics = await calculateProgress();
    return {
      summary: getSummary(metrics),
    };
  },
};

/**
 * progress/watch - Watch progress (status check)
 */
const progressWatch: MCPTool = {
  name: 'progress_watch',
  description: 'Get current watch status for progress monitoring',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status'],
        description: 'Action to perform (status only for MCP)',
      },
    },
    required: [],
  },
  handler: async () => {
    const metrics = await calculateProgress();
    return {
      hasMetrics: true,
      lastProgress: metrics.overall,
      lastUpdated: metrics.lastUpdated,
    };
  },
};

/**
 * All progress tools
 */
export const progressTools: MCPTool[] = [
  progressCheck,
  progressSync,
  progressSummary,
  progressWatch,
];

export default progressTools;
