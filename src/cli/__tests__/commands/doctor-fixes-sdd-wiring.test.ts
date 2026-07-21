/**
 * Tests for the `SDD + Verify Wiring` auto-fix handler (#1301).
 *
 * The pre-fix behaviour fell through to `npx moflo init --fix` and reported
 * `applied: true` on the command's exit code alone — even when the hook block
 * was LOCKED and init injected nothing. That false positive left a
 * permanently-red check the healer could never clear. The handler must now:
 *   - return FALSE (honest) when the block is locked and hooks are missing, and
 *   - actually graft the missing SDD/verify reference entries + re-verify from
 *     disk on an unlocked block, returning TRUE only when the wiring landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub the subprocess runner so the uninitialised path delegates to a mock
// instead of spawning a real `npx moflo init` (slow/networked/flaky in CI).
// vi.hoisted so the fn exists when the hoisted vi.mock factory references it.
const { runCommandMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(async () => {
    throw new Error('init blocked in test');
  }),
}));
vi.mock('../../commands/doctor-checks-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/doctor-checks-runtime.js')>();
  return { ...actual, runCommand: runCommandMock };
});

import { autoFixCheck } from '../../commands/doctor-fixes.js';

let originalCwd: string;
let tmpDir: string;
let prevEnv: string | undefined;

const CHECK: Parameters<typeof autoFixCheck>[0] = {
  name: 'SDD + Verify Wiring',
  status: 'fail',
  message: 'incomplete',
  fix: 'npx moflo init --fix',
};

function seedGate(cases: string[]): void {
  const helpers = join(tmpDir, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  writeFileSync(join(helpers, 'gate.cjs'), cases.map((c) => `case '${c}': { break; }`).join('\n'));
}

function seedSettings(obj: unknown): void {
  writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'moflo-sdd-fix-'));
  process.chdir(tmpDir);
  prevEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SDD + Verify Wiring auto-fix (#1301)', () => {
  it('returns false (no false positive) when the hook block is locked and hooks are missing', async () => {
    // sdd off + verify on (default). gate.cjs complete, but settings.json is
    // locked and lacks the verify hooks — moflo must not claim a fix it can't make.
    seedGate(['check-before-done', 'record-verify-run']);
    seedSettings({ moflo: { hooks: { locked: true } }, hooks: {} });
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'project:\n  name: t\n');

    const before = readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf8');
    const ok = await autoFixCheck(CHECK);

    expect(ok).toBe(false);
    // The locked block is left byte-for-byte untouched.
    expect(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf8')).toBe(before);
  });

  it('does not falsely report success on an uninitialised project (#1301 review)', async () => {
    // No .claude/ at all. The named handler must NOT short-circuit to true —
    // every missing* array is empty when nothing is on disk. It must delegate to
    // `npx moflo init` (the check's own remediation), not silently claim "Fixed".
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'project:\n  name: t\n');
    runCommandMock.mockClear();

    const ok = await autoFixCheck(CHECK);

    // The mocked init throws → runFixCommand returns false → honest result.
    expect(ok).toBe(false);
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    expect(runCommandMock.mock.calls[0][0]).toBe('npx moflo init');
    // settings.json was never conjured by a short-circuit.
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
  });

  it('wires the missing verify hooks and reports true on an unlocked block', async () => {
    // sdd off + verify on (default). gate.cjs complete; settings.json unlocked
    // but missing the verify hook tokens ⇒ handler grafts them and re-verifies.
    seedGate(['check-before-done', 'record-verify-run']);
    seedSettings({ hooks: {} });
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'project:\n  name: t\n');

    const ok = await autoFixCheck(CHECK);

    expect(ok).toBe(true);
    const after = readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf8');
    expect(after).toMatch(/check-before-done/);
    expect(after).toMatch(/record-verify-run/);
    // Scoped graft — the SDD implement gate is NOT pulled in (sdd.default=false).
    expect(after).not.toMatch(/check-before-implement/);
  });
});
