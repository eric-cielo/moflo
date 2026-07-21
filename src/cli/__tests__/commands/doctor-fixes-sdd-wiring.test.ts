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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
