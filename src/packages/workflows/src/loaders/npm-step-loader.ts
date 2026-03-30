/**
 * npm Step Loader
 *
 * Discovers step commands from installed npm packages matching the
 * `moflo-step-*` naming convention. Lowest priority — overridden by
 * shipped and user directory steps.
 *
 * Discovery:
 *   1. Scan node_modules/ for directories matching `moflo-step-*`
 *   2. Read package.json for `moflo.stepCommand` entry point
 *   3. Fall back to package `main` if no `moflo.stepCommand` field
 *   4. Validate the export is a StepCommand
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StepCommand } from '../types/step-command.types.js';
import type { DiscoveredStep, DirectoryLoadWarning } from './directory-step-loader.js';
import { isStepCommand } from './directory-step-loader.js';

const NPM_STEP_PREFIX = 'moflo-step-';

export interface NpmLoadResult {
  readonly steps: Map<string, DiscoveredStep>;
  readonly warnings: readonly DirectoryLoadWarning[];
}

/**
 * Scan node_modules for packages matching `moflo-step-*` and load their StepCommand exports.
 * @param projectRoot - The project root containing node_modules/
 */
export function loadStepsFromNpm(projectRoot: string): NpmLoadResult {
  const steps = new Map<string, DiscoveredStep>();
  const warnings: DirectoryLoadWarning[] = [];
  const nodeModulesDir = resolve(projectRoot, 'node_modules');

  let entries: string[];
  try {
    entries = readdirSync(nodeModulesDir);
  } catch {
    return { steps, warnings };
  }

  const packages = entries.filter((name) => name.startsWith(NPM_STEP_PREFIX));

  for (const pkgName of packages) {
    const pkgDir = join(nodeModulesDir, pkgName);
    try {
      const command = loadStepFromPackage(pkgDir, pkgName);
      if (command) {
        steps.set(command.type, { command, sourceFile: pkgDir });
      } else {
        warnings.push({
          file: pkgDir,
          message: `Package "${pkgName}" does not export a valid StepCommand`,
        });
      }
    } catch (err) {
      warnings.push({
        file: pkgDir,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { steps, warnings };
}

function loadStepFromPackage(pkgDir: string, pkgName: string): StepCommand | null {
  const pkgJsonPath = join(pkgDir, 'package.json');
  let pkgJson: Record<string, unknown>;

  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read package.json for "${pkgName}"`);
  }

  // Check for moflo.stepCommand entry point
  const mofloConfig = pkgJson.moflo as Record<string, unknown> | undefined;
  const entryPoint = mofloConfig?.stepCommand as string | undefined;
  const mainEntry = (entryPoint ?? pkgJson.main ?? 'index.js') as string;
  const entryFile = join(pkgDir, mainEntry);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(entryFile);

  // Check default export, then named exports
  const candidates = [mod.default ?? mod, mod.stepCommand, mod.command];
  for (const candidate of candidates) {
    if (isStepCommand(candidate)) {
      return candidate;
    }
  }

  return null;
}
