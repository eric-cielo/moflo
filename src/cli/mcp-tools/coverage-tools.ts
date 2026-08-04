/**
 * Coverage MCP Tools for CLI
 *
 * The wrapper `src/cli/movector/coverage-router.ts` has been waiting for since
 * it grew a section literally headed "Additional Exports for MCP Tools
 * (coverage-tools.ts)". That file was never written, so `flo hooks
 * coverage-gaps|coverage-route|coverage-suggest` died with `MCP tool not
 * found` on every invocation (#1349).
 *
 * The router owns all the analysis; these handlers only translate its
 * file-shaped results into the gap-shaped records the CLI renderers read
 * (`filePath` / `coveragePercent` / `gapType` / `suggestedAgents`).
 *
 * @module v3/cli/mcp-tools/coverage-tools
 */

import type { MCPTool } from './types.js';
import { findProjectRoot } from '../services/project-root.js';
import { classifyGap, type GapSeverity } from '../movector/coverage-router.js';

function gapReason(file: string, coverage: number, threshold: number, gapType: GapSeverity): string {
  return `${file} is at ${coverage.toFixed(1)}% line coverage, ${(threshold - coverage).toFixed(1)} points below the ${threshold}% threshold (${gapType})`;
}

async function router() {
  return import('../movector/coverage-router.js');
}

interface Summary {
  totalFiles: number;
  overallLineCoverage: number;
  overallBranchCoverage: number;
  filesBelowThreshold: number;
}

/**
 * With no coverage artifact there is nothing to summarize, so `summary` is
 * null rather than a block of zeros. Zeros here rendered as "Line Coverage:
 * 0.0% / Below Threshold: 0 files" — a measurement of a file that was never
 * read, printed directly beneath "No coverage report" (#1349).
 */
async function summarize(threshold: number, projectRoot: string): Promise<{
  summary: Summary | null;
  found: boolean;
}> {
  const { loadCoverageReport } = await router();
  const report = await loadCoverageReport(projectRoot);
  if (!report) {
    return { found: false, summary: null };
  }
  return {
    found: true,
    summary: {
      totalFiles: report.byFile.length,
      overallLineCoverage: report.byType.line,
      overallBranchCoverage: report.byType.branch,
      filesBelowThreshold: report.byFile.filter(f => f.lineCoverage < threshold).length,
    },
  };
}

