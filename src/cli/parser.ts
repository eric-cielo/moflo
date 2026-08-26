/**
 * V3 CLI Command Parser
 * Advanced argument parsing with validation and type coercion
 */

import type { Command, CommandOption, ParsedFlags, CommandContext } from './types.js';

export interface ParseResult {
  command: string[];
  flags: ParsedFlags;
  positional: string[];
  raw: string[];
}

export interface ParserOptions {
  stopAtFirstNonFlag?: boolean;
  allowUnknownFlags?: boolean;
  booleanFlags?: string[];
  stringFlags?: string[];
  arrayFlags?: string[];
  aliases?: Record<string, string>;
  defaults?: Record<string, unknown>;
}

export class CommandParser {
  private options: ParserOptions;
  private commands: Map<string, Command> = new Map();
  private globalOptions: CommandOption[] = [];

  constructor(options: ParserOptions = {}) {
    this.options = {
      stopAtFirstNonFlag: false,
      allowUnknownFlags: false,
      ...options
    };

    this.initializeGlobalOptions();
  }

  private initializeGlobalOptions(): void {
    this.globalOptions = [
      {
        name: 'help',
        short: 'h',
        description: 'Show help information',
        type: 'boolean',
        default: false
      },
      {
        name: 'version',
        short: 'V',
        description: 'Show version number',
        type: 'boolean',
        default: false
      },
      {
        name: 'verbose',
        short: 'v',
        description: 'Enable verbose output',
        type: 'boolean',
        default: false
      },
      {
        name: 'quiet',
        short: 'Q',
        description: 'Suppress non-essential output',
        type: 'boolean',
        default: false
      },
      {
        name: 'config',
        short: 'c',
        description: 'Path to configuration file',
        type: 'string'
      },
      {
        name: 'format',
        short: 'f',
        description: 'Output format (text, json, table)',
        type: 'string',
        default: 'text',
        choices: ['text', 'json', 'table']
      },
      {
        // Declared POSITIVELY. The long-flag branch below turns `--no-<x>` into
        // `<x> = false`, so an option named `no-color` can never produce a
        // `noColor` key and every reader of one is dead (#1474). `--no-color`
        // still works — that spelling IS the negation this parser performs.
        name: 'color',
        description: 'Colored output (--no-color to disable)',
        type: 'boolean',
        default: true
      },
      {
        name: 'interactive',
        short: 'i',
        description: 'Enable interactive mode',
        type: 'boolean',
        default: true
      }
    ];
  }

  registerCommand(command: Command): void {
    this.commands.set(command.name, command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.commands.set(alias, command);
      }
    }
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  getAllCommands(): Command[] {
    // Return unique commands (filter out aliases)
    const seen = new Set<Command>();
    return Array.from(this.commands.values()).filter(cmd => {
      if (seen.has(cmd)) return false;
      seen.add(cmd);
      return true;
    });
  }

