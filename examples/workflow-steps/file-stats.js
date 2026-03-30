/**
 * Example: file-stats step command (JS)
 *
 * Reports basic statistics about a file: line count, byte size, and extension.
 * Demonstrates how to create a custom StepCommand as a JS module.
 *
 * Usage in a workflow definition:
 *   steps:
 *     - id: stats
 *       type: file-stats
 *       config:
 *         path: "./src/index.ts"
 *
 * Discovery: Drop this file into `workflows/steps/` or `.claude/workflows/steps/`
 * in your project, and it will be auto-discovered by moflo's step registry.
 */

const { readFileSync, statSync } = require('node:fs');
const { extname } = require('node:path');

/** @type {import('moflo/dist/packages/workflows/src/types/step-command.types').StepCommand} */
const fileStatsCommand = {
  type: 'file-stats',
  description: 'Report file statistics: line count, byte size, and extension',

  configSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to analyze',
      },
    },
    required: ['path'],
  },

  capabilities: [{ type: 'fs:read' }],

  validate(config) {
    const errors = [];
    if (!config.path || typeof config.path !== 'string') {
      errors.push({ path: 'path', message: 'path is required and must be a string' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config) {
    try {
      const content = readFileSync(config.path, 'utf-8');
      const stat = statSync(config.path);

      return {
        success: true,
        data: {
          path: config.path,
          lines: content.split('\n').length,
          bytes: stat.size,
          extension: extname(config.path),
        },
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        error: err.message,
      };
    }
  },

  describeOutputs() {
    return [
      { name: 'path', type: 'string', description: 'File path analyzed' },
      { name: 'lines', type: 'number', description: 'Total line count' },
      { name: 'bytes', type: 'number', description: 'File size in bytes' },
      { name: 'extension', type: 'string', description: 'File extension' },
    ];
  },
};

module.exports = fileStatsCommand;
