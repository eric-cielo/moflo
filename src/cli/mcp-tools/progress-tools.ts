/**
 * Progress MCP Tools for CLI
 *
 * Wraps the existing `V3ProgressService` (src/cli/shared/services/v3-progress.service.ts),
 * which already backs the statusline. Before #1349 `flo progress check|summary|sync`
 * and `flo hooks progress` called `progress_check` / `progress_summary` /
 * `progress_sync` — none of which were ever registered — so every invocation
 * died with `MCP tool not found` after printing its spinner.
 *
 * The service is the source of truth; these handlers only marshal its output
 * into the shape the CLI renderers already expect.
 *
 * @module v3/cli/mcp-tools/progress-tools
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import { findProjectRoot } from '../services/project-root.js';
import { MOFLO_DIR } from '../services/moflo-paths.js';

/**
 * These tools measure *moflo's own* implementation progress by counting its
 * `src/cli` tree — they are only meaningful inside the moflo source repo.
 *
 * The gate is load-bearing, not defensive. V3ProgressService answers an
 * unreadable tree with invented values, not an error: `countCliCommands`
 * catches and returns `commands: TARGETS.CLI_COMMANDS` (i.e. 100%), and
 * `countCodebase` ends with `totalFiles || 419, totalLines || 290913`. Run in
 * a consumer project that has no `src/` at all, it therefore reports
 * "28/28 commands, 419 files, 290,913 lines" with total confidence. Refusing
 * up front is the difference between a useless answer and a false one — which
 * is the whole point of #1349.
 */
async function createService(): Promise<{
  service: import('../shared/services/v3-progress.service.js').V3ProgressService;
  outputPath: string;
}> {
  const { V3ProgressService } = await import('../shared/services/v3-progress.service.js');
  const projectRoot = findProjectRoot();

  if (!existsSync(join(projectRoot, 'src', 'cli', 'commands'))) {
    throw new Error(
      'Progress metrics track moflo\'s own implementation and require the moflo ' +
      `source tree; ${projectRoot} has no src/cli/commands. This command only ` +
      'applies inside the moflo repository.'
    );
  }

  // Own the output path here and hand it to the service, so this module and
  // V3ProgressService cannot drift to two different metrics files.
  const outputPath = join(projectRoot, MOFLO_DIR, 'metrics', 'v3-progress.json');
  return { service: new V3ProgressService({ projectRoot, outputPath }), outputPath };
}

export const progressTools: MCPTool[] = [
  {
    name: 'progress_check',
    description: 'Calculate moflo implementation progress (CLI commands, MCP tools, hooks, packages, DDD coverage)',
    category: 'progress',
    inputSchema: {
      type: 'object',
      properties: {
        detailed: {
          type: 'boolean',
          description: 'Include the per-area breakdown as well as the overall percentage',
        },
      },
    },
    handler: async (input) => {
      const { service } = await createService();
      const metrics = await service.calculate();

      // `overall` is what every caller renders; `progress` is kept as an alias
      // because progress.ts reads `result.overall ?? result.progress`.
      const base = {
        overall: metrics.overall,
        progress: metrics.overall,
        lastUpdated: metrics.lastUpdated,
      };

      if (!input.detailed) return base;

      return {
        ...base,
        cli: metrics.cli,
        mcp: metrics.mcp,
        hooks: metrics.hooks,
        packages: {
          progress: metrics.packages.progress,
          total: metrics.packages.total,
          target: metrics.packages.target,
          withDDD: metrics.packages.withDDD,
        },
        ddd: { progress: metrics.ddd.progress },
        codebase: metrics.codebase,
      };
    },
  },
  {
    name: 'progress_summary',
    description: 'Human-readable summary of moflo implementation progress',
    category: 'progress',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const { service } = await createService();
      return { summary: await service.getSummary() };
    },
  },
  {
    name: 'progress_sync',
    description: 'Recalculate implementation progress and persist it to .moflo/metrics/v3-progress.json',
    category: 'progress',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const startedAt = Date.now();
      const { service, outputPath: path } = await createService();
      // sync() is calculate() + persist(); calling both was a re-implementation.
      const metrics = await service.sync();

      // #1346's lesson: derive the verdict from the artifact, not from the
      // call returning. `persist()` swallows its own write errors and only
      // emits 'error', so a bare `await` proves nothing about the file.
      // Existence alone is not proof either — a stale file from a previous
      // run would make a failed write look successful — so require an mtime
      // at or after the moment this call began.
      let persisted = false;
      let lastUpdated = metrics.lastUpdated;
      if (existsSync(path)) {
        const stat = statSync(path);
        // Allow 1s of filesystem timestamp granularity (some filesystems
        // truncate mtime to whole seconds, which can land just below startedAt).
        if (stat.mtimeMs >= startedAt - 1000) {
          persisted = true;
          lastUpdated = stat.mtime.toISOString();
        }
      }

      return {
        progress: metrics.overall,
        persisted,
        lastUpdated,
        message: persisted
          ? `Progress synced to ${path}`
          : `Progress calculated but could not be written to ${path}`,
      };
    },
  },
];

export default progressTools;
