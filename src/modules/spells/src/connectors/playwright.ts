/**
 * Playwright Spell Connector
 *
 * Reusable Playwright adapter implementing SpellConnector interface.
 * Extracted from the monolithic browser step command (Issue #219)
 * so custom spell steps can use browser automation via context.tools.
 *
 * Session management: initialize() pre-launches a browser that is reused
 * across execute() calls. dispose() closes the browser and cleans up
 * temporary screenshot files. If initialize() was not called, execute()
 * falls back to launching a single-shot browser per action.
 *
 * Security: URL validation (SSRF protection) and evaluate capability
 * gating are enforced at the step command level, not here. The connector
 * provides raw browser automation; the step command applies policy.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { SpellConnector, ConnectorAction, ConnectorOutput } from '../types/spell-connector.types.js';

// ============================================================================
// Playwright types (dynamic import — optional peer dependency)
// ============================================================================

export interface PlaywrightModule {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser>;
    launchPersistentContext(userDataDir: string, opts?: {
      headless?: boolean;
      acceptDownloads?: boolean;
      downloadsPath?: string;
    }): Promise<PlaywrightPersistentContext>;
  };
}

export interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightPersistentContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightElementHandle {
  click(opts?: Record<string, unknown>): Promise<void>;
  fill(value: string): Promise<void>;
  evaluate<T>(fn: string | ((el: unknown) => T)): Promise<T>;
  $(selector: string): Promise<PlaywrightElementHandle | null>;
  textContent(): Promise<string | null>;
}

export interface PlaywrightDownload {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

export interface PlaywrightPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  click(selector: string, opts?: { button?: string; clickCount?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<string[]>;
  textContent(selector: string): Promise<string | null>;
  inputValue(selector: string): Promise<string>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<PlaywrightElementHandle | null>;
  waitForURL(url: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<PlaywrightDownload>;
  evaluate<T>(fn: string | ((arg: unknown) => T), arg?: unknown): Promise<T>;
  hover(selector: string): Promise<void>;
  $(selector: string): Promise<PlaywrightElementHandle | null>;
  $$(selector: string): Promise<PlaywrightElementHandle[]>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  isClosed(): boolean;
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
  screenshotFiles?: string[],
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
      screenshotFiles?.push(screenshotPath);
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
// Per-action input schemas
// ============================================================================

const ACTION_SCHEMAS: Record<string, { description: string; inputSchema: ConnectorAction['inputSchema'] }> = {
  open: {
    description: 'Navigate to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        timeout: { type: 'number', description: 'Navigation timeout in ms' },
      },
      required: ['url'],
    },
  },
  click: {
    description: 'Click an element',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
        count: { type: 'number', description: 'Click count' },
      },
      required: ['selector'],
    },
  },
  fill: {
    description: 'Clear and fill an input field',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        value: { type: 'string', description: 'Value to fill' },
      },
      required: ['selector'],
    },
  },
  type: {
    description: 'Type text into an element (keystroke by keystroke)',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        value: { type: 'string', description: 'Text to type' },
      },
      required: ['selector'],
    },
  },
  select: {
    description: 'Select an option from a dropdown',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        value: { type: 'string', description: 'Option value to select' },
      },
      required: ['selector'],
    },
  },
  'get-text': {
    description: 'Get text content of an element',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        outputVar: { type: 'string', description: 'Variable name to store result' },
      },
      required: ['selector'],
    },
  },
  'get-value': {
    description: 'Get input value of a form element',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        outputVar: { type: 'string', description: 'Variable name to store result' },
      },
      required: ['selector'],
    },
  },
  screenshot: {
    description: 'Take a full-page screenshot',
    inputSchema: {
      type: 'object',
      properties: {
        outputVar: { type: 'string', description: 'Variable name to store file path' },
      },
    },
  },
  wait: {
    description: 'Wait for a selector, text, or URL pattern',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Text to wait for' },
        urlPattern: { type: 'string', description: 'URL pattern to wait for' },
        timeout: { type: 'number', description: 'Wait timeout in ms' },
      },
    },
  },
  evaluate: {
    description: 'Execute JavaScript in the browser context',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        value: { type: 'string', description: 'Alternative to expression' },
        outputVar: { type: 'string', description: 'Variable name to store result' },
      },
    },
  },
  scroll: {
    description: 'Scroll the page',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Scroll amount in pixels (default: 500)' },
      },
    },
  },
  hover: {
    description: 'Hover over an element',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
      },
      required: ['selector'],
    },
  },
  press: {
    description: 'Press a keyboard key',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g. Enter, Tab, ArrowDown)' },
      },
      required: ['key'],
    },
  },
};

const outputSchema = {
  type: 'object',
  properties: {
    actionsExecuted: { type: 'number' },
    screenshot_path: { type: 'string' },
  },
};

const ACTIONS: ConnectorAction[] = SUPPORTED_ACTIONS.map(name => ({
  name,
  description: ACTION_SCHEMAS[name].description,
  inputSchema: ACTION_SCHEMAS[name].inputSchema,
  outputSchema,
}));

// ============================================================================
// Playwright Connector (with session-based browser reuse)
// ============================================================================

export const playwrightConnector: SpellConnector = {
  name: 'playwright',
  description: 'Web automation via Playwright (open, click, fill, screenshot, evaluate, etc.)',
  version: '1.0.0',
  capabilities: ['read', 'write'],

  // Session state — managed browser and page reused across execute() calls.
  // Populated by initialize(), cleaned up by dispose().

  async initialize(config: Record<string, unknown>): Promise<void> {
    const pw = await loadPlaywright();
    const headless = (config.headless as boolean) ?? true;
    sessionBrowser = await pw.chromium.launch({ headless });
    sessionPage = await sessionBrowser.newPage();
  },

  async dispose(): Promise<void> {
    // Close session browser if open
    if (sessionBrowser) {
      try { await sessionBrowser.close(); } catch { /* ignore */ }
      sessionBrowser = null;
      sessionPage = null;
    }

    // Clean up tracked screenshot files
    const files = [...screenshotFiles];
    screenshotFiles.length = 0;
    await Promise.allSettled(files.map(f => unlink(f)));

    resetPlaywrightCache();
  },

  async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
    const start = Date.now();

    if (!SUPPORTED_ACTIONS.includes(action as BrowserActionName)) {
      return {
        success: false,
        data: {},
        error: `Unknown action "${action}". Available: ${SUPPORTED_ACTIONS.join(', ')}`,
        duration: Date.now() - start,
      };
    }

    const defaultTimeout = (params.timeout as number) ?? 30_000;
    const outputs: Record<string, unknown> = {};

    // If we have a session browser (from initialize), reuse it
    if (sessionPage) {
      try {
        await executeBrowserAction(
          sessionPage,
          { action, ...params } as BrowserActionParams,
          outputs,
          defaultTimeout,
          screenshotFiles,
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
      }
    }

    // No session — fall back to single-shot browser per action
    let playwright: PlaywrightModule;
    try {
      playwright = await loadPlaywright();
    } catch (err) {
      return { success: false, data: {}, error: (err as Error).message, duration: Date.now() - start };
    }

    const headless = (params.headless as boolean) ?? true;
    let browser: PlaywrightBrowser | null = null;
    try {
      browser = await playwright.chromium.launch({ headless });
      const page = await browser.newPage();

      await executeBrowserAction(
        page,
        { action, ...params } as BrowserActionParams,
        outputs,
        defaultTimeout,
        screenshotFiles,
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

  listActions(): ConnectorAction[] {
    return ACTIONS;
  },
};

// ============================================================================
// Session state (module-level, managed by initialize/dispose lifecycle)
// ============================================================================

let sessionBrowser: PlaywrightBrowser | null = null;
let sessionPage: PlaywrightPage | null = null;
const screenshotFiles: string[] = [];

/** Exposed for testing — get current session state. */
export function getSessionState(): { hasBrowser: boolean; hasPage: boolean; screenshotCount: number } {
  return {
    hasBrowser: sessionBrowser !== null,
    hasPage: sessionPage !== null,
    screenshotCount: screenshotFiles.length,
  };
}

/** Exposed for testing — reset session state without cleanup. */
export function resetSessionState(): void {
  sessionBrowser = null;
  sessionPage = null;
  screenshotFiles.length = 0;
}
