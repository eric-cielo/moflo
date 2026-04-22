/**
 * Built-in Step Commands Tests
 *
 * Story #102: Tests for all 8 built-in step commands.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { agentCommand } from '../src/commands/agent-command.js';
import { bashCommand } from '../src/commands/bash-command.js';
import { conditionCommand } from '../src/commands/condition-command.js';
import { promptCommand } from '../src/commands/prompt-command.js';
import { memoryCommand } from '../src/commands/memory-command.js';
import { waitCommand } from '../src/commands/wait-command.js';
import { loopCommand } from '../src/commands/loop-command.js';
import { browserCommand } from '../src/commands/browser-command.js';
import { validateBrowserUrl } from '../src/commands/browser-url-validator.js';
import { builtinCommands } from '../src/commands/index.js';
import type { MemoryAccessor } from '../src/types/step-command.types.js';
import { CapabilityGateway } from '../src/core/capability-gateway.js';
import { createMockContext as createContext } from './helpers.js';

/**
 * Some browser tests assert the "Playwright not installed" error path.
 * When Playwright is actually installed in the dev environment (e.g. after
 * running the outlook spell), those assertions fail. Skip them in that case —
 * the code path under test cannot fire.
 */
const playwrightInstalled = (() => {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return true;
  } catch {
    return false;
  }
})();
const itWithoutPlaywright = playwrightInstalled ? it.skip : it;

// ============================================================================
// Registry
// ============================================================================

