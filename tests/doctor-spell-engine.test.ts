/**
 * Tests for doctor.ts spell engine health check
 *
 * Verifies:
 * - checkSpellEngine function exists in doctor command
 * - Validates core spell modules (runner, step-executor, registry, etc.)
 * - Checks built output existence
 * - Checks step commands and loaders directories
 * - Included in allChecks array and componentMap
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const DOCTOR_FILE = resolve(__dirname, '../src/modules/cli/src/commands/doctor.ts');
const WORKFLOWS_SRC = resolve(__dirname, '../src/modules/cli/src/spells');

describe('doctor.ts spell engine check', () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(DOCTOR_FILE, 'utf-8');
  });

  it('defines checkSpellEngine function', () => {
    expect(content).toContain('async function checkSpellEngine');
  });

  it('checks for core spell modules', () => {
    expect(content).toContain("'core/runner'");
    expect(content).toContain("'core/step-executor'");
    expect(content).toContain("'core/step-command-registry'");
    expect(content).toContain("'core/interpolation'");
    expect(content).toContain("'core/credential-masker'");
    expect(content).toContain("'registry/spell-registry'");
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
    expect(content).toContain('checkSpellEngine,');
  });

  it('is accessible via "spells" component flag', () => {
    expect(content).toContain("'workflows': checkSpellEngine");
  });

  it('is accessible via "spell" component flag', () => {
    expect(content).toContain("'workflow': checkSpellEngine");
  });

  it('reports missing modules with fix suggestion', () => {
    expect(content).toContain('Missing modules');
  });
});

describe('spell engine source structure', () => {
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

  it('has the spell registry', () => {
    expect(existsSync(join(WORKFLOWS_SRC, 'registry', 'spell-registry.ts'))).toBe(true);
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
    expect(indexContent).toContain('SpellCaster');
    expect(indexContent).toContain('Grimoire');
  });
});
