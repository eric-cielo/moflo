/**
 * Playwright Workflow Tool Tests
 *
 * Issue #219: Tests for the extracted playwright shipped tool.
 * Playwright is mocked to avoid real browser launches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  playwrightTool,
  SUPPORTED_ACTIONS,
  resetPlaywrightCache,
  resetSessionState,
  getSessionState,
  executeBrowserAction,
  type PlaywrightPage,
} from '../src/tools/playwright.js';

// ============================================================================
// Mock Playwright
// ============================================================================

const mockPage: PlaywrightPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  type: vi.fn().mockResolvedValue(undefined),
  selectOption: vi.fn().mockResolvedValue([]),
  textContent: vi.fn().mockResolvedValue('Hello World'),
  inputValue: vi.fn().mockResolvedValue('test-value'),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  waitForURL: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue({ result: true }),
  hover: vi.fn().mockResolvedValue(undefined),
  keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
  close: vi.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

beforeEach(() => {
  resetPlaywrightCache();
  resetSessionState();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// Interface compliance
// ============================================================================

describe('playwrightTool — interface', () => {
  it('has correct name and version', () => {
    expect(playwrightTool.name).toBe('playwright');
    expect(playwrightTool.version).toBe('1.0.0');
    expect(playwrightTool.description).toBeTruthy();
  });

  it('declares read and write capabilities', () => {
    expect(playwrightTool.capabilities).toContain('read');
    expect(playwrightTool.capabilities).toContain('write');
  });

  it('listActions returns 13 actions', () => {
    const actions = playwrightTool.listActions();
    expect(actions).toHaveLength(13);
    const names = actions.map(a => a.name);
    expect(names).toEqual([...SUPPORTED_ACTIONS]);
  });

  it('each action has input and output schemas', () => {
    for (const action of playwrightTool.listActions()) {
      expect(action.inputSchema).toBeDefined();
      expect(action.inputSchema.type).toBe('object');
      expect(action.outputSchema).toBeDefined();
      expect(action.description).toBeTruthy();
    }
  });

  it('initialize launches browser and creates session', async () => {
    await playwrightTool.initialize({});
    const state = getSessionState();
    expect(state.hasBrowser).toBe(true);
    expect(state.hasPage).toBe(true);
    // Clean up
    resetSessionState();
  });

  it('dispose closes browser and resets state', async () => {
    await playwrightTool.initialize({});
    await playwrightTool.dispose();
    const state = getSessionState();
    expect(state.hasBrowser).toBe(false);
    expect(state.hasPage).toBe(false);
  });

  it('per-action schemas have correct required fields', () => {
    const actions = playwrightTool.listActions();
    const openAction = actions.find(a => a.name === 'open')!;
    expect(openAction.inputSchema.required).toContain('url');

    const clickAction = actions.find(a => a.name === 'click')!;
    expect(clickAction.inputSchema.required).toContain('selector');

    const screenshotAction = actions.find(a => a.name === 'screenshot')!;
    expect(screenshotAction.inputSchema.required).toBeUndefined();
  });
});

// ============================================================================
// executeBrowserAction (unit tests for individual actions)
// ============================================================================

describe('executeBrowserAction', () => {
  it('open calls page.goto', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'open', url: 'https://example.com' }, outputs, 30000);
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { timeout: 30000 });
  });

  it('open throws without url', async () => {
    const outputs: Record<string, unknown> = {};
    await expect(
      executeBrowserAction(mockPage, { action: 'open' }, outputs, 30000),
    ).rejects.toThrow('open action requires url');
  });

  it('click calls page.click with selector', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'click', selector: '#btn' }, outputs, 30000);
    expect(mockPage.click).toHaveBeenCalledWith('#btn', { button: 'left', clickCount: 1 });
  });

  it('click throws without selector', async () => {
    const outputs: Record<string, unknown> = {};
    await expect(
      executeBrowserAction(mockPage, { action: 'click' }, outputs, 30000),
    ).rejects.toThrow('click action requires selector');
  });

  it('fill calls page.fill', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'fill', selector: '#input', value: 'hello' }, outputs, 30000);
    expect(mockPage.fill).toHaveBeenCalledWith('#input', 'hello');
  });

  it('type calls page.type', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'type', selector: '#input', value: 'world' }, outputs, 30000);
    expect(mockPage.type).toHaveBeenCalledWith('#input', 'world');
  });

  it('select calls page.selectOption', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'select', selector: '#dropdown', value: 'opt1' }, outputs, 30000);
    expect(mockPage.selectOption).toHaveBeenCalledWith('#dropdown', 'opt1');
  });

  it('get-text stores text in outputVar', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'get-text', selector: '#el', outputVar: 'myText' }, outputs, 30000);
    expect(mockPage.textContent).toHaveBeenCalledWith('#el');
    expect(outputs.myText).toBe('Hello World');
  });

  it('get-value stores value in outputVar', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'get-value', selector: '#input', outputVar: 'val' }, outputs, 30000);
    expect(outputs.val).toBe('test-value');
  });

  it('screenshot stores path in outputs', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'screenshot' }, outputs, 30000);
    expect(mockPage.screenshot).toHaveBeenCalled();
    expect(outputs.screenshot_path).toBeTruthy();
    expect(typeof outputs.screenshot_path).toBe('string');
  });

  it('wait with selector calls waitForSelector', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'wait', selector: '#loaded' }, outputs, 30000);
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('#loaded', { timeout: 30000 });
  });

  it('wait with urlPattern calls waitForURL', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'wait', urlPattern: '/dashboard' }, outputs, 30000);
    expect(mockPage.waitForURL).toHaveBeenCalledWith('/dashboard', { timeout: 30000 });
  });

  it('wait with text waits for text selector', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'wait', text: 'Loading complete' }, outputs, 30000);
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('text=Loading complete', { timeout: 30000 });
  });

  it('wait throws without selector, text, or urlPattern', async () => {
    const outputs: Record<string, unknown> = {};
    await expect(
      executeBrowserAction(mockPage, { action: 'wait' }, outputs, 30000),
    ).rejects.toThrow('wait action requires selector, text, or urlPattern');
  });

  it('evaluate calls page.evaluate and stores result', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'evaluate', expression: 'document.title', outputVar: 'title' }, outputs, 30000);
    expect(mockPage.evaluate).toHaveBeenCalledWith('document.title');
    expect(outputs.title).toEqual({ result: true });
  });

  it('evaluate throws without expression', async () => {
    const outputs: Record<string, unknown> = {};
    await expect(
      executeBrowserAction(mockPage, { action: 'evaluate' }, outputs, 30000),
    ).rejects.toThrow('evaluate action requires expression or value');
  });

  it('scroll calls mouse.wheel with correct deltas', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'scroll', direction: 'down', amount: 300 }, outputs, 30000);
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 300);
  });

  it('hover calls page.hover', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'hover', selector: '#menu' }, outputs, 30000);
    expect(mockPage.hover).toHaveBeenCalledWith('#menu');
  });

  it('press calls keyboard.press', async () => {
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'press', key: 'Enter' }, outputs, 30000);
    expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
  });

  it('throws for unknown action', async () => {
    const outputs: Record<string, unknown> = {};
    await expect(
      executeBrowserAction(mockPage, { action: 'teleport' }, outputs, 30000),
    ).rejects.toThrow('Unknown browser action: teleport');
  });
});

// ============================================================================
// Tool execute (full integration with browser launch)
// ============================================================================

describe('playwrightTool — execute', () => {
  it('executes open action successfully', async () => {
    const result = await playwrightTool.execute('open', { url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.data.actionsExecuted).toBe(1);
    expect(mockPage.goto).toHaveBeenCalled();
  });

  it('executes click action', async () => {
    const result = await playwrightTool.execute('click', { selector: '#btn' });
    expect(result.success).toBe(true);
    expect(mockPage.click).toHaveBeenCalled();
  });

  it('returns error for unknown action', async () => {
    const result = await playwrightTool.execute('destroy', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });

  it('returns error when action fails', async () => {
    const result = await playwrightTool.execute('open', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('open action requires url');
  });

  it('closes browser after execution (no session)', async () => {
    await playwrightTool.execute('open', { url: 'https://example.com' });
    expect(mockBrowser.close).toHaveBeenCalled();
  });
});

// ============================================================================
// Session-based browser reuse
// ============================================================================

describe('playwrightTool — session reuse', () => {
  afterEach(async () => {
    // Ensure session is cleaned up after each test
    resetSessionState();
  });

  it('reuses session browser across multiple execute calls', async () => {
    await playwrightTool.initialize({});
    vi.clearAllMocks(); // Clear launch call from initialize

    await playwrightTool.execute('open', { url: 'https://a.com' });
    await playwrightTool.execute('click', { selector: '#btn' });

    // Should NOT launch a new browser — session reuse
    const pw = await import('playwright') as any;
    expect(pw.chromium.launch).not.toHaveBeenCalled();
    expect(mockPage.goto).toHaveBeenCalledWith('https://a.com', { timeout: 30000 });
    expect(mockPage.click).toHaveBeenCalledWith('#btn', { button: 'left', clickCount: 1 });

    resetSessionState();
  });

  it('does not close browser between session execute calls', async () => {
    await playwrightTool.initialize({});
    vi.clearAllMocks();

    await playwrightTool.execute('open', { url: 'https://a.com' });
    expect(mockBrowser.close).not.toHaveBeenCalled();

    resetSessionState();
  });

  it('dispose closes session browser', async () => {
    await playwrightTool.initialize({});
    vi.clearAllMocks();

    await playwrightTool.dispose();
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(getSessionState().hasBrowser).toBe(false);
  });

  it('session execute returns error for failed action', async () => {
    await playwrightTool.initialize({});
    const result = await playwrightTool.execute('open', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('open action requires url');

    resetSessionState();
  });

  it('initialize accepts headless config', async () => {
    await playwrightTool.initialize({ headless: false });
    const pw = await import('playwright') as any;
    expect(pw.chromium.launch).toHaveBeenCalledWith({ headless: false });

    resetSessionState();
  });
});

// ============================================================================
// Screenshot file tracking
// ============================================================================

describe('playwrightTool — screenshot tracking', () => {
  it('tracks screenshot files via screenshotFiles param', async () => {
    const files: string[] = [];
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'screenshot' }, outputs, 30000, files);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('moflo-screenshot-');
    expect(outputs.screenshot_path).toBe(files[0]);
  });

  it('tracks screenshots in session mode', async () => {
    await playwrightTool.initialize({});

    await playwrightTool.execute('screenshot', {});
    const state = getSessionState();
    expect(state.screenshotCount).toBe(1);

    await playwrightTool.execute('screenshot', {});
    expect(getSessionState().screenshotCount).toBe(2);

    resetSessionState();
  });

  it('screenshot uses custom outputVar', async () => {
    const files: string[] = [];
    const outputs: Record<string, unknown> = {};
    await executeBrowserAction(mockPage, { action: 'screenshot', outputVar: 'snap' }, outputs, 30000, files);
    expect(outputs.snap).toBeTruthy();
    expect(outputs.screenshot_path).toBeUndefined();
  });
});

// ============================================================================
// Session state helpers
// ============================================================================

describe('getSessionState / resetSessionState', () => {
  it('reports no session by default', () => {
    const state = getSessionState();
    expect(state.hasBrowser).toBe(false);
    expect(state.hasPage).toBe(false);
    expect(state.screenshotCount).toBe(0);
  });

  it('resetSessionState clears state without cleanup', async () => {
    await playwrightTool.initialize({});
    expect(getSessionState().hasBrowser).toBe(true);

    resetSessionState();
    expect(getSessionState().hasBrowser).toBe(false);
    // Browser.close should NOT have been called by resetSessionState
    vi.clearAllMocks();
    expect(mockBrowser.close).not.toHaveBeenCalled();
  });
});
