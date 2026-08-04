/**
 * V3 CLI Config Command
 * Configuration management
 *
 * Every subcommand here reads and writes a real file — see
 * `../config/cli-config-store.ts` for the store and for why that is worth
 * stating: this family used to print "Creating ..." and "Configuration
 * updated" without touching the filesystem, which made `flo doctor --fix`
 * report the `Config File` warning as fixed forever.
 *
 * `show` and `generate` are the odd pair out: they operate on **moflo.yaml**
 * via `../config/moflo-config.ts`, not on the JSON config.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm } from '../prompt.js';
import { resolveStateRoot } from '../services/project-root.js';
import {
  CliConfigParseError,
  RESETTABLE_SECTIONS,
  cliConfigPath,
  defaultCliConfig,
  findCliConfigFile,
  flattenConfig,
  getConfigValue,
  loadCliConfig,
  resetSection,
  saveCliConfig,
  setConfigValue,
  writeJsonFile,
  writeTextFile,
  type CliConfig,
  type CliConfigProvider,
  type ResettableSection,
} from '../config/cli-config-store.js';

/**
 * Anchor config reads/writes at the state root — `resolveStateRoot`, not
 * `findProjectRoot`, because this command CREATES `.moflo/` content and must
 * land on the monorepo's canonical anchor rather than minting an island in a
 * sub-workspace (#1315).
 */
function configRoot(ctx: CommandContext): string {
  return resolveStateRoot({ cwd: ctx.cwd || process.cwd() });
}

/**
 * Path relative to the project root, for display. Builds the `./` prefix from
 * `path.sep` so Windows shows `.\.moflo\config.json` rather than a mixed
 * `./.moflo\config.json`.
 */
function displayPath(root: string, target: string): string {
  const rel = relative(root, target);
  return rel && !rel.startsWith('..') ? `.${sep}${rel}` : target;
}

/**
 * Load config, printing the parse error and returning `null` when the file on
 * disk is corrupt. Callers exit 1 on `null` rather than silently falling back
 * to defaults — a config that cannot be read is a failure, not a default.
 */
function loadOrReport(root: string): { config: CliConfig; path: string | null } | null {
  try {
    return loadCliConfig(root);
  } catch (err) {
    if (err instanceof CliConfigParseError) {
      output.printError(err.message);
      output.writeln(output.dim('  Fix the JSON syntax, or run `flo config init --force` to rewrite it.'));
      return null;
    }
    throw err;
  }
}

