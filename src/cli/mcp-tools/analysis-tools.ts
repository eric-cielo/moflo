/**
 * Analysis + MCP-introspection MCP Tools for CLI
 *
 * `analyze_diff` (called by `flo analyze diff`) and `mcp_status` (called by
 * `flo status`) were both invoked by shipped commands but never registered,
 * so each died with `MCP tool not found` (#1349).
 *
 * `analyze_diff` composes the existing, tested `movector/diff-classifier`
 * helpers; `mcp_status` reuses the same PID/lock probe `flo mcp status`
 * already relies on, so it reports whether the server is genuinely up rather
 * than the hardcoded "not running" the status dashboard used to print.
 *
 * @module v3/cli/mcp-tools/analysis-tools
 */

import type { MCPTool } from './types.js';

/** Path fragments that make a change security- or contract-sensitive. */
const SECURITY_PATTERNS = /security|auth|crypto|secret|token|password|credential/i;
const BREAKING_PATTERNS = /migration|schema|\bapi\b|public|index\.ts$|types?\.ts$/i;
const TEST_PATTERNS = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__|\btests?\//i;

export const analysisTools: MCPTool[] = [
  {
    name: 'analyze_diff',
    description: 'Analyse a git diff for risk, change classification, and suggested reviewers',
    category: 'analysis',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to diff against (default HEAD)' },
      },
    },
    handler: async (input) => {
      const ref = String(input.ref ?? 'HEAD');
      const {
        getGitDiffNumstatAsync,
        assessFileRisk,
        assessOverallRisk,
        classifyDiff,
        suggestReviewers,
      } = await import('../movector/diff-classifier.js');

      const files = await getGitDiffNumstatAsync(ref);
      const fileRisks = files.map(assessFileRisk);
      const risk = assessOverallRisk(files, fileRisks);
      const classification = classifyDiff(files);

      const totalChanges = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
      const testFiles = files.filter(f => TEST_PATTERNS.test(f.path));
      const sourceFiles = files.filter(f => !TEST_PATTERNS.test(f.path));

      return {
        ref,
        timestamp: new Date().toISOString(),
        files: files.map(f => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary,
        })),
        risk: {
          overall: risk.overall,
          score: risk.score,
          breakdown: {
            fileCount: files.length,
            totalChanges,
            highRiskFiles: fileRisks
              .filter(r => r.risk === 'high' || r.risk === 'critical')
              .map(r => r.file),
            securityConcerns: files
              .filter(f => SECURITY_PATTERNS.test(f.path))
              .map(f => f.path),
            breakingChanges: files
              .filter(f => BREAKING_PATTERNS.test(f.path))
              .map(f => f.path),
            testCoverage: sourceFiles.length === 0
              ? 'no source changes'
              : testFiles.length === 0
                ? 'no test files changed'
                : `${testFiles.length} test file(s) alongside ${sourceFiles.length} source file(s)`,
          },
        },
        classification,
        fileRisks: fileRisks.map(r => ({
          path: r.file,
          risk: r.risk,
          score: r.score,
          reasons: r.reasons,
        })),
        recommendedReviewers: suggestReviewers(files, fileRisks),
      };
    },
  },
  {
    name: 'mcp_status',
    description: 'Report whether the moflo MCP server is running, and on which transport',
    category: 'system',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const { getMCPServerStatus } = await import('../mcp-server.js');
      const status = await getMCPServerStatus();
      return {
        running: status.running === true,
        transport: status.transport ?? 'stdio',
        pid: status.pid ?? null,
      };
    },
  },
];

export default analysisTools;
