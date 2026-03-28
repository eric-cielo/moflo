/**
 * Step Command Registry Tests
 *
 * Story #101: Workflow Step Command Interface
 * Tests: register/retrieve, duplicate prevention, list, get unknown, context flow
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  ValidationResult,
  OutputDescriptor,
  WorkflowContext,
  CredentialAccessor,
} from '../src/types/step-command.types.js';
import { createMockContext } from './helpers.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockCommand(type: string, outputs?: OutputDescriptor[]): StepCommand {
  return {
    type,
    description: `Mock ${type} command`,
    configSchema: { type: 'object', properties: {} },
    validate(_config: StepConfig, _context: WorkflowContext): ValidationResult {
      return { valid: true, errors: [] };
    },
    async execute(_config: StepConfig, _context: WorkflowContext): Promise<StepOutput> {
      return { success: true, data: { result: `${type} executed` } };
    },
    describeOutputs(): OutputDescriptor[] {
      return outputs ?? [{ name: 'result', type: 'string' }];
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('StepCommandRegistry', () => {
  let registry: StepCommandRegistry;

  beforeEach(() => {
    registry = new StepCommandRegistry();
  });

  describe('register', () => {
    it('should register a command and retrieve it by type', () => {
      const command = createMockCommand('shell');
      registry.register(command);

      expect(registry.get('shell')).toBe(command);
      expect(registry.has('shell')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('should reject duplicate type registration', () => {
      const command1 = createMockCommand('shell');
      const command2 = createMockCommand('shell');

      registry.register(command1);

      expect(() => registry.register(command2)).toThrow(
        'Step command type "shell" is already registered'
      );
    });

    it('should reject commands with empty type', () => {
      const command = createMockCommand('');

      expect(() => registry.register(command)).toThrow(
        'StepCommand must have a non-empty string type'
      );
    });

    it('should register multiple different commands', () => {
      registry.register(createMockCommand('shell'));
      registry.register(createMockCommand('memory-read'));
      registry.register(createMockCommand('http'));

      expect(registry.size).toBe(3);
      expect(registry.has('shell')).toBe(true);
      expect(registry.has('memory-read')).toBe(true);
      expect(registry.has('http')).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for unknown type', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('should return the registered command', () => {
      const command = createMockCommand('shell');
      registry.register(command);

      const retrieved = registry.get('shell');
      expect(retrieved).toBe(command);
      expect(retrieved?.type).toBe('shell');
    });
  });

  describe('has', () => {
    it('should return false for unregistered type', () => {
      expect(registry.has('unknown')).toBe(false);
    });

    it('should return true for registered type', () => {
      registry.register(createMockCommand('shell'));
      expect(registry.has('shell')).toBe(true);
    });
  });

  describe('list', () => {
    it('should return empty array when no commands registered', () => {
      expect(registry.list()).toEqual([]);
    });

    it('should return all registered commands', () => {
      registry.register(createMockCommand('shell'));
      registry.register(createMockCommand('memory-read'));

      const entries = registry.list();
      expect(entries).toHaveLength(2);
      expect(entries[0].command.type).toBe('shell');
      expect(entries[1].command.type).toBe('memory-read');
      expect(entries[0].registeredAt).toBeInstanceOf(Date);
    });
  });

  describe('types', () => {
    it('should return all registered type names', () => {
      registry.register(createMockCommand('shell'));
      registry.register(createMockCommand('http'));

      expect(registry.types()).toEqual(['shell', 'http']);
    });
  });

  describe('unregister', () => {
    it('should remove a registered command', () => {
      registry.register(createMockCommand('shell'));
      expect(registry.has('shell')).toBe(true);

      const removed = registry.unregister('shell');
      expect(removed).toBe(true);
      expect(registry.has('shell')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('should return false for unknown type', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all registered commands', () => {
      registry.register(createMockCommand('shell'));
      registry.register(createMockCommand('http'));
      expect(registry.size).toBe(2);

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.list()).toEqual([]);
    });
  });

  describe('StepCommand interface', () => {
    it('should validate config synchronously', () => {
      const command = createMockCommand('shell');
      const context = createMockContext();

      const result = command.validate({ cmd: 'echo hello' }, context);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('should support async validation', async () => {
      const command: StepCommand = {
        ...createMockCommand('credential-check'),
        async validate(_config: StepConfig, context: WorkflowContext) {
          const exists = await context.credentials.has('API_KEY');
          return exists
            ? { valid: true, errors: [] }
            : { valid: false, errors: [{ path: 'credentials', message: 'API_KEY not found' }] };
        },
      };
      const context = createMockContext();

      const result = await command.validate({}, context);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toBe('API_KEY not found');
    });

    it('should execute command and return output', async () => {
      const command = createMockCommand('shell');
      const context = createMockContext();

      const output = await command.execute({ cmd: 'echo hello' }, context);
      expect(output.success).toBe(true);
      expect(output.data.result).toBe('shell executed');
    });

    it('should describe outputs', () => {
      const outputs: OutputDescriptor[] = [
        { name: 'stdout', type: 'string', description: 'Standard output' },
        { name: 'exitCode', type: 'number', required: true },
      ];
      const command = createMockCommand('shell', outputs);

      expect(command.describeOutputs()).toEqual(outputs);
    });

    it('should support optional rollback', async () => {
      let rolledBack = false;
      const command: StepCommand = {
        ...createMockCommand('shell'),
        async rollback() {
          rolledBack = true;
        },
      };

      const context = createMockContext();
      await command.rollback!({}, context);
      expect(rolledBack).toBe(true);
    });
  });

  describe('WorkflowContext', () => {
    it('should carry variables from prior steps', () => {
      const context = createMockContext({
        variables: {
          'step1.output': 'hello',
          'step2.count': 42,
        },
      });

      expect(context.variables['step1.output']).toBe('hello');
      expect(context.variables['step2.count']).toBe(42);
    });

    it('should carry workflow args', () => {
      const context = createMockContext({
        args: { issueNumber: '123', dryRun: true },
      });

      expect(context.args.issueNumber).toBe('123');
      expect(context.args.dryRun).toBe(true);
    });

    it('should provide credential access', async () => {
      const credentials: CredentialAccessor = {
        async get(name: string) {
          return name === 'API_KEY' ? 'secret-123' : undefined;
        },
        async has(name: string) {
          return name === 'API_KEY';
        },
      };

      const context = createMockContext({ credentials });
      expect(await context.credentials.has('API_KEY')).toBe(true);
      expect(await context.credentials.get('API_KEY')).toBe('secret-123');
      expect(await context.credentials.get('MISSING')).toBeUndefined();
    });

    it('should provide memory access', async () => {
      const store = new Map<string, unknown>();
      const memory: MemoryAccessor = {
        async read(_ns: string, key: string) {
          return store.get(key) ?? null;
        },
        async write(_ns: string, key: string, value: unknown) {
          store.set(key, value);
        },
        async search() {
          return [];
        },
      };

      const context = createMockContext({ memory });
      await context.memory.write('tasklist', 'key1', { data: 'value' });
      const result = await context.memory.read('tasklist', 'key1');
      expect(result).toEqual({ data: 'value' });
    });
  });
});