// Init configuration
const initCommand: Command = {
  name: 'init',
  description: 'Initialize configuration',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing configuration',
      type: 'boolean',
      default: false
    },
    {
      name: 'sparc',
      description: 'Initialize with SPARC methodology',
      type: 'boolean',
      default: false
    },
    {
      name: 'v3',
      description: 'Initialize V3 configuration',
      type: 'boolean',
      default: true
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sparc = ctx.flags.sparc as boolean;
    const v3 = ctx.flags.v3 as boolean;
    const force = ctx.flags.force as boolean;
    const root = configRoot(ctx);

    const existing = findCliConfigFile(root);
    if (existing && !force) {
      output.printError(`Configuration already exists: ${displayPath(root, existing)}`);
      output.writeln(output.dim('  Re-run with --force to overwrite it.'));
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.printInfo('Initializing MoFlo configuration...');
    output.writeln();

    const config = defaultCliConfig({ v3, sparc });
    const target = existing ?? cliConfigPath(root);
    try {
      saveCliConfig(root, config, { path: target });
    } catch (err) {
      output.printError(`Failed to write ${displayPath(root, target)}: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }

    output.writeln(output.dim(`  Wrote ${displayPath(root, target)}`));

    output.writeln();
    output.printTable({
      columns: [
        { key: 'setting', header: 'Setting', width: 25 },
        { key: 'value', header: 'Value', width: 30 }
      ],
      data: [
        { setting: 'Version', value: config.version },
        { setting: 'V3 Mode', value: config.v3Mode ? 'Enabled' : 'Disabled' },
        { setting: 'SPARC Mode', value: config.sparc ? 'Enabled' : 'Disabled' },
        { setting: 'Swarm Topology', value: config.swarm.topology },
        { setting: 'Max Agents', value: config.swarm.maxAgents },
        { setting: 'Memory Backend', value: config.memory.backend },
        { setting: 'MCP Transport', value: config.mcp.transport }
      ]
    });

    output.writeln();
    output.printSuccess('Configuration initialized');
    output.writeln(output.dim(`  Config file: ${displayPath(root, target)}`));

    return { success: true, data: config };
  }
};

// Get configuration
const getCommand: Command = {
  name: 'get',
  description: 'Get configuration value',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Configuration key (dot notation)',
      type: 'string'
    }
  ],
  examples: [
    { command: 'flo config get swarm.topology', description: 'Get swarm topology' },
    { command: 'flo config get -k memory.backend', description: 'Get memory backend' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];
    const root = configRoot(ctx);

    const loaded = loadOrReport(root);
    if (!loaded) return { success: false, exitCode: 1 };
    const { config, path } = loaded;

    if (!key) {
      const configValues = flattenConfig(config);

      if (ctx.flags.format === 'json') {
        output.printJson(configValues);
        return { success: true, data: configValues };
      }

      output.writeln();
      output.writeln(output.bold('Current Configuration'));
      output.writeln(output.dim(path ? `  ${displayPath(root, path)}` : '  (no config file — showing defaults)'));
      output.writeln();

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 30 },
          { key: 'value', header: 'Value', width: 30 }
        ],
        data: Object.entries(configValues).map(([k, v]) => ({ key: k, value: String(v) }))
      });

      return { success: true, data: configValues };
    }

    const { found, value } = getConfigValue(config, key);

    if (!found) {
      output.printError(`Configuration key not found: ${key}`);
      return { success: false, exitCode: 1 };
    }

    if (ctx.flags.format === 'json') {
      output.printJson({ key, value });
    } else {
      output.writeln(`${key} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }

    return { success: true, data: { key, value } };
  }
};

// Set configuration
const setCommand: Command = {
  name: 'set',
  description: 'Set configuration value',
  options: [
    // Not `required` at the parser level: these are also accepted
    // positionally (`flo config set swarm.maxAgents 20`, this command's own
    // documented example), and a parser-level requirement rejects that form
    // before the action can read ctx.args. The action validates instead.
    {
      name: 'key',
      short: 'k',
      description: 'Configuration key',
      type: 'string'
    },
    {
      name: 'value',
      short: 'v',
      description: 'Configuration value',
      type: 'string'
    }
  ],
  examples: [
    { command: 'flo config set swarm.maxAgents 20', description: 'Set max agents' },
    { command: 'flo config set -k memory.backend -v agentdb', description: 'Set memory backend' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];
    const value = ctx.flags.value as string || ctx.args[1];

    if (!key || value === undefined) {
      output.printError('Both key and value are required');
      return { success: false, exitCode: 1 };
    }

    const root = configRoot(ctx);
    const loaded = loadOrReport(root);
    if (!loaded) return { success: false, exitCode: 1 };
    const { config } = loaded;

    const result = setConfigValue(config, key, String(value));
    if (!result.ok) {
      output.printError(`Cannot set ${key}: ${result.error}`);
      return { success: false, exitCode: 1 };
    }

    let target: string;
    try {
      target = saveCliConfig(root, config);
    } catch (err) {
      output.printError(`Failed to write configuration: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Setting ${key} = ${String(result.value)}`);
    output.printSuccess(`Configuration updated (${displayPath(root, target)})`);

    return { success: true, data: { key, value: result.value } };
  }
};

// List providers
const providersCommand: Command = {
  name: 'providers',
  description: 'Manage AI providers',
  options: [
    {
      name: 'add',
      short: 'a',
      description: 'Add provider',
      type: 'string'
    },
    {
      name: 'remove',
      short: 'r',
      description: 'Remove provider',
      type: 'string'
    },
    {
      name: 'enable',
      description: 'Enable provider',
      type: 'string'
    },
    {
      name: 'disable',
      description: 'Disable provider',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const root = configRoot(ctx);
    const loaded = loadOrReport(root);
    if (!loaded) return { success: false, exitCode: 1 };
    const { config } = loaded;

    const add = ctx.flags.add as string | undefined;
    const remove = ctx.flags.remove as string | undefined;
    const enable = ctx.flags.enable as string | undefined;
    const disable = ctx.flags.disable as string | undefined;

    const find = (name: string): CliConfigProvider | undefined =>
      config.providers.find((p) => p.name.toLowerCase() === name.toLowerCase());

    let mutated = false;

    if (add) {
      if (find(add)) {
        output.printError(`Provider already exists: ${add}`);
        return { success: false, exitCode: 1 };
      }
      const priority = config.providers.reduce((max, p) => Math.max(max, p.priority), 0) + 1;
      config.providers.push({ name: add, priority, enabled: false });
      mutated = true;
    }

    for (const [name, action] of [[remove, 'remove'], [enable, 'enable'], [disable, 'disable']] as const) {
      if (!name) continue;
      const provider = find(name);
      if (!provider) {
        output.printError(`Provider not found: ${name}`);
        return { success: false, exitCode: 1 };
      }
      if (action === 'remove') {
        config.providers = config.providers.filter((p) => p !== provider);
      } else {
        provider.enabled = action === 'enable';
      }
      mutated = true;
    }

    if (mutated) {
      let target: string;
      try {
        target = saveCliConfig(root, config);
      } catch (err) {
        output.printError(`Failed to write configuration: ${(err as Error).message}`);
        return { success: false, exitCode: 1 };
      }
      output.printSuccess(`Providers updated (${displayPath(root, target)})`);
    }

    const providers = config.providers.map((p) => ({
      ...p,
      model: p.model ?? '',
      status: p.enabled ? 'Active' : 'Disabled'
    }));

    if (ctx.flags.format === 'json') {
      output.printJson(providers);
      return { success: true, data: providers };
    }

    output.writeln();
    output.writeln(output.bold('AI Providers'));
    output.writeln();

    output.printTable({
      columns: [
        { key: 'name', header: 'Provider', width: 12 },
        { key: 'model', header: 'Model', width: 25 },
        { key: 'priority', header: 'Priority', width: 10, align: 'right' },
        { key: 'status', header: 'Status', width: 10, format: (v) => {
          if (v === 'Active') return output.success(String(v));
          return output.dim(String(v));
        }}
      ],
      data: providers
    });

    output.writeln();
    output.writeln(output.dim('Use --add, --remove, --enable, --disable to manage providers'));

    return { success: true, data: providers };
  }
};

// Reset configuration
const resetCommand: Command = {
  name: 'reset',
  description: 'Reset configuration to defaults',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    },
    {
      name: 'section',
      description: 'Reset specific section only',
      type: 'string',
      choices: [...RESETTABLE_SECTIONS]
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;
    const section = (ctx.flags.section as string || 'all') as ResettableSection;

    if (!RESETTABLE_SECTIONS.includes(section)) {
      output.printError(`Unknown section: ${section}`);
      output.writeln(output.dim(`  Valid sections: ${RESETTABLE_SECTIONS.join(', ')}`));
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Reset ${section} configuration to defaults?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    const root = configRoot(ctx);
    const loaded = loadOrReport(root);
    if (!loaded) return { success: false, exitCode: 1 };

    output.printInfo(`Resetting ${section} configuration...`);

    let target: string;
    try {
      target = saveCliConfig(root, resetSection(loaded.config, section));
    } catch (err) {
      output.printError(`Failed to write configuration: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }

    output.printSuccess(`Configuration reset to defaults (${displayPath(root, target)})`);

    return { success: true, data: { section, reset: true, path: target } };
  }
};

// Export configuration
const exportCommand: Command = {
  name: 'export',
  description: 'Export configuration',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output file path',
      type: 'string'
    },
    {
      name: 'format',
      short: 'f',
      description: 'Export format (json, yaml)',
      type: 'string',
      default: 'json',
      choices: ['json', 'yaml']
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const format = (ctx.flags.format as string) || 'json';
    if (format !== 'json' && format !== 'yaml') {
      output.printError(`Unsupported export format: ${format}`);
      output.writeln(output.dim('  Valid formats: json, yaml'));
      return { success: false, exitCode: 1 };
    }

    const root = configRoot(ctx);
    const loaded = loadOrReport(root);
    if (!loaded) return { success: false, exitCode: 1 };

    const requested = ctx.flags.output as string | undefined;
    const defaultName = `moflo.config.export.${format === 'yaml' ? 'yaml' : 'json'}`;
    const outputPath = requested
      ? (isAbsolute(requested) ? requested : resolve(root, requested))
      : resolve(root, defaultName);

    const config = { ...loaded.config, exportedAt: new Date().toISOString() };

    output.printInfo(`Exporting configuration to ${displayPath(root, outputPath)}...`);

    try {
      if (format === 'yaml') {
        const { dump } = await import('js-yaml');
        writeTextFile(outputPath, dump(config));
      } else {
        writeJsonFile(outputPath, config);
      }
    } catch (err) {
      output.printError(`Failed to write ${displayPath(root, outputPath)}: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.printSuccess('Configuration exported');

    return { success: true, data: { path: outputPath, format, config } };
  }
};

// Import configuration
const importCommand: Command = {
  name: 'import',
  description: 'Import configuration',
  options: [
    // Also accepted positionally (`flo config import ./cfg.json`) — see the
    // note on `set`.
    {
      name: 'file',
      short: 'f',
      description: 'Configuration file path',
      type: 'string'
    },
    {
      name: 'merge',
      description: 'Merge with existing configuration',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const file = ctx.flags.file as string || ctx.args[0];
    const merge = ctx.flags.merge as boolean;

    if (!file) {
      output.printError('File path is required');
      return { success: false, exitCode: 1 };
    }

    const root = configRoot(ctx);
    const source = isAbsolute(file) ? file : resolve(root, file);

    if (!existsSync(source)) {
      output.printError(`Configuration file not found: ${file}`);
      return { success: false, exitCode: 1 };
    }

    let incoming: unknown;
    try {
      const raw = readFileSync(source, 'utf8');
      if (extname(source).toLowerCase() === '.yaml' || extname(source).toLowerCase() === '.yml') {
        const { load } = await import('js-yaml');
        incoming = load(raw);
      } else {
        incoming = JSON.parse(raw);
      }
    } catch (err) {
      output.printError(`Could not parse ${file}: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }

    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      output.printError(`Not a configuration object: ${file}`);
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Importing configuration from ${file}...`);

    // Merge mode layers the file over what is on disk; replace mode layers it
    // over defaults, so an incomplete file still yields a complete config.
    let base: CliConfig;
    if (merge) {
      const loaded = loadOrReport(root);
      if (!loaded) return { success: false, exitCode: 1 };
      base = loaded.config;
      output.writeln(output.dim('  Merging with existing configuration...'));
    } else {
      base = defaultCliConfig();
      output.writeln(output.dim('  Replacing existing configuration...'));
    }

    const imported: CliConfig = { ...base, ...(incoming as Partial<CliConfig>) };

    let target: string;
    try {
      target = saveCliConfig(root, imported);
    } catch (err) {
      output.printError(`Failed to write configuration: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }

    output.printSuccess(`Configuration imported (${displayPath(root, target)})`);

    return { success: true, data: { file, merge, imported: true, path: target } };
  }
};

// Show moflo project config (merged with defaults)
const showCommand: Command = {
  name: 'show',
  description: 'Show current moflo project configuration',
  options: [
    { name: 'format', short: 'f', description: 'Output format (json or yaml)', type: 'string', default: 'json' },
  ],
  examples: [
    { command: 'flo config show', description: 'Show merged config as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const { loadMofloConfig } = await import('../config/moflo-config.js');
    const config = loadMofloConfig();
    output.writeln(JSON.stringify(config, null, 2));
    return { success: true, data: config };
  },
};

// Generate moflo.yaml in project root
const generateCommand: Command = {
  name: 'generate',
  description: 'Generate moflo.yaml config file',
  options: [],
  examples: [
    { command: 'flo config generate', description: 'Auto-detect and write moflo.yaml' },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    const { writeMofloConfig } = await import('../config/moflo-config.js');
    const configPath = writeMofloConfig();
    output.printSuccess(`Config written to: ${configPath}`);
    return { success: true };
  },
};

// Main config command
export const configCommand: Command = {
  name: 'config',
  description: 'Configuration management',
  subcommands: [initCommand, getCommand, setCommand, providersCommand, resetCommand, exportCommand, importCommand, showCommand, generateCommand],
  options: [],
  examples: [
    { command: 'flo config init --v3', description: 'Initialize V3 config' },
    { command: 'flo config get swarm.topology', description: 'Get config value' },
    { command: 'flo config set swarm.maxAgents 20', description: 'Set config value' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Configuration Management'));
    output.writeln();
    output.writeln('Usage: flo config <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}       - Initialize configuration`,
      `${output.highlight('get')}        - Get configuration value`,
      `${output.highlight('set')}        - Set configuration value`,
      `${output.highlight('providers')}  - Manage AI providers`,
      `${output.highlight('reset')}      - Reset to defaults`,
      `${output.highlight('export')}     - Export configuration`,
      `${output.highlight('import')}     - Import configuration`,
      `${output.highlight('show')}       - Show moflo project config (merged with defaults)`,
      `${output.highlight('generate')}   - Generate moflo.yaml for current project`
    ]);

    return { success: true };
  }
};

export default configCommand;
