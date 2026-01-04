/**
 * V3 CLI Main Tests
 * Comprehensive tests for CLI parsing, help output, version, and error handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CLI, VERSION } from '../src/index.js';
import type { Command } from '../src/types.js';

describe('CLI', () => {
  let cli: CLI;
  let consoleOutput: string[];
  let consoleErrorOutput: string[];
  let processExitMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Capture console output
    consoleOutput = [];
    consoleErrorOutput = [];

    vi.spyOn(process.stdout, 'write').mockImplementation((str: string | Uint8Array) => {
      consoleOutput.push(String(str));
      return true;
    });

    vi.spyOn(process.stderr, 'write').mockImplementation((str: string | Uint8Array) => {
      consoleErrorOutput.push(String(str));
      return true;
    });

    // Mock process.exit to prevent actual exits
    processExitMock = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit: ${code}`);
    }) as unknown as ReturnType<typeof vi.spyOn>;

    // Create CLI instance (non-interactive for testing)
    cli = new CLI({ interactive: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Version Command', () => {
    it('should show version with --version flag', async () => {
      await cli.run(['--version']);

      const output = consoleOutput.join('');
      expect(output).toContain('claude-flow');
      expect(output).toContain(VERSION);
    });

    it('should show version with -V flag', async () => {
      await cli.run(['-V']);

      const output = consoleOutput.join('');
      expect(output).toContain('claude-flow');
      expect(output).toContain(VERSION);
    });

    it('should show version with correct format', async () => {
      await cli.run(['--version']);

      const output = consoleOutput.join('');
      expect(output).toMatch(/claude-flow v\d+\.\d+\.\d+/);
    });
  });

  describe('Help Command', () => {
    it('should show help when no command provided', async () => {
      await cli.run([]);

      const output = consoleOutput.join('');
      expect(output).toContain('USAGE:');
      expect(output).toContain('COMMANDS:');
      expect(output).toContain('GLOBAL OPTIONS:');
    });

    it('should show help with --help flag', async () => {
      await cli.run(['--help']);

      const output = consoleOutput.join('');
      expect(output).toContain('USAGE:');
      expect(output).toContain('COMMANDS:');
    });

    it('should show help with -h flag', async () => {
      await cli.run(['-h']);

      const output = consoleOutput.join('');
      expect(output).toContain('USAGE:');
      expect(output).toContain('COMMANDS:');
    });

    it('should show command-specific help', async () => {
      await cli.run(['agent', '--help']);

      const output = consoleOutput.join('');
      expect(output).toContain('agent');
      expect(output).toContain('Agent management');
    });

    it('should list all available commands', async () => {
      await cli.run(['--help']);

      const output = consoleOutput.join('');
      expect(output).toContain('agent');
      expect(output).toContain('swarm');
      expect(output).toContain('memory');
      expect(output).toContain('config');
    });

    it('should show V3 features in help', async () => {
      await cli.run(['--help']);

      const output = consoleOutput.join('');
      expect(output).toContain('V3 FEATURES:');
      expect(output).toContain('15-agent');
      expect(output).toContain('AgentDB');
      expect(output).toContain('Flash Attention');
    });

    it('should show examples in help', async () => {
      await cli.run(['--help']);

      const output = consoleOutput.join('');
      expect(output).toContain('EXAMPLES:');
    });
  });

  describe('Invalid Commands', () => {
    it('should show error for unknown command', async () => {
      try {
        await cli.run(['invalid-command']);
      } catch (e) {
        expect((e as Error).message).toContain('process.exit');
      }

      const output = consoleOutput.join('');
      expect(output).toContain('Unknown command: invalid-command');
    });

    it('should suggest help for unknown command', async () => {
      try {
        await cli.run(['nonexistent']);
      } catch (e) {
        expect((e as Error).message).toContain('process.exit');
      }

      const output = consoleOutput.join('');
      expect(output).toContain('Run "claude-flow --help" for available commands');
    });

    it('should handle misspelled commands', async () => {
      try {
        await cli.run(['agnet']);
      } catch (e) {
        expect((e as Error).message).toContain('process.exit');
      }

      const output = consoleOutput.join('');
      expect(output).toContain('Unknown command: agnet');
    });
  });

  describe('Argument Parsing', () => {
    it('should parse long flags', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testparse',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.verbose).toBe(true);
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testparse', '--verbose']);
      expect(flagsPassed).toBe(true);
    });

    it('should parse short flags', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testshort',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.v).toBe(true);
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testshort', '-v']);
      expect(flagsPassed).toBe(true);
    });

    it('should parse flags with values', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testvalue',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.format).toBe('json');
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testvalue', '--format', 'json']);
      expect(flagsPassed).toBe(true);
    });

    it('should parse flags with equals syntax', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testequals',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.output).toBe('file.txt');
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testequals', '--output=file.txt']);
      expect(flagsPassed).toBe(true);
    });

    it('should parse multiple flags', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testmulti',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.verbose).toBe(true);
          expect(ctx.flags.format).toBe('json');
          expect(ctx.flags.quiet).toBe(true);
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testmulti', '--verbose', '--format', 'json', '-q']);
      expect(flagsPassed).toBe(true);
    });

    it('should parse positional arguments', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testpos',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.args).toEqual(['arg1', 'arg2', 'arg3']);
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testpos', 'arg1', 'arg2', 'arg3']);
      expect(flagsPassed).toBe(true);
    });

    it('should handle boolean flags correctly', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testbool',
        description: 'Test command',
        options: [
          { name: 'force', type: 'boolean', description: 'Force operation' }
        ],
        action: async (ctx) => {
          expect(ctx.flags.force).toBe(true);
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testbool', '--force']);
      expect(flagsPassed).toBe(true);
    });

    it('should handle negated boolean flags', async () => {
      let flagsPassed = false;
      const mockCommand: Command = {
        name: 'testnegate',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.color).toBe(false);
          flagsPassed = true;
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['testnegate', '--no-color']);
      expect(flagsPassed).toBe(true);
    });
  });

  describe('Global Flags', () => {
    it('should handle --quiet flag', async () => {
      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.quiet).toBe(true);
          expect(ctx.interactive).toBe(false);
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['test', '--quiet']);
    });

    it('should handle --format flag', async () => {
      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.format).toBe('json');
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['test', '--format', 'json']);
    });

    it('should handle --config flag', async () => {
      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        action: async (ctx) => {
          expect(ctx.flags.config).toBe('./custom-config.json');
          return { success: true };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await cli.run(['test', '--config', './custom-config.json']);
    });

    it('should disable color with --no-color', async () => {
      await cli.run(['--no-color', '--help']);
      // Color should be disabled - check output formatter state
      expect(cli['output']['colorEnabled']).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle command execution errors', async () => {
      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        action: async () => {
          throw new Error('Command failed');
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await expect(cli.run(['test'])).rejects.toThrow('process.exit: 1');

      const output = consoleOutput.join('');
      expect(output).toContain('Command failed');
    });

    it('should handle missing required options', async () => {
      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        options: [
          { name: 'required-opt', type: 'string', required: true, description: 'Required option' }
        ],
        action: async () => ({ success: true })
      };

      cli['parser'].registerCommand(mockCommand);
      await expect(cli.run(['test'])).rejects.toThrow('process.exit: 1');

      const output = consoleOutput.join('');
      expect(output).toContain('Required option missing');
    });

    it('should show debug info when DEBUG env var is set', async () => {
      process.env.DEBUG = '1';

      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        action: async () => {
          const error = new Error('Test error');
          error.stack = 'Error: Test error\n  at test:1:1';
          throw error;
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await expect(cli.run(['test'])).rejects.toThrow('process.exit: 1');

      const output = consoleOutput.join('');
      expect(output).toContain('Test error');

      delete process.env.DEBUG;
    });
  });

  describe('Subcommands', () => {
    it('should execute subcommand', async () => {
      let subcommandExecuted = false;

      const subcommand: Command = {
        name: 'sub',
        description: 'Subcommand',
        action: async () => {
          subcommandExecuted = true;
          return { success: true };
        }
      };

      const mainCommand: Command = {
        name: 'main',
        description: 'Main command',
        subcommands: [subcommand]
      };

      cli['parser'].registerCommand(mainCommand);
      await cli.run(['main', 'sub']);

      expect(subcommandExecuted).toBe(true);
    });

    it('should handle subcommand aliases', async () => {
      let executed = false;

      const subcommand: Command = {
        name: 'list',
        aliases: ['ls'],
        description: 'List items',
        action: async () => {
          executed = true;
          return { success: true };
        }
      };

      const mainCommand: Command = {
        name: 'main',
        description: 'Main command',
        subcommands: [subcommand]
      };

      cli['parser'].registerCommand(mainCommand);
      await cli.run(['main', 'ls']);

      expect(executed).toBe(true);
    });
  });

  describe('Exit Codes', () => {
    it('should exit with code 0 on success', async () => {
      await cli.run(['--version']);
      // No error thrown = exit code 0
    });

    it('should exit with code 1 on unknown command', async () => {
      await expect(cli.run(['unknown'])).rejects.toThrow('process.exit: 1');
    });

    it('should exit with custom code from command result', async () => {
      const mockCommand: Command = {
        name: 'test',
        description: 'Test command',
        action: async () => {
          return { success: false, exitCode: 42 };
        }
      };

      cli['parser'].registerCommand(mockCommand);
      await expect(cli.run(['test'])).rejects.toThrow('process.exit: 42');
    });
  });
});