  parse(args: string[]): ParseResult {
    const result: ParseResult = {
      command: [],
      flags: { _: [] },
      positional: [],
      raw: [...args]
    };

    // Pass 1: Walk positional args to resolve the command chain to its deepest
    // matching node. The scoped-alias map needs to know the leaf command —
    // otherwise short flags from arbitrarily deep subcommands collide with
    // identically-named flags on shallower commands (e.g. spell→schedule→create
    // -n vs guidance -n).
    const chain: Command[] = [];
    for (const arg of args) {
      if (arg.startsWith('-')) continue;
      const next = chain.length === 0
        ? this.commands.get(arg)
        : this.findSubcommand(chain[chain.length - 1], arg);
      if (!next) break;
      chain.push(next);
    }

    const deepestCmd = chain[chain.length - 1];
    const aliases = this.buildScopedAliases(deepestCmd);
    const booleanFlags = this.getScopedBooleanFlags(deepestCmd);
    const valueFlags = this.getScopedValueFlags(deepestCmd);

    let i = 0;
    let parsingFlags = true;

    while (i < args.length) {
      const arg = args[i];

      // Check for end of flags marker
      if (arg === '--') {
        parsingFlags = false;
        i++;
        continue;
      }

      // Handle flags
      if (parsingFlags && arg.startsWith('-')) {
        const parseResult = this.parseFlag(args, i, aliases, booleanFlags, valueFlags);

        // Apply to result flags
        Object.assign(result.flags, parseResult.flags);
        i = parseResult.nextIndex;
        continue;
      }

      // Handle positional arguments.
      //
      // A command token is only recognized in the LEADING position — as the
      // first positional-eligible arg. The `positional.length === 0` guard is
      // load-bearing: without it, an unrecognized leading token (a lazy command
      // not yet registered in `this.commands`, e.g. `sdd` or `epic`) drops to
      // positional, and a LATER token that happens to match an eager command
      // (e.g. `status`) gets wrongly promoted to the command slot — so
      // `flo sdd status` ran the top-level `status` command. In this grammar the
      // command is always the first positional; enforce that here. Lazy commands
      // whose name the parser didn't know are then recovered by the
      // empty-commandPath fallback in index.ts (`run()`), which re-dispatches
      // positional[0] through the async command registry.
      if (result.command.length === 0 && result.positional.length === 0 && this.commands.has(arg)) {
        // This is a command — walk its subcommand chain greedily.
        result.command.push(arg);
        let current: Command | undefined = this.commands.get(arg);
        while (current && i + 1 < args.length) {
          const nextArg = args[i + 1];
          const sub = this.findSubcommand(current, nextArg);
          if (!sub) break;
          result.command.push(nextArg);
          i++;
          current = sub;
        }
      } else {
        // Positional argument
        result.positional.push(arg);
        result.flags._.push(arg);
      }

      i++;
    }

    // Apply defaults. The resolved leaf command is passed so its own option
    // defaults win over an identically-named global — see applyDefaults.
    this.applyDefaults(result.flags, deepestCmd);

    return result;
  }

  private findSubcommand(parent: Command | undefined, name: string): Command | undefined {
    return parent?.subcommands?.find(sc => sc.name === name || sc.aliases?.includes(name));
  }

  private parseFlag(
    args: string[],
    index: number,
    aliases: Record<string, string>,
    booleanFlags: Set<string>,
    valueFlags: Set<string> = new Set()
  ): { flags: ParsedFlags; nextIndex: number } {
    const flags: ParsedFlags = { _: [] };
    const arg = args[index];
    let nextIndex = index + 1;

    /**
     * A flag that ran out of value. A DECLARED value-taking option becomes ''
     * rather than `true`: `true` is how `--version` (redefined as a string by
     * plugins/deployment) slipped back into the global boolean handler and
     * printed the moflo version instead of running the command. '' stays falsy
     * and trips the required-option check. Undeclared flags keep the legacy
     * `true` so `--some-adhoc-flag` behaves as before.
     */
    const missingValue = (key: string): string | boolean => (valueFlags.has(key) ? '' : true);

    if (arg.startsWith('--')) {
      // Long flag
      const equalIndex = arg.indexOf('=');

      if (equalIndex !== -1) {
        // --flag=value
        const key = arg.slice(2, equalIndex);
        const value = arg.slice(equalIndex + 1);
        flags[this.normalizeKey(key)] = this.parseValue(value);
      } else if (arg.startsWith('--no-')) {
        // --no-flag (boolean negation)
        const key = arg.slice(5);
        flags[this.normalizeKey(key)] = false;
      } else {
        const key = arg.slice(2);
        const normalizedKey = this.normalizeKey(key);

        if (booleanFlags.has(normalizedKey)) {
          flags[normalizedKey] = true;
        } else if (nextIndex < args.length && !args[nextIndex].startsWith('-')) {
          flags[normalizedKey] = this.parseValue(args[nextIndex]);
          nextIndex++;
        } else {
          flags[normalizedKey] = missingValue(normalizedKey);
        }
      }
    } else if (arg.startsWith('-')) {
      // Short flag(s)
      const chars = arg.slice(1);

      if (chars.length === 1) {
        // Single short flag
        const key = aliases[chars] || chars;
        const normalizedKey = this.normalizeKey(key);

        if (booleanFlags.has(normalizedKey)) {
          flags[normalizedKey] = true;
        } else if (nextIndex < args.length && !args[nextIndex].startsWith('-')) {
          flags[normalizedKey] = this.parseValue(args[nextIndex]);
          nextIndex++;
        } else {
          flags[normalizedKey] = missingValue(normalizedKey);
        }
      } else {
        // Multiple short flags combined (e.g., -abc)
        for (const char of chars) {
          const key = aliases[char] || char;
          flags[this.normalizeKey(key)] = true;
        }
      }
    }

    return { flags, nextIndex };
  }

