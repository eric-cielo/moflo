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
import { checkMemoryFirstGate } from '../commands/doctor-checks-config.js';
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

describe('checkMemoryFirstGate (#1229 tripwire)', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot('gate'); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ } });

  it('passes (default) when moflo.yaml does not exist', async () => {
    const result = await checkMemoryFirstGate(root);
    expect(result.name).toBe('Memory-First Gate');
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/default/);
  });

  it('passes when memory_first is true', async () => {
    fs.writeFileSync(path.join(root, 'moflo.yaml'), 'gates:\n  memory_first: true\n', 'utf-8');
    const result = await checkMemoryFirstGate(root);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('Enabled');
  });

  it('WARNS when memory_first is disabled — the exact bug from #1229', async () => {
    fs.writeFileSync(
      path.join(root, 'moflo.yaml'),
      'gates:\n  memory_first: false  # Temporarily disabled for performance analysis\n',
      'utf-8',
    );
    const result = await checkMemoryFirstGate(root);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/DISABLED/);
    expect(result.fix).toMatch(/git checkout|memory_first: true/);
  });

  it('ignores a commented-out memory_first: false line', async () => {
    fs.writeFileSync(
      path.join(root, 'moflo.yaml'),
      'gates:\n  memory_first: true\n  # memory_first: false  (old note)\n',
      'utf-8',
    );
    const result = await checkMemoryFirstGate(root);
    expect(result.status).toBe('pass');
  });

  it('detects the disabled gate regardless of CRLF vs LF line endings (Rule #1)', async () => {
    // Windows checkouts may carry CRLF; the detector must behave identically.
    fs.writeFileSync(path.join(root, 'moflo.yaml'), 'gates:\r\n  memory_first: false\r\n', 'utf-8');
    const result = await checkMemoryFirstGate(root);
    expect(result.status).toBe('warn');
  });
});
