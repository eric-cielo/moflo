/**
 * Tests for doctor.ts test directory health check
 *
 * Verifies:
 * - checkTestDirs function exists in doctor command
 * - Checks for tests section in moflo.yaml
 * - Validates configured test directories exist
 * - Warns on missing test directories
 * - Included in allChecks array and componentMap
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCTOR_FILE = resolve(__dirname, '../src/cli/commands/doctor.ts');

describe('doctor.ts test directory check', () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(DOCTOR_FILE, 'utf-8');
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
    expect(content).toContain('checkTestDirs,');
  });

  it('is accessible via component flag', () => {
    expect(content).toContain("'tests': checkTestDirs");
  });
});
