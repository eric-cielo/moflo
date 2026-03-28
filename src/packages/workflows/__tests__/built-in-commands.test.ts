/**
 * Built-in Step Commands Tests
 *
 * Story #102: Tests for all 8 built-in step commands.
 */

import { describe, it, expect } from 'vitest';
import { agentCommand } from '../src/commands/agent-command.js';
import { bashCommand } from '../src/commands/bash-command.js';
import { conditionCommand } from '../src/commands/condition-command.js';
import { promptCommand } from '../src/commands/prompt-command.js';
import { memoryCommand } from '../src/commands/memory-command.js';
import { waitCommand } from '../src/commands/wait-command.js';
import { loopCommand } from '../src/commands/loop-command.js';
import { browserCommand } from '../src/commands/browser-command.js';
import { builtinCommands } from '../src/commands/index.js';
import type { MemoryAccessor } from '../src/types/step-command.types.js';
import { createMockContext as createContext } from './helpers.js';

// ============================================================================
// Registry
// ============================================================================

describe('builtinCommands', () => {
  it('should have all 8 commands', () => {
    expect(builtinCommands).toHaveLength(8);
    const types = builtinCommands.map(c => c.type);
    expect(types).toEqual(['agent', 'bash', 'condition', 'prompt', 'memory', 'wait', 'loop', 'browser']);
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
    expect(output.data.stdout).toBe('world');
  });
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
    const output = await waitCommand.execute({ duration: 10 }, createContext());
    expect(output.success).toBe(true);
    expect(output.data.waited).toBe(10);
    expect(output.duration).toBeGreaterThanOrEqual(10);
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
// Browser Command (Stub)
// ============================================================================

describe('browserCommand', () => {
  it('should validate with valid config', () => {
    const result = browserCommand.validate({ action: 'navigate' }, createContext());
    expect(result.valid).toBe(true);
  });

  it('should fail execution with Playwright required error', async () => {
    const output = await browserCommand.execute(
      { action: 'navigate', url: 'https://example.com' },
      createContext(),
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('Playwright');
  });
});
