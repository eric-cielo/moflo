/**
 * Tests for the moflo.yaml compliance doctor check (#895).
 *
 * The doctor check wraps validateMofloYaml() and formats the verdict as a
 * HealthCheck. validateMofloYaml itself is unit-tested in
 * init-moflo-yaml-template.test.ts; these tests cover the doctor formatting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkMofloYamlCompliance } from '../commands/doctor.js';
import { ensureMofloYamlExists } from '../init/moflo-yaml-template.js';

function makeTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `doctor-yaml-${label}-`));
}

describe('checkMofloYamlCompliance', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot('check'); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ } });

  it('warns when moflo.yaml does not exist', async () => {
    const result = await checkMofloYamlCompliance(root);
    expect(result.name).toBe('moflo.yaml');
    expect(result.status).toBe('warn');
    expect(result.message).toContain('not found');
    expect(result.fix).toBeTruthy();
  });

  it('passes when moflo.yaml is freshly created with all required sections', async () => {
    ensureMofloYamlExists(root);
    const result = await checkMofloYamlCompliance(root);
    expect(result.status).toBe('pass');
    expect(result.name).toBe('moflo.yaml');
  });

  it('fails when moflo.yaml is empty', async () => {
    fs.writeFileSync(path.join(root, 'moflo.yaml'), '   \n   ', 'utf-8');
    const result = await checkMofloYamlCompliance(root);
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/empty/);
    expect(result.fix).toBeTruthy();
  });

  it('warns when moflo.yaml is missing top-level sections (recoverable)', async () => {
    fs.writeFileSync(path.join(root, 'moflo.yaml'), 'project:\n  name: partial\n', 'utf-8');
    const result = await checkMofloYamlCompliance(root);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Missing sections');
    expect(result.message).toContain('model_routing');
    expect(result.fix).toMatch(/yaml-upgrader|moflo init/);
  });

  it('returns a name that matches the registered diagnostic alias', async () => {
    // The doctor's componentMap maps 'yaml' / 'moflo-yaml' to this check, so
    // the human-readable name needs to mention moflo.yaml for `flo doctor yaml`
    // output to make sense.
    const result = await checkMofloYamlCompliance(root);
    expect(result.name).toBe('moflo.yaml');
  });

  it('defaults to process.cwd() when no cwd is passed', async () => {
    // Sanity: without an argument, the check inspects the current working
    // directory. This mirrors how the doctor wires the registered check.
    const result = await checkMofloYamlCompliance();
    expect(result.name).toBe('moflo.yaml');
    expect(['pass', 'warn', 'fail']).toContain(result.status);
  });
});
