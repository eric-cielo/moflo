/**
 * Browser Step Command — Playwright web automation (stub).
 *
 * This is a placeholder until Story #107 (Playwright Browser Automation) lands.
 * Throws a clear error if invoked without Playwright installed.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';

export const browserCommand: StepCommand = {
  type: 'browser',
  description: 'Web automation via Playwright (requires playwright peer dependency)',
  capabilities: [
    { type: 'browser' },
    { type: 'net' },
    { type: 'fs:write' },
  ],
  configSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Browser action (navigate, click, fill, screenshot, etc.)' },
      url: { type: 'string', description: 'URL to navigate to' },
      selector: { type: 'string', description: 'CSS selector for element actions' },
      value: { type: 'string', description: 'Value for fill actions' },
    },
    required: ['action'],
  } satisfies JSONSchema,

  validate(config: StepConfig): ValidationResult {
    const errors = [];
    if (!config.action || typeof config.action !== 'string') {
      errors.push({ path: 'action', message: 'action is required' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(): Promise<StepOutput> {
    return {
      success: false,
      data: {},
      error:
        'Browser step requires Playwright. Install it with: npm install playwright\n' +
        'This step will be fully implemented in Story #107.',
    };
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'html', type: 'string', description: 'Page HTML content' },
      { name: 'screenshot', type: 'string', description: 'Base64 screenshot' },
      { name: 'text', type: 'string', description: 'Extracted text content' },
    ];
  },
};
