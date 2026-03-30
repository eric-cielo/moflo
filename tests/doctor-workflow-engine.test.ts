/**
 * Tests for doctor.ts workflow engine health check
 *
 * Verifies:
 * - checkWorkflowEngine function exists in doctor command
 * - Validates core workflow modules (runner, step-executor, registry, etc.)
 * - Checks built output existence
 * - Checks step commands and loaders directories
 * - Included in allChecks array and componentMap
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const DOCTOR_FILE = resolve(__dirname, '../src/packages/cli/src/commands/doctor.ts');
const WORKFLOWS_SRC = resolve(__dirname, '../src/packages/workflows/src');

describe('doctor.ts workflow engine check', () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(DOCTOR_FILE, 'utf-8');
  });

  it('defines checkWorkflowEngine function', () => {
    expect(content).toContain('async function checkWorkflowEngine');
  });

  it('checks for core workflow modules', () => {
    expect(content).toContain("'core/runner'");
    expect(content).toContain("'core/step-executor'");
    expect(content).toContain("'core/step-command-registry'");
    expect(content).toContain("'core/interpolation'");
    expect(content).toContain("'core/credential-masker'");
    expect(content).toContain("'registry/workflow-registry'");
  });

  it('checks for schema, types, credentials, and scheduler directories', () => {
    expect(content).toContain("'schema'");
    expect(content).toContain("'types'");
    expect(content).toContain("'credentials'");
    expect(content).toContain("'scheduler'");
  });

  it('checks step commands directory', () => {
    expect(content).toContain('hasCommands');
    expect(content).toContain("join(baseDir, 'commands')");
  });

  it('checks loaders directory', () => {
    expect(content).toContain('hasLoaders');
    expect(content).toContain("join(baseDir, 'loaders')");
  });

  it('is included in allChecks array', () => {
    expect(content).toContain('checkWorkflowEngine,');
  });

  it('is accessible via "workflows" component flag', () => {
    expect(content).toContain("'workflows': checkWorkflowEngine");
  });

  it('is accessible via "workflow" component flag', () => {
    expect(content).toContain("'workflow': checkWorkflowEngine");
  });

  it('reports missing modules with fix suggestion', () => {
    expect(content).toContain('Missing modules');
  });
});

describe('workflow engine source structure', () => {
  it('has the core runner module', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'core', 'runner.ts'))).toBe(true);
  });

  it('has the step executor module', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'core', 'step-executor.ts'))).toBe(true);
  });

  it('has the step command registry', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'core', 'step-command-registry.ts'))).toBe(true);
  });

  it('has the interpolation engine', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'core', 'interpolation.ts'))).toBe(true);
  });

  it('has the credential masker', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'core', 'credential-masker.ts'))).toBe(true);
  });

  it('has the workflow registry', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'registry', 'workflow-registry.ts'))).toBe(true);
  });

  it('has the schema directory', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'schema'))).toBe(true);
  });

  it('has the types directory', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'types'))).toBe(true);
  });

  it('has the credentials directory', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'credentials'))).toBe(true);
  });

  it('has the scheduler directory', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'scheduler'))).toBe(true);
  });

  it('has the step commands directory', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'commands'))).toBe(true);
  });

  it('has the loaders directory', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'loaders'))).toBe(true);
  });

  it('exports from index.ts', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'index.ts'))).toBe(true);
    const indexContent = readFileSync(join(WORKFLOWS_SRC, 'index.ts'), 'utf-8');
    expect(indexContent).toContain('StepCommand');
    expect(indexContent).toContain('WorkflowRunner');
    expect(indexContent).toContain('WorkflowRegistry');
  });
});
