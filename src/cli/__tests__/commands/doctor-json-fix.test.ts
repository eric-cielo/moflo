/**
 * Issue #1122: `npx moflo doctor --json --fix` (and `--json --install` /
 * `--json --kill-zombies`) used to silently no-op because the JSON branch
 * early-returned BEFORE runAutoFix / maybeAutoInstallClaudeCode were called.
 * Every consumer running `/healer --fix` saw the failure persist after the
 * "fix" completed with no diagnostic.
 *
 * These tests pin the post-fix orchestration contract:
 *   - `runAutoFix` returns a structured outcome (fixesApplied + reEvaluated)
 *     in both rendered and silent modes.
 *   - `emitJsonOutput` carries `fixesApplied`, `zombieScan`, `claudeCodeInstall`
 *     through when provided, and omits them when not.
 *   - Silent mode suppresses stdout so the JSON document stays single-doc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoFixCheckMock } = vi.hoisted(() => ({
  autoFixCheckMock: vi.fn<(check: { name: string }) => Promise<boolean>>(),
}));

vi.mock('../../commands/doctor-fixes.js', () => ({
  autoFixCheck: autoFixCheckMock,
}));

import {
  emitJsonOutput,
  runAutoFix,
  type FixOutcome,
} from '../../commands/doctor-render.js';
import type { CheckFn, HealthCheck } from '../../commands/doctor-types.js';

let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
let capturedStdout: string;

beforeEach(() => {
  capturedStdout = '';
  stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown) => {
      capturedStdout += String(chunk);
      return true;
    },
  );
  autoFixCheckMock.mockReset();
});

afterEach(() => {
  stdoutWriteSpy.mockRestore();
});

describe('runAutoFix (#1122) — structured outcome', () => {
  it('returns fixesApplied + reEvaluated when at least one fix succeeds', async () => {
    autoFixCheckMock.mockResolvedValue(true);

    const results: HealthCheck[] = [
      { name: 'Stub Check A', status: 'fail', message: 'broken', fix: 'fix-it' },
      { name: 'Stub Check B', status: 'pass', message: 'fine' },
    ];
    const fixes = ['Stub Check A: fix-it'];

    let reCheckCalls = 0;
    const fakeCheck: CheckFn = async () => {
      reCheckCalls++;
      return { name: 'Stub Check A', status: 'pass', message: 'now ok' };
    };

    const outcome = await runAutoFix(results, fixes, [fakeCheck], { silent: true });

    expect(outcome.fixesApplied).toEqual([
      { name: 'Stub Check A', applied: true },
    ]);
    expect(outcome.reEvaluated).not.toBeNull();
    expect(outcome.reEvaluated?.[0].status).toBe('pass');
    expect(reCheckCalls).toBe(1);
  });

  it('returns fixesApplied with applied=false and null reEvaluated when fix fails', async () => {
    autoFixCheckMock.mockResolvedValue(false);

    const results: HealthCheck[] = [
      { name: 'Stub Check A', status: 'fail', message: 'broken', fix: 'fix-it' },
    ];
    const fixes = ['Stub Check A: fix-it'];
    const fakeCheck: CheckFn = async () => ({ name: 'Stub Check A', status: 'fail', message: 'still broken' });

    const outcome = await runAutoFix(results, fixes, [fakeCheck], { silent: true });

    expect(outcome.fixesApplied).toEqual([{ name: 'Stub Check A', applied: false }]);
    expect(outcome.reEvaluated).toBeNull();
  });

  it('silent mode writes nothing to stdout; rendered mode writes the banner', async () => {
    autoFixCheckMock.mockResolvedValue(true);

    const results: HealthCheck[] = [
      { name: 'Stub Check A', status: 'fail', message: 'broken', fix: 'fix-it' },
    ];
    const fixes = ['Stub Check A: fix-it'];
    const fakeCheck: CheckFn = async () => ({ name: 'Stub Check A', status: 'pass', message: 'ok' });

    capturedStdout = '';
    await runAutoFix(results, fixes, [fakeCheck], { silent: true });
    expect(capturedStdout).toBe('');

    capturedStdout = '';
    await runAutoFix(results, fixes, [fakeCheck], { silent: false });
    expect(capturedStdout).toContain('Auto-fixing issues');
    expect(capturedStdout).toContain('Auto-fixed 1 issue');
  });

  it('no fixes → empty fixesApplied, no re-evaluation, no work performed', async () => {
    const outcome = await runAutoFix([], [], [], { silent: true });
    expect(outcome).toEqual({ fixesApplied: [], reEvaluated: null });
    expect(autoFixCheckMock).not.toHaveBeenCalled();
  });
});

describe('emitJsonOutput (#1122) — payload extensions', () => {
  const baseOpts = {
    results: [{ name: 'A', status: 'pass' as const, message: 'fine' }],
    strict: false,
    allowWarnList: [],
  };

  it('omits fixesApplied / zombieScan / claudeCodeInstall when not provided (backwards compatibility)', () => {
    capturedStdout = '';
    emitJsonOutput(baseOpts);
    const doc = JSON.parse(capturedStdout);
    expect(doc).toHaveProperty('summary');
    expect(doc).toHaveProperty('results');
    expect(doc).not.toHaveProperty('fixesApplied');
    expect(doc).not.toHaveProperty('zombieScan');
    expect(doc).not.toHaveProperty('claudeCodeInstall');
  });

  it('includes fixesApplied when provided', () => {
    capturedStdout = '';
    const fixesApplied: FixOutcome[] = [
      { name: 'Daemon Version Skew', applied: true },
      { name: 'Memory Database', applied: false, error: 'permission denied' },
    ];
    emitJsonOutput({ ...baseOpts, fixesApplied });
    const doc = JSON.parse(capturedStdout);
    expect(doc.fixesApplied).toEqual(fixesApplied);
  });

  it('includes zombieScan when provided', () => {
    capturedStdout = '';
    emitJsonOutput({
      ...baseOpts,
      zombieScan: { registryKilled: 2, found: 1, killed: 1, details: [] },
    });
    const doc = JSON.parse(capturedStdout);
    expect(doc.zombieScan).toEqual({ registryKilled: 2, found: 1, killed: 1, details: [] });
  });

  it('includes claudeCodeInstall when provided', () => {
    capturedStdout = '';
    emitJsonOutput({
      ...baseOpts,
      claudeCodeInstall: { attempted: true, installed: true },
    });
    const doc = JSON.parse(capturedStdout);
    expect(doc.claudeCodeInstall).toEqual({ attempted: true, installed: true });
  });

  it('emits empty fixesApplied array (distinct from absent) so automation can detect --fix ran with nothing to do', () => {
    capturedStdout = '';
    emitJsonOutput({ ...baseOpts, fixesApplied: [] });
    const doc = JSON.parse(capturedStdout);
    expect(doc.fixesApplied).toEqual([]);
  });
});
