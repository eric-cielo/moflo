/**
 * Directory Step Loader
 *
 * Discovers StepCommand implementations from filesystem directories.
 * Scans for .js/.ts files that export a valid StepCommand, skipping
 * invalid files with warnings rather than hard errors.
 *
 * Priority order (last wins):
 *   1. Shipped commands (registered via builtinCommands)
 *   2. User directories: `workflows/steps/`, `.claude/workflows/steps/`
 */

import { readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { StepCommand } from '../types/step-command.types.js';

const require = createRequire(import.meta.url);
import { isYamlStepFile, loadYamlStep } from './yaml-step-loader.js';

export interface DirectoryStepLoaderOptions {
  /** Directories to scan, in ascending priority order (last wins). */
  readonly dirs: readonly string[];
}

export interface DiscoveredStep {
  readonly command: StepCommand;
  readonly sourceFile: string;
}

export interface DirectoryLoadResult {
  readonly steps: Map<string, DiscoveredStep>;
  readonly warnings: readonly DirectoryLoadWarning[];
}

export interface DirectoryLoadWarning {
  readonly file: string;
  readonly message: string;
}

const JS_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.mts']);
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const ALL_STEP_EXTENSIONS = new Set([...JS_EXTENSIONS, ...YAML_EXTENSIONS]);

/** Known export names to check for a StepCommand. */
const STEP_EXPORT_NAMES = ['default', 'stepCommand', 'command'] as const;

/**
 * Scan directories for JS/TS files exporting a StepCommand.
 * Later directories override earlier ones by command type (last wins).
 */
export function loadStepsFromDirectories(
  options: DirectoryStepLoaderOptions,
): DirectoryLoadResult {
  const steps = new Map<string, DiscoveredStep>();
  const warnings: DirectoryLoadWarning[] = [];

  for (const dir of options.dirs) {
    scanDirectory(dir, steps, warnings);
  }

  return { steps, warnings };
}

/**
 * Scan a single directory for step command files.
 * Mutates `steps` and `warnings` in place for efficiency.
 */
function scanDirectory(
  dir: string,
  steps: Map<string, DiscoveredStep>,
  warnings: DirectoryLoadWarning[],
): void {
  const absDir = resolve(dir);

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }

  const files = entries.filter((f) =>
    ALL_STEP_EXTENSIONS.has(extname(f).toLowerCase()),
  );

  for (const file of files) {
    const filePath = join(absDir, file);
    try {
      const command = isYamlStepFile(filePath)
        ? loadYamlStep(filePath)
        : loadStepFromFile(filePath);
      if (command) {
        steps.set(command.type, { command, sourceFile: filePath });
      } else {
        warnings.push({
          file: filePath,
          message: 'No valid StepCommand export found',
        });
      }
    } catch (err) {
      warnings.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Attempt to load a StepCommand from a single file.
 * Checks known export names: default, stepCommand, command.
 */
function loadStepFromFile(filePath: string): StepCommand | null {
  // createRequire() enables sync loading in ESM; .ts files need a loader (tsx, ts-node).
  const mod = require(filePath);

  for (const name of STEP_EXPORT_NAMES) {
    const candidate = name === 'default' ? (mod.default ?? mod) : mod[name];
    if (isStepCommand(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Duck-type check for the StepCommand interface. */
function isStepCommand(value: unknown): value is StepCommand {
  if (value == null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    obj.type.length > 0 &&
    typeof obj.description === 'string' &&
    typeof obj.validate === 'function' &&
    typeof obj.execute === 'function' &&
    typeof obj.describeOutputs === 'function' &&
    obj.configSchema != null &&
    typeof obj.configSchema === 'object'
  );
}

export { isStepCommand, loadStepFromFile, scanDirectory };
