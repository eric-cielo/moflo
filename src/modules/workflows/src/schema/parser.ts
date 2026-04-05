/**
 * Workflow Definition Parser
 *
 * Parses YAML/JSON into WorkflowDefinition objects.
 * NOTE: Parsed output is UNVALIDATED — always call validateWorkflowDefinition() after parsing.
 */

import { load as yamlLoad, JSON_SCHEMA } from 'js-yaml';
import type { ParsedWorkflow, WorkflowDefinition } from '../types/workflow-definition.types.js';
import { sanitizeObjectKeys } from '../core/interpolation.js';

/**
 * Parse a YAML string into a WorkflowDefinition.
 * @throws if YAML is malformed.
 */
export function parseYaml(content: string, sourceFile?: string): ParsedWorkflow {
  const raw = yamlLoad(content, { schema: JSON_SCHEMA });
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid workflow YAML${sourceFile ? ` in ${sourceFile}` : ''}: expected an object`);
  }
  const sanitized = sanitizeObjectKeys(raw) as Record<string, unknown>;
  return {
    definition: sanitized as unknown as WorkflowDefinition,
    sourceFile,
    format: 'yaml',
  };
}

/**
 * Parse a JSON string into a WorkflowDefinition.
 * @throws if JSON is malformed.
 */
export function parseJson(content: string, sourceFile?: string): ParsedWorkflow {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    throw new Error(
      `Invalid workflow JSON${sourceFile ? ` in ${sourceFile}` : ''}: ${(e as Error).message}`
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid workflow JSON${sourceFile ? ` in ${sourceFile}` : ''}: expected an object`);
  }
  const sanitized = sanitizeObjectKeys(raw) as Record<string, unknown>;
  return {
    definition: sanitized as unknown as WorkflowDefinition,
    sourceFile,
    format: 'json',
  };
}

/**
 * Parse a workflow file by detecting format from extension or content.
 */
export function parseWorkflow(content: string, sourceFile?: string): ParsedWorkflow {
  if (sourceFile) {
    const ext = sourceFile.toLowerCase();
    if (ext.endsWith('.json')) {
      return parseJson(content, sourceFile);
    }
    if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
      return parseYaml(content, sourceFile);
    }
  }

  // Auto-detect: try JSON first (faster), fall back to YAML
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{')) {
    return parseJson(content, sourceFile);
  }
  return parseYaml(content, sourceFile);
}
