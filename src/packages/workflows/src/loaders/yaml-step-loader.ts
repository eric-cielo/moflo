/**
 * YAML Step Loader
 *
 * Parses YAML step definition files into StepCommand instances.
 * A YAML composite step defines a reusable action with declared
 * inputs, tool dependencies, and sequential actions.
 */

import { readFileSync } from 'node:fs';
import { load as yamlLoad, JSON_SCHEMA } from 'js-yaml';
import type { StepCommand } from '../types/step-command.types.js';
import { createCompositeCommand } from '../commands/composite-command.js';

export interface YamlStepDefinition {
  readonly name: string;
  readonly description?: string;
  readonly tool?: string;
  readonly inputs?: Record<string, YamlInputDef>;
  readonly actions: readonly YamlAction[];
}

export interface YamlInputDef {
  readonly type: 'string' | 'number' | 'boolean';
  readonly required?: boolean;
  readonly default?: unknown;
  readonly description?: string;
}

export interface YamlAction {
  readonly tool?: string;
  readonly action?: string;
  readonly command?: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Load a YAML step definition file and return a StepCommand.
 * @throws on invalid YAML or missing required fields.
 */
export function loadYamlStep(filePath: string): StepCommand {
  const content = readFileSync(filePath, 'utf-8');
  const raw = yamlLoad(content, { schema: JSON_SCHEMA });

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid YAML step definition in ${filePath}: expected an object`);
  }

  const def = raw as Record<string, unknown>;
  const parsed = validateYamlStepDefinition(def, filePath);
  return createCompositeCommand(parsed);
}

/**
 * Check whether a file path looks like a YAML step definition (by extension).
 */
export function isYamlStepFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

function validateYamlStepDefinition(
  raw: Record<string, unknown>,
  filePath: string,
): YamlStepDefinition {
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error(`YAML step in ${filePath}: 'name' is required and must be a string`);
  }

  if (!raw.actions || !Array.isArray(raw.actions) || raw.actions.length === 0) {
    throw new Error(`YAML step in ${filePath}: 'actions' is required and must be a non-empty array`);
  }

  const inputs = raw.inputs as Record<string, YamlInputDef> | undefined;
  if (inputs !== undefined && (typeof inputs !== 'object' || Array.isArray(inputs))) {
    throw new Error(`YAML step in ${filePath}: 'inputs' must be an object`);
  }

  return {
    name: raw.name as string,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    tool: typeof raw.tool === 'string' ? raw.tool : undefined,
    inputs: inputs ?? undefined,
    actions: raw.actions as YamlAction[],
  };
}