describe('builtinCommands', () => {
  it('should have all 15 commands', () => {
    expect(builtinCommands).toHaveLength(15);
    const types = builtinCommands.map(c => c.type);
    expect(types).toEqual(['agent', 'bash', 'condition', 'prompt', 'memory', 'wait', 'loop', 'browser', 'github', 'parallel', 'outlook', 'slack', 'imap', 'mcp', 'graph']);
  });

  it('should have unique types', () => {
    const types = builtinCommands.map(c => c.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

// ============================================================================
// Agent Command
// ============================================================================

describe('agentCommand', () => {
  it('should validate with valid config', () => {
    const result = agentCommand.validate({ prompt: 'analyze code' }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should reject missing prompt', () => {
    const result = agentCommand.validate({}, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('prompt');
  });

  it('should execute and return agent config', async () => {
    const ctx = createContext();
    const output = await agentCommand.execute(
      { prompt: 'test task', agentType: 'researcher', background: true },
      ctx,
    );
    expect(output.success).toBe(true);
    expect(output.data.agentType).toBe('researcher');
    expect(output.data.prompt).toBe('test task');
    expect(output.data.background).toBe(true);
  });

  it('should interpolate variables in prompt', async () => {
    const ctx = createContext({ variables: { step1: { file: 'main.ts' } } });
    const output = await agentCommand.execute(
      { prompt: 'Review {step1.file}' },
      ctx,
    );
    expect(output.data.prompt).toBe('Review main.ts');
  });
});

// ============================================================================
// Bash Command
// ============================================================================

describe('bashCommand', () => {
  it('should validate with valid config', () => {
    const result = bashCommand.validate({ command: 'echo hello' }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should reject missing command', () => {
    const result = bashCommand.validate({}, createContext());
    expect(result.valid).toBe(false);
  });

  it('should reject invalid timeout', () => {
    const result = bashCommand.validate({ command: 'echo hi', timeout: -1 }, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('timeout');
  });

  it('should execute and capture stdout', async () => {
    const ctx = createContext();
    const output = await bashCommand.execute({ command: 'echo hello' }, ctx);
    expect(output.success).toBe(true);
    expect(output.data.stdout).toBe('hello');
    expect(output.data.exitCode).toBe(0);
  });

  it('should capture stderr on error', async () => {
    const ctx = createContext();
    const output = await bashCommand.execute(
      { command: 'echo error >&2 && exit 1', failOnError: false },
      ctx,
    );
    expect(output.success).toBe(true); // failOnError=false
    expect(output.data.stderr).toBe('error');
  });

  it('should fail on non-zero exit when failOnError is true', async () => {
    const ctx = createContext();
    const output = await bashCommand.execute(
      { command: 'exit 1', failOnError: true },
      ctx,
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('exited with code');
  });

  it('should interpolate variables in command', async () => {
    const ctx = createContext({ variables: { s1: { msg: 'world' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.msg}' }, ctx);
    // shellInterpolateString wraps values in single quotes for safety
    expect(output.data.stdout).toContain('world');
  });

  // ---- Shell injection prevention (Issue #175) ----

  it('should escape semicolon injection in interpolated values', async () => {
    const ctx = createContext({ variables: { s1: { val: '; echo injected' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.val}' }, ctx);
    // The value should be treated as a literal string, not executed
    expect(output.data.stdout).toContain('; echo injected');
    expect(output.data.stdout).not.toBe('injected');
  });

  it('should escape backtick injection in interpolated values', async () => {
    const ctx = createContext({ variables: { s1: { val: '`echo injected`' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.val}' }, ctx);
    expect(output.data.stdout).toContain('`echo injected`');
  });

  it('should escape $() injection in interpolated values', async () => {
    const ctx = createContext({ variables: { s1: { val: '$(echo injected)' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.val}' }, ctx);
    expect(output.data.stdout).toContain('$(echo injected)');
  });

  it('should escape pipe injection in interpolated values', async () => {
    const ctx = createContext({ variables: { s1: { val: '| echo injected' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.val}' }, ctx);
    expect(output.data.stdout).toContain('| echo injected');
  });

  it('should escape && injection in interpolated values', async () => {
    const ctx = createContext({ variables: { s1: { val: '&& echo injected' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.val}' }, ctx);
    expect(output.data.stdout).toContain('&& echo injected');
  });

  it('should still work with normal values after escaping', async () => {
    const ctx = createContext({ variables: { s1: { name: 'hello world' } } });
    const output = await bashCommand.execute({ command: 'echo {s1.name}' }, ctx);
    expect(output.success).toBe(true);
    expect(output.data.stdout).toBe('hello world');
  });

  it('should respect abort signal', async () => {
    const controller = new AbortController();
    const ctx = createContext({ abortSignal: controller.signal });
    // Abort before starting so the command exits immediately
    controller.abort();
    const output = await bashCommand.execute({ command: 'sleep 10' }, ctx);
    // Command should complete (killed), not hang
    expect(output.duration).toBeDefined();
  }, 10000);

  it('should timeout long commands', async () => {
    const ctx = createContext();
    const output = await bashCommand.execute(
      { command: 'sleep 30', timeout: 500, failOnError: true },
      ctx,
    );
    expect(output.success).toBe(false);
    expect(output.data.timedOut).toBe(true);
    expect(output.error).toContain('timed out');
    expect(output.duration).toBeLessThan(5000);
  }, 10000);
});

// ============================================================================
// Condition Command
// ============================================================================

describe('conditionCommand', () => {
  it('should validate with valid config', () => {
    const result = conditionCommand.validate({ if: 'true' }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should reject missing if expression', () => {
    const result = conditionCommand.validate({}, createContext());
    expect(result.valid).toBe(false);
  });

  it('should evaluate truthy string as true', async () => {
    const ctx = createContext({ variables: { s1: { status: 'active' } } });
    const output = await conditionCommand.execute(
      { if: '{s1.status}', then: 'step-a', else: 'step-b' },
      ctx,
    );
    expect(output.data.result).toBe(true);
    expect(output.data.branch).toBe('then');
    expect(output.data.nextStep).toBe('step-a');
  });

  it('should evaluate false string as false', async () => {
    const ctx = createContext({ variables: { s1: { ok: 'false' } } });
    const output = await conditionCommand.execute(
      { if: '{s1.ok}', then: 'step-a', else: 'step-b' },
      ctx,
    );
    expect(output.data.result).toBe(false);
    expect(output.data.branch).toBe('else');
    expect(output.data.nextStep).toBe('step-b');
  });

  it('should evaluate equality operator', async () => {
    const ctx = createContext({ variables: { s1: { count: '5' } } });
    const output = await conditionCommand.execute(
      { if: '{s1.count}==5' },
      ctx,
    );
    expect(output.data.result).toBe(true);
  });

  it('should evaluate inequality', async () => {
    const ctx = createContext({ variables: { s1: { count: '3' } } });
    const output = await conditionCommand.execute(
      { if: '{s1.count}!=5' },
      ctx,
    );
    expect(output.data.result).toBe(true);
  });

  it('should evaluate comparison operators', async () => {
    const ctx = createContext({ variables: { s1: { count: '10' } } });
    const gt = await conditionCommand.execute({ if: '{s1.count}>5' }, ctx);
    expect(gt.data.result).toBe(true);

    const lt = await conditionCommand.execute({ if: '{s1.count}<5' }, ctx);
    expect(lt.data.result).toBe(false);
  });

  // ---- Structured condition format (Issue #190) ----

  it('should evaluate structured format: greater-than', async () => {
    const ctx = createContext();
    const output = await conditionCommand.execute(
      { left: '5', op: '>', right: '3', then: 'step-a', else: 'step-b' },
      ctx,
    );
    expect(output.data.result).toBe(true);
    expect(output.data.branch).toBe('then');
    expect(output.data.nextStep).toBe('step-a');
  });

  it('should evaluate structured format with values containing operators', async () => {
    const ctx = createContext();
    const output = await conditionCommand.execute(
      { left: '>=1', op: '==', right: '>=1' },
      ctx,
    );
    expect(output.data.result).toBe(true);
  });

  it('should validate structured format with invalid operator', () => {
    const result = conditionCommand.validate(
      { left: '5', op: '~~' as never, right: '3' },
      createContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('op');
  });

  it('should validate that either string or structured format is required', () => {
    const result = conditionCommand.validate({ then: 'step-a' }, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Either');
  });

  it('should interpolate variables in structured format', async () => {
    const ctx = createContext({ variables: { s1: { count: '10' } } });
    const output = await conditionCommand.execute(
      { left: '{s1.count}', op: '>=', right: '5' },
      ctx,
    );
    expect(output.data.result).toBe(true);
  });

  it('should prefer structured format over string format when both present', async () => {
    const ctx = createContext();
    // String format would evaluate "1==2" as false, but structured says 1==1
    const output = await conditionCommand.execute(
      { if: '1==2', left: '1', op: '==', right: '1' },
      ctx,
    );
    expect(output.data.result).toBe(true);
  });
});

// ============================================================================
// Prompt Command
// ============================================================================

describe('promptCommand', () => {
  it('should validate with valid config', () => {
    const result = promptCommand.validate({ message: 'Enter name:' }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should reject missing message', () => {
    const result = promptCommand.validate({}, createContext());
    expect(result.valid).toBe(false);
  });

  it('should return prompt config with defaults', async () => {
    const output = await promptCommand.execute(
      { message: 'Continue?', options: ['yes', 'no'], default: 'yes' },
      createContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.message).toBe('Continue?');
    expect(output.data.response).toBe('yes');
    expect(output.data.outputVar).toBe('response');
  });
});

// ============================================================================
// Memory Command
// ============================================================================

describe('memoryCommand', () => {
  it('should validate read config', () => {
    const result = memoryCommand.validate(
      { action: 'read', namespace: 'tasks', key: 'task-1' },
      createContext(),
    );
    expect(result.valid).toBe(true);
  });

  it('should reject invalid action', () => {
    const result = memoryCommand.validate(
      { action: 'invalid', namespace: 'tasks' },
      createContext(),
    );
    expect(result.valid).toBe(false);
  });

  it('should reject write without value', () => {
    const result = memoryCommand.validate(
      { action: 'write', namespace: 'tasks', key: 'k1' },
      createContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('value');
  });

  it('should reject search without query', () => {
    const result = memoryCommand.validate(
      { action: 'search', namespace: 'tasks' },
      createContext(),
    );
    expect(result.valid).toBe(false);
  });

  it('should write and read from memory', async () => {
    const store = new Map<string, unknown>();
    const memory: MemoryAccessor = {
      async read(_ns, key) { return store.get(key) ?? null; },
      async write(_ns, key, value) { store.set(key, value); },
      async search() { return []; },
    };
    const ctx = createContext({ memory });

    const writeResult = await memoryCommand.execute(
      { action: 'write', namespace: 'tasks', key: 'k1', value: 'data' },
      ctx,
    );
    expect(writeResult.success).toBe(true);
    expect(writeResult.data.written).toBe(true);

    const readResult = await memoryCommand.execute(
      { action: 'read', namespace: 'tasks', key: 'k1' },
      ctx,
    );
    expect(readResult.data.value).toBe('data');
    expect(readResult.data.found).toBe(true);
  });

  it('should interpolate string values on write', async () => {
    const store = new Map<string, unknown>();
    const memory: MemoryAccessor = {
      async read(_ns, key) { return store.get(key) ?? null; },
      async write(_ns, key, value) { store.set(key, value); },
      async search() { return []; },
    };
    const ctx = createContext({
      memory,
      args: { env: 'production' },
    });

    await memoryCommand.execute(
      { action: 'write', namespace: 'config', key: 'env', value: 'deploying to {args.env}' },
      ctx,
    );
    expect(store.get('env')).toBe('deploying to production');
  });

  // --- Scope enforcement (Issue #178) ---

  it('should block write to namespace outside memory scope', async () => {
    const caps = [{ type: 'memory' as const, scope: ['allowed-ns'] }];
    const ctx = createContext({
      effectiveCaps: caps,
      gateway: new CapabilityGateway(caps, 'test', 'memory'),
    });
    const output = await memoryCommand.execute(
      { action: 'write', namespace: 'forbidden-ns', key: 'k1', value: 'data' },
      ctx,
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('outside allowed scope');
    expect(output.error).toContain('memory');
  });

  it('should allow write to namespace within memory scope', async () => {
    const store = new Map<string, unknown>();
    const memory: MemoryAccessor = {
      async read(_ns, key) { return store.get(key) ?? null; },
      async write(_ns, key, value) { store.set(key, value); },
      async search() { return []; },
    };
    const ctx = createContext({
      memory,
      effectiveCaps: [{ type: 'memory', scope: ['allowed-ns'] }],
    });
    const output = await memoryCommand.execute(
      { action: 'write', namespace: 'allowed-ns', key: 'k1', value: 'data' },
      ctx,
    );
    expect(output.success).toBe(true);
    expect(output.data.written).toBe(true);
  });

  it('should search memory', async () => {
    const memory: MemoryAccessor = {
      async read() { return null; },
      async write() {},
      async search() {
        return [{ key: 'k1', value: 'found', score: 0.9 }];
      },
    };
    const ctx = createContext({ memory });

    const result = await memoryCommand.execute(
      { action: 'search', namespace: 'tasks', query: 'find something' },
      ctx,
    );
    expect(result.data.count).toBe(1);
    expect(result.data.results).toHaveLength(1);
  });
});

// ============================================================================
// Wait Command
// ============================================================================

describe('waitCommand', () => {
  it('should validate with valid duration', () => {
    const result = waitCommand.validate({ duration: 100 }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should reject negative duration', () => {
    const result = waitCommand.validate({ duration: -1 }, createContext());
    expect(result.valid).toBe(false);
  });

  it('should wait for specified duration', async () => {
    const target = 10;
    const output = await waitCommand.execute({ duration: target }, createContext());
    expect(output.success).toBe(true);
    expect(output.data.waited).toBe(target);
    // Allow 1ms of timer jitter: Date.now() has integer-ms resolution and Node's
    // setTimeout may fire slightly before the target on fast Linux CI runners.
    expect(output.duration).toBeGreaterThanOrEqual(target - 1);
  });

  it('should reject on abort signal', async () => {
    const controller = new AbortController();
    const ctx = createContext({ abortSignal: controller.signal });
    const promise = waitCommand.execute({ duration: 10000 }, ctx);
    controller.abort();
    await expect(promise).rejects.toThrow('Wait aborted');
  });
});

// ============================================================================
// Loop Command
// ============================================================================

describe('loopCommand', () => {
  it('should validate with valid config', () => {
    const result = loopCommand.validate(
      { over: [1, 2, 3] },
      createContext(),
    );
    expect(result.valid).toBe(true);
  });

  it('should reject missing over', () => {
    const result = loopCommand.validate({}, createContext());
    expect(result.valid).toBe(false);
  });

  it('should reject non-array over', () => {
    const result = loopCommand.validate({ over: 'not-array' }, createContext());
    expect(result.valid).toBe(false);
  });

  it('should iterate over array', async () => {
    const output = await loopCommand.execute(
      { over: ['a', 'b', 'c'] },
      createContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.totalItems).toBe(3);
    expect(output.data.iterations).toBe(3);
    expect(output.data.truncated).toBe(false);
    expect(output.data.items).toEqual(['a', 'b', 'c']);
  });

  it('should respect maxIterations guard', async () => {
    const output = await loopCommand.execute(
      { over: [1, 2, 3, 4, 5], maxIterations: 3 },
      createContext(),
    );
    expect(output.data.iterations).toBe(3);
    expect(output.data.truncated).toBe(true);
    expect(output.data.items).toEqual([1, 2, 3]);
  });

  it('should use custom variable names', async () => {
    const output = await loopCommand.execute(
      { over: [1], itemVar: 'file', indexVar: 'i' },
      createContext(),
    );
    expect(output.data.itemVar).toBe('file');
    expect(output.data.indexVar).toBe('i');
  });
});

// ============================================================================
// Browser Command
// ============================================================================

describe('browserCommand', () => {
  // --- Validation ---

  it('should validate with valid actions array', () => {
    const result = browserCommand.validate({
      actions: [{ action: 'open', url: 'https://example.com' }],
    }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should validate multiple actions', () => {
    const result = browserCommand.validate({
      actions: [
        { action: 'open', url: 'https://example.com' },
        { action: 'click', selector: '#btn' },
        { action: 'fill', selector: '#input', value: 'hello' },
        { action: 'screenshot', outputVar: 'img' },
      ],
    }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should reject missing actions array', () => {
    const result = browserCommand.validate({}, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('actions');
  });

  it('should reject non-array actions', () => {
    const result = browserCommand.validate({ actions: 'open' }, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('actions');
  });

  it('should reject action with missing action name', () => {
    const result = browserCommand.validate({
      actions: [{ url: 'https://example.com' }],
    }, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('actions[0].action');
  });

  it('should reject unsupported action name', () => {
    const result = browserCommand.validate({
      actions: [{ action: 'teleport' }],
    }, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('unsupported action: teleport');
  });

  it('should reject invalid timeout', () => {
    const result = browserCommand.validate({
      actions: [{ action: 'open', url: 'https://example.com' }],
      timeout: -1,
    }, createContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('timeout');
  });

  it('should validate all supported action names', () => {
    const supported = [
      'open', 'click', 'fill', 'type', 'select',
      'get-text', 'get-value', 'screenshot', 'wait',
      'evaluate', 'scroll', 'hover', 'press',
    ];
    for (const action of supported) {
      const result = browserCommand.validate({
        actions: [{ action }],
      }, createContext());
      expect(result.valid).toBe(true);
    }
  });

  // --- Execution (Playwright not installed) ---

  itWithoutPlaywright('should fail execution with Playwright install instructions', async () => {
    const output = await browserCommand.execute(
      { actions: [{ action: 'open', url: 'https://example.com' }] },
      createContext(),
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('Playwright');
    expect(output.error).toContain('npm install playwright');
  });

  // --- Output descriptors ---

  it('should describe outputs including evaluate note', () => {
    const outputs = browserCommand.describeOutputs();
    expect(outputs).toHaveLength(3);
    expect(outputs[0].name).toBe('actionsExecuted');
    expect(outputs[1].name).toBe('screenshot_path');
    expect(outputs[2].name).toBe('evaluate_note');
  });

  // --- Scope enforcement (Issue #178) ---

  it('should block open to URL outside net scope', async () => {
    const caps = [
      { type: 'browser' as const },
      { type: 'net' as const, scope: ['https://allowed.com'] },
    ];
    const ctx = createContext({
      effectiveCaps: caps,
      gateway: new CapabilityGateway(caps, 'test', 'browser'),
    });
    const output = await browserCommand.execute(
      { actions: [{ action: 'open', url: 'https://blocked.com/page' }] },
      ctx,
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('outside allowed scope');
    expect(output.error).toContain('net');
  });

  itWithoutPlaywright('should allow open to URL within net scope', async () => {
    const caps = [
      { type: 'browser' as const },
      { type: 'net' as const, scope: ['https://allowed.com'] },
    ];
    const ctx = createContext({
      effectiveCaps: caps,
      gateway: new CapabilityGateway(caps, 'test', 'browser'),
    });
    const output = await browserCommand.execute(
      { actions: [{ action: 'open', url: 'https://allowed.com/page' }] },
      ctx,
    );
    // Should pass scope check but fail due to Playwright not installed
    expect(output.success).toBe(false);
    expect(output.error).toContain('Playwright');
    expect(output.error).not.toContain('scope');
  });

  // --- Config schema ---

  it('should have actions as required in schema', () => {
    expect(browserCommand.configSchema.required).toContain('actions');
  });

  it('should define headless option in schema', () => {
    expect(browserCommand.configSchema.properties?.headless).toBeDefined();
  });

  // --- SSRF protection (Issue #177) ---

  it('should block file:// URLs', () => {
    expect(() => validateBrowserUrl('file:///etc/passwd')).toThrow('Blocked URL scheme');
  });

  it('should block javascript: URLs', () => {
    expect(() => validateBrowserUrl('javascript:alert(1)')).toThrow('Blocked URL scheme');
  });

  it('should block http://169.254.169.254/ (metadata endpoint)', () => {
    expect(() => validateBrowserUrl('http://169.254.169.254/')).toThrow('private/internal IP');
  });

  it('should block http://localhost:8080/', () => {
    expect(() => validateBrowserUrl('http://localhost:8080/')).toThrow('localhost is not allowed');
  });

  it('should block http://127.0.0.1/', () => {
    expect(() => validateBrowserUrl('http://127.0.0.1/')).toThrow('private/internal IP');
  });

  it('should allow https://example.com/', () => {
    expect(() => validateBrowserUrl('https://example.com/')).not.toThrow();
  });

  // --- Evaluate capability gate (Issue #176) ---

  it('should reject evaluate without browser:evaluate capability', async () => {
    const caps = [{ type: 'browser' as const }, { type: 'net' as const }];
    const ctx = createContext({
      effectiveCaps: caps,
      gateway: new CapabilityGateway(caps, 'test', 'browser'),
    });
    const output = await browserCommand.execute(
      { actions: [{ action: 'evaluate', expression: 'document.title' }] },
      ctx,
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('browser:evaluate');
  });

  itWithoutPlaywright('should allow evaluate with browser:evaluate capability', async () => {
    const ctx = createContext({
      effectiveCaps: [{ type: 'browser' }, { type: 'net' }, { type: 'browser:evaluate' }],
    });
    const output = await browserCommand.execute(
      { actions: [{ action: 'evaluate', expression: 'document.title' }] },
      ctx,
    );
    expect(output.success).toBe(false);
    // Should fail due to Playwright not being installed, NOT capability check
    expect(output.error).toContain('Playwright');
    expect(output.error).not.toContain('capability');
  });
});
