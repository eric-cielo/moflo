/**
 * V3 CLI Analyze Command
 * Code analysis, diff classification, AST analysis, and change risk assessment
 *
 * Features:
 * - AST analysis using ruvector (tree-sitter) with graceful fallback
 * - Symbol extraction (functions, classes, variables, types)
 * - Cyclomatic complexity scoring
 * - Diff classification and risk assessment
 * - Graph boundaries using MinCut algorithm
 * - Module communities using Louvain algorithm
 * - Circular dependency detection
 *
 * Created with ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

// Dynamic import for AST analyzer
async function getASTAnalyzer() {
  try {
    return await import('../ruvector/ast-analyzer.js');
  } catch {
    return null;
  }
}

// Dynamic import for graph analyzer
async function getGraphAnalyzer() {
  try {
    return await import('../ruvector/graph-analyzer.js');
  } catch {
    return null;
  }
}

// Diff subcommand
const diffCommand: Command = {
  name: 'diff',
  description: 'Analyze git diff for change risk assessment and classification',
  options: [
    {
      name: 'risk',
      short: 'r',
      description: 'Show risk assessment',
      type: 'boolean',
      default: false,
    },
    {
      name: 'classify',
      short: 'c',
      description: 'Classify change type',
      type: 'boolean',
      default: false,
    },
    {
      name: 'reviewers',
      description: 'Show recommended reviewers',
      type: 'boolean',
      default: false,
    },
    {
      name: 'format',
      short: 'f',
      description: 'Output format: text, json, table',
      type: 'string',
      default: 'text',
      choices: ['text', 'json', 'table'],
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Show detailed file-level analysis',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow analyze diff --risk', description: 'Analyze current diff with risk assessment' },
    { command: 'claude-flow analyze diff HEAD~1 --classify', description: 'Classify changes from last commit' },
    { command: 'claude-flow analyze diff main..feature --format json', description: 'Compare branches with JSON output' },
    { command: 'claude-flow analyze diff --reviewers', description: 'Get recommended reviewers for changes' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const ref = ctx.args[0] || 'HEAD';
    const showRisk = ctx.flags.risk as boolean;
    const showClassify = ctx.flags.classify as boolean;
    const showReviewers = ctx.flags.reviewers as boolean;
    const formatType = ctx.flags.format as string || 'text';
    const verbose = ctx.flags.verbose as boolean;

    // If no specific flag, show all
    const showAll = !showRisk && !showClassify && !showReviewers;

    output.printInfo(`Analyzing diff: ${output.highlight(ref)}`);

    try {
      // Call MCP tool for diff analysis
      const result = await callMCPTool<{
        ref: string;
        timestamp: string;
        files: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
          binary: boolean;
        }>;
        risk: {
          overall: string;
          score: number;
          breakdown: {
            fileCount: number;
            totalChanges: number;
            highRiskFiles: string[];
            securityConcerns: string[];
            breakingChanges: string[];
            testCoverage: string;
          };
        };
        classification: {
          category: string;
          subcategory?: string;
          confidence: number;
          reasoning: string;
        };
        fileRisks: Array<{
          path: string;
          risk: string;
          score: number;
          reasons: string[];
        }>;
        recommendedReviewers: string[];
        summary: string;
      }>('analyze/diff', {
        ref,
        includeFileRisks: verbose,
        includeReviewers: showReviewers || showAll,
      });

      // JSON output
      if (formatType === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Summary box
      output.printBox(
        [
          `Ref: ${result.ref}`,
          `Files: ${result.files.length}`,
          `Risk: ${getRiskDisplay(result.risk.overall)} (${result.risk.score}/100)`,
          `Type: ${result.classification.category}${result.classification.subcategory ? ` (${result.classification.subcategory})` : ''}`,
          ``,
          result.summary,
        ].join('\n'),
        'Diff Analysis'
      );

      // Risk assessment
      if (showRisk || showAll) {
        output.writeln();
        output.writeln(output.bold('Risk Assessment'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 30 },
          ],
          data: [
            { metric: 'Overall Risk', value: getRiskDisplay(result.risk.overall) },
            { metric: 'Risk Score', value: `${result.risk.score}/100` },
            { metric: 'Files Changed', value: result.risk.breakdown.fileCount },
            { metric: 'Total Lines Changed', value: result.risk.breakdown.totalChanges },
            { metric: 'Test Coverage', value: result.risk.breakdown.testCoverage },
          ],
        });

        // Security concerns
        if (result.risk.breakdown.securityConcerns.length > 0) {
          output.writeln();
          output.writeln(output.bold(output.warning('Security Concerns')));
          output.printList(result.risk.breakdown.securityConcerns.map(c => output.warning(c)));
        }

        // Breaking changes
        if (result.risk.breakdown.breakingChanges.length > 0) {
          output.writeln();
          output.writeln(output.bold(output.error('Potential Breaking Changes')));
          output.printList(result.risk.breakdown.breakingChanges.map(c => output.error(c)));
        }

        // High risk files
        if (result.risk.breakdown.highRiskFiles.length > 0) {
          output.writeln();
          output.writeln(output.bold('High Risk Files'));
          output.printList(result.risk.breakdown.highRiskFiles.map(f => output.warning(f)));
        }
      }

      // Classification
      if (showClassify || showAll) {
        output.writeln();
        output.writeln(output.bold('Classification'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'field', header: 'Field', width: 15 },
            { key: 'value', header: 'Value', width: 40 },
          ],
          data: [
            { field: 'Category', value: result.classification.category },
            { field: 'Subcategory', value: result.classification.subcategory || '-' },
            { field: 'Confidence', value: `${(result.classification.confidence * 100).toFixed(0)}%` },
          ],
        });

        output.writeln();
        output.writeln(output.dim(`Reasoning: ${result.classification.reasoning}`));
      }

      // Reviewers
      if (showReviewers || showAll) {
        output.writeln();
        output.writeln(output.bold('Recommended Reviewers'));
        output.writeln(output.dim('-'.repeat(50)));

        if (result.recommendedReviewers.length > 0) {
          output.printNumberedList(result.recommendedReviewers.map(r => output.highlight(r)));
        } else {
          output.writeln(output.dim('No specific reviewers recommended'));
        }
      }

      // Verbose file-level details
      if (verbose && result.fileRisks) {
        output.writeln();
        output.writeln(output.bold('File-Level Analysis'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'path', header: 'File', width: 40 },
            { key: 'risk', header: 'Risk', width: 12, format: (v) => getRiskDisplay(String(v)) },
            { key: 'score', header: 'Score', width: 8, align: 'right' },
            { key: 'reasons', header: 'Reasons', width: 30, format: (v) => {
              const reasons = v as string[];
              return reasons.slice(0, 2).join('; ');
            }},
          ],
          data: result.fileRisks,
        });
      }

      // Files changed table
      if (formatType === 'table' || showAll) {
        output.writeln();
        output.writeln(output.bold('Files Changed'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'status', header: 'Status', width: 10, format: (v) => getStatusDisplay(String(v)) },
            { key: 'path', header: 'File', width: 45 },
            { key: 'additions', header: '+', width: 8, align: 'right', format: (v) => output.success(`+${v}`) },
            { key: 'deletions', header: '-', width: 8, align: 'right', format: (v) => output.error(`-${v}`) },
          ],
          data: result.files.slice(0, 20),
        });

        if (result.files.length > 20) {
          output.writeln(output.dim(`  ... and ${result.files.length - 20} more files`));
        }
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Diff analysis failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Code subcommand (placeholder for future code analysis)
const codeCommand: Command = {
  name: 'code',
  description: 'Static code analysis and quality assessment',
  options: [
    { name: 'path', short: 'p', type: 'string', description: 'Path to analyze', default: '.' },
    { name: 'type', short: 't', type: 'string', description: 'Analysis type: quality, complexity, security', default: 'quality' },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: text, json', default: 'text' },
  ],
  examples: [
    { command: 'claude-flow analyze code -p ./src', description: 'Analyze source directory' },
    { command: 'claude-flow analyze code --type complexity', description: 'Run complexity analysis' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const path = ctx.flags.path as string || '.';
    const analysisType = ctx.flags.type as string || 'quality';

    output.writeln();
    output.writeln(output.bold('Code Analysis'));
    output.writeln(output.dim('-'.repeat(50)));

    output.printInfo(`Analyzing ${path} for ${analysisType}...`);
    output.writeln();

    // Placeholder - would integrate with actual code analysis tools
    output.printBox(
      [
        `Path: ${path}`,
        `Type: ${analysisType}`,
        `Status: Feature in development`,
        ``,
        `Code analysis capabilities coming soon.`,
        `Use 'analyze diff' for change analysis.`,
      ].join('\n'),
      'Code Analysis'
    );

    return { success: true };
  },
};

// Dependencies subcommand
const depsCommand: Command = {
  name: 'deps',
  description: 'Analyze project dependencies',
  options: [
    { name: 'outdated', short: 'o', type: 'boolean', description: 'Show only outdated dependencies' },
    { name: 'security', short: 's', type: 'boolean', description: 'Check for security vulnerabilities' },
    { name: 'format', short: 'f', type: 'string', description: 'Output format: text, json', default: 'text' },
  ],
  examples: [
    { command: 'claude-flow analyze deps --outdated', description: 'Show outdated dependencies' },
    { command: 'claude-flow analyze deps --security', description: 'Check for vulnerabilities' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const showOutdated = ctx.flags.outdated as boolean;
    const checkSecurity = ctx.flags.security as boolean;

    output.writeln();
    output.writeln(output.bold('Dependency Analysis'));
    output.writeln(output.dim('-'.repeat(50)));

    output.printInfo('Analyzing dependencies...');
    output.writeln();

    // Placeholder - would integrate with npm/yarn audit
    output.printBox(
      [
        `Outdated Check: ${showOutdated ? 'Enabled' : 'Disabled'}`,
        `Security Check: ${checkSecurity ? 'Enabled' : 'Disabled'}`,
        `Status: Feature in development`,
        ``,
        `Dependency analysis capabilities coming soon.`,
        `Use 'security scan --type deps' for security scanning.`,
      ].join('\n'),
      'Dependency Analysis'
    );

    return { success: true };
  },
};

// Helper functions
function getRiskDisplay(risk: string): string {
  switch (risk) {
    case 'critical':
      return output.color(output.bold('CRITICAL'), 'bgRed' as never, 'white' as never);
    case 'high-risk':
      return output.error('HIGH');
    case 'medium-risk':
      return output.warning('MEDIUM');
    case 'low-risk':
      return output.success('LOW');
    default:
      return risk;
  }
}

function getStatusDisplay(status: string): string {
  switch (status) {
    case 'added':
      return output.success('A');
    case 'modified':
      return output.warning('M');
    case 'deleted':
      return output.error('D');
    case 'renamed':
      return output.info('R');
    default:
      return status;
  }
}

// Main analyze command
export const analyzeCommand: Command = {
  name: 'analyze',
  description: 'Code analysis, diff classification, and change risk assessment',
  aliases: ['an'],
  subcommands: [
    diffCommand,
    codeCommand,
    depsCommand,
  ],
  options: [
    {
      name: 'format',
      short: 'f',
      description: 'Output format: text, json, table',
      type: 'string',
      default: 'text',
    },
  ],
  examples: [
    { command: 'claude-flow analyze diff --risk', description: 'Analyze diff with risk assessment' },
    { command: 'claude-flow analyze diff HEAD~1 --classify', description: 'Classify changes from last commit' },
    { command: 'claude-flow analyze diff main..feature --format json', description: 'Compare branches with JSON output' },
    { command: 'claude-flow analyze code -p ./src', description: 'Run code analysis' },
    { command: 'claude-flow analyze deps --security', description: 'Check dependency vulnerabilities' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // If no subcommand, show help
    output.writeln();
    output.writeln(output.bold('Analyze Commands'));
    output.writeln(output.dim('-'.repeat(50)));
    output.writeln();

    output.writeln(output.bold('Available subcommands:'));
    output.writeln();
    output.writeln(`  ${output.highlight('diff')}     Analyze git diff for change risk and classification`);
    output.writeln(`  ${output.highlight('code')}     Static code analysis and quality assessment`);
    output.writeln(`  ${output.highlight('deps')}     Analyze project dependencies`);
    output.writeln();

    output.writeln(output.bold('Examples:'));
    output.writeln();
    output.writeln(`  ${output.dim('claude-flow analyze diff --risk')}              # Risk assessment`);
    output.writeln(`  ${output.dim('claude-flow analyze diff HEAD~1 --classify')}   # Classify changes`);
    output.writeln(`  ${output.dim('claude-flow analyze diff main..feature')}       # Compare branches`);
    output.writeln();

    return { success: true };
  },
};

export default analyzeCommand;
