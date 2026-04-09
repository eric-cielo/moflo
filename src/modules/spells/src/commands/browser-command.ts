/**
 * Browser Step Command — Playwright web automation.
 *
 * Story #107: Implements the `browser` step command backed by Playwright.
 * Issue #219: Refactored to delegate action execution to the `playwright`
 * spell connector. Security policy (SSRF, evaluate gating) remains here.
 *
 * Playwright is an optional peer dependency. If not installed, the step
 * throws a clear error with install instructions.
 *
 * Security hardening (Issues #176, #177):
 * - SSRF: URL validation blocks dangerous schemes and private/internal IPs.
 * - Evaluate: gated behind explicit 'browser:evaluate' capability.
 *
 * Credential interpolation ({credentials.X}) is handled by the runner's
 * pre-resolution pass before this command executes.
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
} from '../types/step-command.types.js';
import { validateBrowserUrl } from './browser-url-validator.js';
import {
  loadPlaywright,
  executeBrowserAction,
  SUPPORTED_ACTIONS,
  type PlaywrightBrowser,
  type BrowserActionParams,
} from '../connectors/playwright.js';

/** Re-export the canonical action type from the tool for consumer use. */
export type BrowserAction = BrowserActionParams;

/** Typed config for the browser step command. */
export interface BrowserStepConfig extends StepConfig {
  readonly actions: BrowserAction[];
  readonly headless?: boolean;
  readonly timeout?: number;
}

// ── Action types ──────────────────────────────────────────────────────────

type ActionName = (typeof SUPPORTED_ACTIONS)[number];


// ── Prerequisites ────────────────────────────────────────────────────────

const browserPrerequisites: readonly Prerequisite[] = [
  {
    name: 'playwright',
    check: async () => {
      try {
        await import('playwright');
        return true;
      } catch {
        return false;
      }
    },
    installHint: 'Install Playwright: npm install playwright && npx playwright install chromium',
    url: 'https://playwright.dev/docs/intro',
  },
];

// ── Browser Step Command ──────────────────────────────────────────────────

export const browserCommand: StepCommand<BrowserStepConfig> = {
  type: 'browser',
  description: 'Web automation via Playwright (requires playwright peer dependency)',
  defaultMofloLevel: 'memory',
  prerequisites: browserPrerequisites,

  configSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'Sequential browser actions to execute',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...SUPPORTED_ACTIONS], description: 'Action name (open, click, fill, etc.)' },
            url: { type: 'string', description: 'URL for open action' },
            selector: { type: 'string', description: 'CSS selector for element actions' },
            value: { type: 'string', description: 'Value for fill/type/select/evaluate' },
            outputVar: { type: 'string', description: 'Variable to store action output' },
            button: { type: 'string', description: 'Mouse button for click (left, right, middle)' },
            count: { type: 'number', description: 'Click count' },
            direction: { type: 'string', description: 'Scroll direction (up, down, left, right)' },
            amount: { type: 'number', description: 'Scroll amount in pixels' },
            key: { type: 'string', description: 'Key name for press action' },
            expression: { type: 'string', description: 'JS expression for evaluate action' },
            text: { type: 'string', description: 'Text to wait for' },
            urlPattern: { type: 'string', description: 'URL pattern to wait for' },
            timeout: { type: 'number', description: 'Action timeout in ms' },
          },
          required: ['action'],
        },
      },
      headless: { type: 'boolean', description: 'Run in headless mode', default: true },
      timeout: { type: 'number', description: 'Default timeout in ms', default: 30000 },
    },
    required: ['actions'],
  } satisfies JSONSchema,

  capabilities: [
    { type: 'browser' },
    { type: 'net' },
    { type: 'fs:write' },
    { type: 'browser:evaluate' },
  ],

  validate(config: BrowserStepConfig): ValidationResult {
    const errors = [];
    if (!Array.isArray(config.actions)) {
      errors.push({ path: 'actions', message: 'actions must be an array' });
      return { valid: false, errors };
    }
    for (let i = 0; i < config.actions.length; i++) {
      const act = config.actions[i];
      if (!act.action || typeof act.action !== 'string') {
        errors.push({ path: `actions[${i}].action`, message: 'action is required' });
      } else if (!SUPPORTED_ACTIONS.includes(act.action as ActionName)) {
        errors.push({
          path: `actions[${i}].action`,
          message: `unsupported action: ${act.action}. Supported: ${SUPPORTED_ACTIONS.join(', ')}`,
        });
      }
    }
    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
      errors.push({ path: 'timeout', message: 'timeout must be a positive number' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: BrowserStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();
    const actions = config.actions;
    const headless = config.headless ?? true;
    const defaultTimeout = config.timeout ?? 30_000;
    const outputs: Record<string, unknown> = {};

    // Pre-flight: check all security constraints before loading Playwright.
    // This catches policy violations early without paying browser launch cost.
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      try {
        if (action.action === 'evaluate') {
          context.gateway.checkBrowserEvaluate();
        }
        if (action.action === 'open' && action.url) {
          validateBrowserUrl(action.url);
          context.gateway.checkNet(action.url);
        }
        if (action.action === 'wait' && action.urlPattern) {
          if (!action.urlPattern.startsWith('/') && !action.urlPattern.includes('*')) {
            validateBrowserUrl(action.urlPattern);
          }
        }
      } catch (err) {
        return {
          success: false,
          data: { failedAction: i, failedActionName: action.action },
          error: `Action ${i} (${action.action}) failed: ${(err as Error).message}`,
          duration: Date.now() - start,
        };
      }
    }

    let playwright: Awaited<ReturnType<typeof loadPlaywright>>;
    try {
      playwright = await loadPlaywright();
    } catch (err) {
      return {
        success: false,
        data: {},
        error: (err as Error).message,
        duration: Date.now() - start,
      };
    }

    let browser: PlaywrightBrowser | null = null;
    try {
      browser = await playwright.chromium.launch({ headless });
      const page = await browser.newPage();

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        try {
          // Security already validated in pre-flight above; delegate to tool
          await executeBrowserAction(page, action, outputs, defaultTimeout);
        } catch (err) {
          return {
            success: false,
            data: { ...outputs, failedAction: i, failedActionName: action.action },
            error: `Action ${i} (${action.action}) failed: ${(err as Error).message}`,
            duration: Date.now() - start,
          };
        }
      }

      return {
        success: true,
        data: { ...outputs, actionsExecuted: actions.length },
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: outputs,
        error: `Browser error: ${(err as Error).message}`,
        duration: Date.now() - start,
      };
    } finally {
      if (browser) {
        try { await browser.close(); } catch { /* ignore cleanup errors */ }
      }
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'actionsExecuted', type: 'number', required: true, description: 'Number of actions executed' },
      { name: 'screenshot_path', type: 'string', description: 'Path to screenshot file (if screenshot action used)' },
      { name: 'evaluate_note', type: 'string', description: "The evaluate action requires explicit 'browser:evaluate' capability declared in the step's capabilities" },
    ];
  },

};
