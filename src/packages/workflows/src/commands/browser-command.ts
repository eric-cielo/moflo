/**
 * Browser Step Command — Playwright web automation.
 *
 * Story #107: Implements the `browser` step command backed by Playwright.
 * Playwright is an optional peer dependency. If not installed, the step
 * throws a clear error with install instructions.
 *
 * Config supports a sequential list of actions: open, click, fill, type,
 * select, get-text, get-value, screenshot, wait, evaluate, scroll, hover, press.
 *
 * Credential interpolation ({credentials.X}) is handled by the runner's
 * pre-resolution pass before this command executes.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';
import { interpolateConfig } from '../core/interpolation.js';

// ── Action types ──────────────────────────────────────────────────────────

const SUPPORTED_ACTIONS = [
  'open', 'click', 'fill', 'type', 'select',
  'get-text', 'get-value', 'screenshot', 'wait',
  'evaluate', 'scroll', 'hover', 'press',
] as const;

type ActionName = (typeof SUPPORTED_ACTIONS)[number];

interface BrowserAction {
  action: ActionName;
  url?: string;
  selector?: string;
  value?: string;
  outputVar?: string;
  // click options
  button?: 'left' | 'right' | 'middle';
  count?: number;
  // scroll options
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  // press options
  key?: string;
  // evaluate options
  expression?: string;
  // wait options
  text?: string;
  urlPattern?: string;
  timeout?: number;
}

// ── Playwright dynamic import ─────────────────────────────────────────────

interface PlaywrightModule {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  click(selector: string, opts?: { button?: string; clickCount?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<string[]>;
  textContent(selector: string): Promise<string | null>;
  inputValue(selector: string): Promise<string>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForURL(url: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  hover(selector: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  close(): Promise<void>;
}

let cachedPlaywright: PlaywrightModule | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (cachedPlaywright) return cachedPlaywright;
  try {
    cachedPlaywright = await import('playwright') as unknown as PlaywrightModule;
    return cachedPlaywright;
  } catch {
    throw new Error(
      'Browser step requires Playwright. Install with:\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium\n' +
      'Playwright is an optional peer dependency of moflo.',
    );
  }
}

// ── Action executor ───────────────────────────────────────────────────────

async function executeAction(
  page: PlaywrightPage,
  action: BrowserAction,
  outputs: Record<string, unknown>,
  defaultTimeout: number,
): Promise<void> {
  const timeout = action.timeout ?? defaultTimeout;

  switch (action.action) {
    case 'open':
      if (!action.url) throw new Error('open action requires url');
      await page.goto(action.url, { timeout });
      break;

    case 'click':
      if (!action.selector) throw new Error('click action requires selector');
      await page.click(action.selector, {
        button: action.button ?? 'left',
        clickCount: action.count ?? 1,
      });
      break;

    case 'fill':
      if (!action.selector) throw new Error('fill action requires selector');
      await page.fill(action.selector, action.value ?? '');
      break;

    case 'type':
      if (!action.selector) throw new Error('type action requires selector');
      await page.type(action.selector, action.value ?? '');
      break;

    case 'select':
      if (!action.selector) throw new Error('select action requires selector');
      await page.selectOption(action.selector, action.value ?? '');
      break;

    case 'get-text': {
      if (!action.selector) throw new Error('get-text action requires selector');
      const text = await page.textContent(action.selector);
      if (action.outputVar) outputs[action.outputVar] = text ?? '';
      break;
    }

    case 'get-value': {
      if (!action.selector) throw new Error('get-value action requires selector');
      const value = await page.inputValue(action.selector);
      if (action.outputVar) outputs[action.outputVar] = value;
      break;
    }

    case 'screenshot': {
      const screenshotPath = join(tmpdir(), `moflo-screenshot-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      if (action.outputVar) outputs[action.outputVar] = screenshotPath;
      else outputs.screenshot_path = screenshotPath;
      break;
    }

    case 'wait':
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout });
      } else if (action.urlPattern) {
        await page.waitForURL(action.urlPattern, { timeout });
      } else if (action.text) {
        await page.waitForSelector(`text=${action.text}`, { timeout });
      } else {
        throw new Error('wait action requires selector, text, or urlPattern');
      }
      break;

    case 'evaluate': {
      const expression = action.expression ?? action.value;
      if (!expression) throw new Error('evaluate action requires expression or value');
      const evalResult = await page.evaluate(expression);
      if (action.outputVar) outputs[action.outputVar] = evalResult;
      break;
    }

    case 'scroll': {
      const dir = action.direction ?? 'down';
      const amt = action.amount ?? 500;
      const deltaX = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
      const deltaY = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
      await page.mouse.wheel(deltaX, deltaY);
      break;
    }

    case 'hover':
      if (!action.selector) throw new Error('hover action requires selector');
      await page.hover(action.selector);
      break;

    case 'press':
      if (!action.key) throw new Error('press action requires key');
      await page.keyboard.press(action.key);
      break;

    default:
      throw new Error(`Unknown browser action: ${(action as BrowserAction).action}`);
  }
}

// ── Browser Step Command ──────────────────────────────────────────────────

export const browserCommand: StepCommand = {
  type: 'browser',
  description: 'Web automation via Playwright (requires playwright peer dependency)',

  configSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'Sequential browser actions to execute',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Action name (open, click, fill, etc.)' },
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

  validate(config: StepConfig): ValidationResult {
    const errors = [];
    if (!Array.isArray(config.actions)) {
      errors.push({ path: 'actions', message: 'actions must be an array' });
      return { valid: false, errors };
    }
    for (let i = 0; i < (config.actions as BrowserAction[]).length; i++) {
      const act = (config.actions as BrowserAction[])[i];
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

  async execute(config: StepConfig, context: WorkflowContext): Promise<StepOutput> {
    const start = Date.now();
    const actions = config.actions as BrowserAction[];
    const headless = (config.headless as boolean | undefined) ?? true;
    const defaultTimeout = (config.timeout as number | undefined) ?? 30_000;
    const outputs: Record<string, unknown> = {};

    // Interpolate all string values in actions
    const interpolated = interpolateConfig(
      { actions },
      context,
    ).actions as BrowserAction[];

    let playwright: PlaywrightModule;
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

      for (let i = 0; i < interpolated.length; i++) {
        const action = interpolated[i];
        try {
          await executeAction(page, action, outputs, defaultTimeout);
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
        data: { ...outputs, actionsExecuted: interpolated.length },
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
    ];
  },

  async rollback(): Promise<void> {},
};
