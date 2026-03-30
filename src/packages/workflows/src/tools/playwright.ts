/**
 * Playwright Workflow Tool
 *
 * Reusable Playwright adapter implementing WorkflowTool interface.
 * Extracted from the monolithic browser step command (Issue #219)
 * so custom workflow steps can use browser automation via context.tools.
 *
 * Actions: open, click, fill, type, select, get-text, get-value,
 *          screenshot, wait, evaluate, scroll, hover, press
 *
 * Security: URL validation (SSRF protection) and evaluate capability
 * gating are enforced at the step command level, not here. The tool
 * provides raw browser automation; the step command applies policy.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowTool, ToolAction, ToolOutput } from '../types/workflow-tool.types.js';

// ============================================================================
// Playwright types (dynamic import — optional peer dependency)
// ============================================================================

export interface PlaywrightModule {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}

export interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightPage {
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

// ============================================================================
// Playwright loader
// ============================================================================

let cachedPlaywright: PlaywrightModule | null = null;

export async function loadPlaywright(): Promise<PlaywrightModule> {
  if (cachedPlaywright) return cachedPlaywright;
  try {
    cachedPlaywright = await import('playwright') as unknown as PlaywrightModule;
    return cachedPlaywright;
  } catch {
    throw new Error(
      'Playwright is not installed. Install with:\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium\n' +
      'Playwright is an optional peer dependency of moflo.',
    );
  }
}

/** Reset cached Playwright module (for testing). */
export function resetPlaywrightCache(): void {
  cachedPlaywright = null;
}

// ============================================================================
// Supported actions
// ============================================================================

export const SUPPORTED_ACTIONS = [
  'open', 'click', 'fill', 'type', 'select',
  'get-text', 'get-value', 'screenshot', 'wait',
  'evaluate', 'scroll', 'hover', 'press',
] as const;

export type BrowserActionName = (typeof SUPPORTED_ACTIONS)[number];

// ============================================================================
// Single action executor (exported for step command reuse)
// ============================================================================

export interface BrowserActionParams {
  action: string;
  url?: string;
  selector?: string;
  value?: string;
  outputVar?: string;
  button?: 'left' | 'right' | 'middle';
  count?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  key?: string;
  expression?: string;
  text?: string;
  urlPattern?: string;
  timeout?: number;
}

export async function executeBrowserAction(
  page: PlaywrightPage,
  action: BrowserActionParams,
  outputs: Record<string, unknown>,
  defaultTimeout: number,
): Promise<void> {
  const timeout = action.timeout ?? defaultTimeout;

  switch (action.action) {
    case 'open': {
      if (!action.url) throw new Error('open action requires url');
      await page.goto(action.url, { timeout });
      break;
    }

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
      const screenshotPath = join(tmpdir(), `moflo-screenshot-${randomUUID()}.png`);
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
      throw new Error(`Unknown browser action: ${action.action}`);
  }
}

// ============================================================================
// Action schemas
// ============================================================================

const actionSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL for open action' },
    selector: { type: 'string', description: 'CSS selector for element actions' },
    value: { type: 'string', description: 'Value for fill/type/select/evaluate' },
    outputVar: { type: 'string', description: 'Variable to store action output' },
    button: { type: 'string', description: 'Mouse button (left, right, middle)' },
    count: { type: 'number', description: 'Click count' },
    direction: { type: 'string', description: 'Scroll direction (up, down, left, right)' },
    amount: { type: 'number', description: 'Scroll amount in pixels' },
    key: { type: 'string', description: 'Key name for press action' },
    expression: { type: 'string', description: 'JS expression for evaluate' },
    text: { type: 'string', description: 'Text to wait for' },
    urlPattern: { type: 'string', description: 'URL pattern to wait for' },
    timeout: { type: 'number', description: 'Action timeout in ms' },
    headless: { type: 'boolean', description: 'Run browser in headless mode', default: true },
  },
};

const ACTIONS: ToolAction[] = SUPPORTED_ACTIONS.map(name => ({
  name,
  description: `Browser ${name} action`,
  inputSchema: actionSchema,
  outputSchema: {
    type: 'object',
    properties: {
      actionsExecuted: { type: 'number' },
      screenshot_path: { type: 'string' },
    },
  },
}));

// ============================================================================
// Playwright Tool
// ============================================================================

export const playwrightTool: WorkflowTool = {
  name: 'playwright',
  description: 'Web automation via Playwright (open, click, fill, screenshot, evaluate, etc.)',
  version: '1.0.0',
  capabilities: ['read', 'write'],

  async initialize(): Promise<void> {
    await loadPlaywright();
  },

  async dispose(): Promise<void> {
    // Browser instances are managed per-execution, not at tool level
    resetPlaywrightCache();
  },

  async execute(action: string, params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now();

    if (!SUPPORTED_ACTIONS.includes(action as BrowserActionName)) {
      return {
        success: false,
        data: {},
        error: `Unknown action "${action}". Available: ${SUPPORTED_ACTIONS.join(', ')}`,
        duration: Date.now() - start,
      };
    }

    let playwright: PlaywrightModule;
    try {
      playwright = await loadPlaywright();
    } catch (err) {
      return { success: false, data: {}, error: (err as Error).message, duration: Date.now() - start };
    }

    const headless = (params.headless as boolean) ?? true;
    const defaultTimeout = (params.timeout as number) ?? 30_000;
    const outputs: Record<string, unknown> = {};

    let browser: PlaywrightBrowser | null = null;
    try {
      browser = await playwright.chromium.launch({ headless });
      const page = await browser.newPage();

      await executeBrowserAction(
        page,
        { action, ...params } as BrowserActionParams,
        outputs,
        defaultTimeout,
      );

      return {
        success: true,
        data: { ...outputs, actionsExecuted: 1 },
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: outputs,
        error: `Action ${action} failed: ${(err as Error).message}`,
        duration: Date.now() - start,
      };
    } finally {
      if (browser) {
        try { await browser.close(); } catch { /* ignore cleanup errors */ }
      }
    }
  },

  listActions(): ToolAction[] {
    return ACTIONS;
  },
};
