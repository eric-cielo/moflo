/**
 * Tests for doctor.ts test directory health check.
 *
 * After the doctor.ts decomposition (#906), the implementation lives in
 * doctor-checks-config.ts and the registry wiring lives in doctor-registry.ts.
 *
 * Verifies:
 * - checkTestDirs function exists in doctor-checks-config.ts
 * - Checks for tests section in moflo.yaml
 * - Validates configured test directories exist
 * - Warns on missing test directories
 * - Included in allChecks array and componentMap (registry)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CHECKS_FILE = resolve(__dirname, '../src/cli/commands/doctor-checks-config.ts');
const REGISTRY_FILE = resolve(__dirname, '../src/cli/commands/doctor-registry.ts');

describe('doctor.ts test directory check', () => {
  let content: string;
  let registry: string;

  beforeAll(() => {
    content = readFileSync(CHECKS_FILE, 'utf-8');
    registry = readFileSync(REGISTRY_FILE, 'utf-8');
  });

  it('defines checkTestDirs function', () => {
    expect(content).toContain('async function checkTestDirs');
  });

  it('checks for moflo.yaml existence', () => {
    expect(content).toContain("join(process.cwd(), 'moflo.yaml')");
  });

  it('parses tests section from YAML', () => {
    expect(content).toContain('tests:\\s*\\n\\s+directories:');
  });

  it('validates directory existence', () => {
    expect(content).toContain("existsSync(join(process.cwd(), d))");
  });

  it('reports missing directories', () => {
    expect(content).toContain('missing');
    expect(content).toContain('No configured test dirs exist');
  });

  it('is included in allChecks array', () => {
    expect(registry).toContain('checkTestDirs,');
  });

  it('is accessible via component flag', () => {
    expect(registry).toContain("'tests': checkTestDirs");
  });
});