export const coverageTools: MCPTool[] = [
  {
    name: 'hooks_coverage-gaps',
    description: 'List every file below the coverage threshold, with a suggested test agent per file',
    category: 'hooks',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Coverage percentage to measure gaps against (default 80)' },
        groupByAgent: { type: 'boolean', description: 'Group the gap files by suggested agent (default true)' },
      },
    },
    handler: async (input) => {
      const threshold = typeof input.threshold === 'number' ? input.threshold : 80;
      const projectRoot = findProjectRoot();
      const { coverageGaps } = await router();

      const result = await coverageGaps({
        projectRoot,
        threshold,
        groupByAgent: input.groupByAgent !== false,
      });
      const { summary, found } = await summarize(threshold, projectRoot);

      return {
        success: true,
        gaps: result.gaps.map(g => {
          const gapType = classifyGap(g.gap);
          return {
            filePath: g.file,
            coveragePercent: g.currentCoverage,
            gapType,
            complexity: g.priority,
            priority: g.priority,
            suggestedAgents: [g.suggestedAgent],
            reason: gapReason(g.file, g.currentCoverage, threshold, gapType),
          };
        }),
        summary: summary ? { ...summary, coverageThreshold: threshold } : null,
        agentAssignments: result.byAgent,
        movectorAvailable: found,
      };
    },
  },
  {
    name: 'hooks_coverage-route',
    description: 'Route a task to an agent using the project coverage report to prioritise the weakest files',
    category: 'hooks',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to route' },
        threshold: { type: 'number', description: 'Coverage percentage to measure gaps against (default 80)' },
        useNativeBackend: { type: 'boolean', description: 'Prefer the native coverage backend when present' },
      },
      required: ['task'],
    },
    handler: async (input) => {
      const task = String(input.task ?? '');
      const threshold = typeof input.threshold === 'number' ? input.threshold : 80;
      const projectRoot = findProjectRoot();
      const { coverageRoute, coverageGaps } = await router();

      const route = await coverageRoute(task, {
        projectRoot,
        threshold,
        useNativeBackend: input.useNativeBackend === true,
      });
      const gapsResult = await coverageGaps({ projectRoot, threshold });
      const { summary, found } = await summarize(threshold, projectRoot);

      const gaps = gapsResult.gaps.map(g => {
        const gapType = classifyGap(g.gap);
        return {
          filePath: g.file,
          coveragePercent: g.currentCoverage,
          gapType,
          priority: g.priority,
          suggestedAgents: [g.suggestedAgent],
          reason: gapReason(g.file, g.currentCoverage, threshold, gapType),
        };
      });

      // The primary agent is the one owning the most gap files. With no
      // coverage report there is no basis for a routing decision, so return
      // null instead of defaulting to 'tester' — a confident-looking answer
      // derived from nothing is what #1349 is about.
      const ranked = Object.entries(gapsResult.byAgent).sort((a, b) => b[1].length - a[1].length);
      const primaryAgent = found ? ranked[0]?.[0] ?? null : null;
      const criticalGaps = gaps.filter(g => g.gapType === 'critical').length;

      return {
        success: true,
        task,
        coverageAware: found,
        gaps,
        routing: {
          primaryAgent,
          confidence: found && primaryAgent ? Math.min(1, route.impactScore || 0.5) : 0,
          reason: found && primaryAgent
            ? `${route.action}: ${primaryAgent} owns ${ranked[0]?.[1].length ?? 0} of ${gaps.length} gap files`
            : 'No coverage report found — routing is not coverage-aware',
          coverageImpact: summary
            ? `${criticalGaps} critical gap(s) across ${summary.filesBelowThreshold} file(s) below ${threshold}%`
            : 'unknown',
        },
        suggestions: route.gaps.flatMap(g => g.suggestedTests).slice(0, 5),
        metrics: summary
          ? {
              filesAnalyzed: summary.totalFiles,
              totalGaps: gaps.length,
              criticalGaps,
              avgCoverage: summary.overallLineCoverage,
            }
          : null,
      };
    },
  },
  {
    name: 'hooks_coverage-suggest',
    description: 'Suggest coverage improvements for files under a path, ranked by priority',
    category: 'hooks',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path prefix to analyse' },
        threshold: { type: 'number', description: 'Coverage percentage to measure gaps against (default 80)' },
        limit: { type: 'number', description: 'Maximum suggestions to return (default 20)' },
      },
      required: ['path'],
    },
    handler: async (input) => {
      const path = String(input.path ?? '');
      const threshold = typeof input.threshold === 'number' ? input.threshold : 80;
      const projectRoot = findProjectRoot();
      const { coverageSuggest } = await router();

      const result = await coverageSuggest(path, {
        projectRoot,
        threshold,
        limit: typeof input.limit === 'number' ? input.limit : 20,
      });
      const { summary, found } = await summarize(threshold, projectRoot);

      return {
        success: true,
        path,
        suggestions: result.suggestions.map(s => {
          const gapType = classifyGap(s.gap);
          return {
            filePath: s.file,
            coveragePercent: s.currentCoverage,
            gapType,
            priority: s.priority,
            suggestedAgents: [],
            reason: s.suggestedTests.length > 0
              ? s.suggestedTests.join('; ')
              : gapReason(s.file, s.currentCoverage, threshold, gapType),
          };
        }),
        summary,
        prioritizedFiles: result.suggestions.map(s => s.file),
        movectorAvailable: found,
      };
    },
  },
];

export default coverageTools;