  private parseValue(value: string): string | number | boolean {
    // Boolean
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;

    // Number
    const num = Number(value);
    if (!isNaN(num) && value.trim() !== '') return num;

    // String
    return value;
  }

  private normalizeKey(key: string): string {
    // Convert kebab-case to camelCase
    return key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  private buildAliases(): Record<string, string> {
    const aliases: Record<string, string> = {};

    for (const opt of this.globalOptions) {
      if (opt.short) {
        aliases[opt.short] = opt.name;
      }
    }

    // Add aliases from all commands and subcommands
    for (const cmd of this.commands.values()) {
      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.short) {
            aliases[opt.short] = opt.name;
          }
        }
      }
      // Also include subcommands' options
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          if (sub.options) {
            for (const opt of sub.options) {
              if (opt.short) {
                aliases[opt.short] = opt.name;
              }
            }
          }
        }
      }
    }

    return { ...aliases, ...this.options.aliases };
  }

  /**
   * Build aliases scoped to a specific command/subcommand.
   * The resolved command's short flags take priority over global ones,
   * fixing collisions where multiple subcommands use the same short flag (e.g. -t).
   */
  private buildScopedAliases(resolvedCmd?: Command): Record<string, string> {
    // Start with global aliases as base
    const aliases = this.buildAliases();

    // Override with the resolved command's own options (these take priority)
    if (resolvedCmd?.options) {
      for (const opt of resolvedCmd.options) {
        if (opt.short) {
          aliases[opt.short] = opt.name;
        }
      }
    }

    return aliases;
  }

  /**
   * Names declared as value-taking (non-boolean) by the resolved command or a
   * global, command winning. The mirror of `getScopedBooleanFlags`: that set
   * says "takes no value", this one says "REQUIRES one".
   */
  private getScopedValueFlags(resolvedCmd?: Command): Set<string> {
    const flags = new Set<string>();
    for (const opt of [...this.globalOptions, ...(resolvedCmd?.options ?? [])]) {
      const key = this.normalizeKey(opt.name);
      if (opt.type && opt.type !== 'boolean') flags.add(key);
      else flags.delete(key);
    }
    return flags;
  }

  /**
   * Get boolean flags scoped to a specific command/subcommand.
   */
  private getScopedBooleanFlags(resolvedCmd?: Command): Set<string> {
    const flags = this.getBooleanFlags();

    if (resolvedCmd?.options) {
      for (const opt of resolvedCmd.options) {
        const key = this.normalizeKey(opt.name);
        if (opt.type === 'boolean') {
          flags.add(key);
        } else {
          // A command that redefines a global BOOLEAN as a value-taking option
          // must also un-register it as boolean — otherwise the parser eats the
          // flag and drops its value into positionals. `plugins install pkg
          // --version 1.2.3` parsed as `version: true` + a stray '1.2.3'
          // positional, which then tripped the global `--version` handler: it
          // printed "flo v4.12.4-rc.1" and exited without installing anything.
          // Same for `plugins upgrade` and `deployment deploy|rollback`.
          // Mirrors buildScopedAliases, where the command already wins.
          flags.delete(key);
        }
      }
    }

    return flags;
  }

  private getBooleanFlags(): Set<string> {
    const flags = new Set<string>();

    for (const opt of this.globalOptions) {
      if (opt.type === 'boolean') {
        flags.add(this.normalizeKey(opt.name));
      }
    }

    // Add boolean flags from all commands and subcommands
    for (const cmd of this.commands.values()) {
      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.type === 'boolean') {
            flags.add(this.normalizeKey(opt.name));
          }
        }
      }
      // Also include subcommands' boolean flags
      if (cmd.subcommands) {
        for (const sub of cmd.subcommands) {
          if (sub.options) {
            for (const opt of sub.options) {
              if (opt.type === 'boolean') {
                flags.add(this.normalizeKey(opt.name));
              }
            }
          }
        }
      }
    }

    if (this.options.booleanFlags) {
      for (const flag of this.options.booleanFlags) {
        flags.add(this.normalizeKey(flag));
      }
    }

    return flags;
  }

  private applyDefaults(flags: ParsedFlags, command?: Command): void {
    // Only options that SHADOW a global participate here. This is deliberately
    // not a general "apply every command default" pass: 455 command options
    // declare defaults the parser has never applied, and 28 of those give a
    // boolean the truthy STRING 'false' — switching them all on would flip
    // flags like --force and --full to ON by default across the whole CLI.
    // The bug being fixed is narrower: a global's default was injected over a
    // command's own declaration. `flo config export` declares `--format`
    // defaulting to 'json'; the global's 'text' landed instead and then failed
    // the command's own `choices`, so the command errored with no flag at all.
    const shadowed = new Set<string>();
    for (const opt of command?.options ?? []) {
      const key = this.normalizeKey(opt.name);
      if (!this.globalOptions.some(g => this.normalizeKey(g.name) === key)) continue;
      shadowed.add(key);
      if (flags[key] === undefined && opt.default !== undefined) {
        flags[key] = opt.default as string | boolean | number | string[];
      }
    }

    // Apply global option defaults, except where the command shadows them —
    // there the command's declaration (or absence of one) is authoritative.
    for (const opt of this.globalOptions) {
      const key = this.normalizeKey(opt.name);
      if (shadowed.has(key)) continue;
      if (flags[key] === undefined && opt.default !== undefined) {
        flags[key] = opt.default as string | boolean | number | string[];
      }
    }

    // Apply custom defaults
    if (this.options.defaults) {
      for (const [key, value] of Object.entries(this.options.defaults)) {
        const normalizedKey = this.normalizeKey(key);
        if (flags[normalizedKey] === undefined) {
          flags[normalizedKey] = value as string | boolean | number | string[];
        }
      }
    }
  }

  validateFlags(flags: ParsedFlags, command?: Command): string[] {
    const errors: string[] = [];

    // A command option SHADOWS a global of the same name instead of stacking
    // with it. Stacking made every collision unsatisfiable: `--format yaml` on
    // `flo config export` had to pass BOTH the command's ['json','yaml'] and
    // the global's ['text','json','table'], so the flag was rejected no matter
    // what the user typed. Same for `flo memory export --format csv`. 22 such
    // collisions exist across 18 command files (format, verbose, quiet,
    // version, config, help) — the specific declaration is the intended one.
    const byName = new Map<string, CommandOption>();
    for (const opt of [...this.globalOptions, ...(command?.options ?? [])]) {
      byName.set(this.normalizeKey(opt.name), opt);
    }
    const allOptions = [...byName.values()];

    // Check required flags
    for (const opt of allOptions) {
      const key = this.normalizeKey(opt.name);

      if (opt.required && (flags[key] === undefined || flags[key] === '')) {
        errors.push(`Required option missing: --${opt.name}`);
      }

      // Check choices
      if (opt.choices && flags[key] !== undefined) {
        const value = String(flags[key]);
        if (!opt.choices.includes(value)) {
          errors.push(`Invalid value for --${opt.name}: ${value}. Must be one of: ${opt.choices.join(', ')}`);
        }
      }

      // Run custom validator
      if (opt.validate && flags[key] !== undefined) {
        const result = opt.validate(flags[key]);
        if (result !== true) {
          errors.push(typeof result === 'string' ? result : `Invalid value for --${opt.name}`);
        }
      }
    }

    // Check for unknown flags if not allowed
    if (!this.options.allowUnknownFlags) {
      const knownFlags = new Set(allOptions.map(opt => this.normalizeKey(opt.name)));
      knownFlags.add('_'); // Positional args

      for (const key of Object.keys(flags)) {
        if (!knownFlags.has(key) && key !== '_') {
          errors.push(`Unknown option: --${key}`);
        }
      }
    }

    return errors;
  }

  getGlobalOptions(): CommandOption[] {
    return [...this.globalOptions];
  }
}

// Export singleton parser instance
export const commandParser = new CommandParser({ allowUnknownFlags: true });
