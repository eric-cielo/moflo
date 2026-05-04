/**
 * Tests for the Gate Health auto-fix drift-mirror behaviour added after the
 * #920 docs-only-PR exemption shipped to only one of the two parallel gate.cjs
 * files. The pre-fix `fixGateHealthHooks()` only patched settings.json hook
 * wiring and silently claimed success when bin/.claude-helpers gate.cjs were
 * out of sync, producing a false "Auto-fixed 1 issue" report.
 *
 * The fix decides sync direction by which source file is "ahead" of its
 * installed counterpart in `node_modules/moflo/`. We exercise each branch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoFixCheck } from '../../commands/doctor-fixes.js';

const HELPER_NEW = '// helper version with extra exemption block\nmodule.exports = "new";\n'.repeat(20);
const BIN_NEW = '// bin version with extra block\nmodule.exports = "new-bin";\n'.repeat(20);
const SHARED_OLD = '// shared old version\nmodule.exports = "old";\n'.repeat(20);

let originalCwd: string;
let tmpDir: string;

function seedFixture(args: { binSource: string; helperSource: string; installedBin: string; installedHelper: string }) {
  mkdirSync(join(tmpDir, 'bin'), { recursive: true });
  mkdirSync(join(tmpDir, '.claude', 'helpers'), { recursive: true });
  mkdirSync(join(tmpDir, 'node_modules', 'moflo', 'bin'), { recursive: true });
  mkdirSync(join(tmpDir, 'node_modules', 'moflo', '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(tmpDir, 'bin', 'gate.cjs'), args.binSource);
  writeFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), args.helperSource);
  writeFileSync(join(tmpDir, 'node_modules', 'moflo', 'bin', 'gate.cjs'), args.installedBin);
  writeFileSync(join(tmpDir, 'node_modules', 'moflo', '.claude', 'helpers', 'gate.cjs'), args.installedHelper);
}

describe('Gate Health auto-fix — bin/helper drift-mirror', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'moflo-gate-fix-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mirrors helper → bin when only helper is ahead of installed (the #920 case)', async () => {
    seedFixture({
      binSource: SHARED_OLD,
      helperSource: HELPER_NEW,
      installedBin: SHARED_OLD,
      installedHelper: SHARED_OLD,
    });

    const ok = await autoFixCheck({ name: 'Gate Health', status: 'fail', message: 'drift', fix: 'sync' });

    expect(ok).toBe(true);
    expect(readFileSync(join(tmpDir, 'bin', 'gate.cjs'), 'utf8')).toBe(HELPER_NEW);
    expect(readFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), 'utf8')).toBe(HELPER_NEW);
  });

  it('mirrors bin → helper when only bin is ahead of installed', async () => {
    seedFixture({
      binSource: BIN_NEW,
      helperSource: SHARED_OLD,
      installedBin: SHARED_OLD,
      installedHelper: SHARED_OLD,
    });

    const ok = await autoFixCheck({ name: 'Gate Health', status: 'fail', message: 'drift', fix: 'sync' });

    expect(ok).toBe(true);
    expect(readFileSync(join(tmpDir, 'bin', 'gate.cjs'), 'utf8')).toBe(BIN_NEW);
    expect(readFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), 'utf8')).toBe(BIN_NEW);
  });

  it('refuses to pick a side when both source files are ahead with different content', async () => {
    seedFixture({
      binSource: BIN_NEW,
      helperSource: HELPER_NEW,
      installedBin: SHARED_OLD,
      installedHelper: SHARED_OLD,
    });

    const ok = await autoFixCheck({ name: 'Gate Health', status: 'fail', message: 'drift', fix: 'sync' });

    expect(ok).toBe(false);
    expect(readFileSync(join(tmpDir, 'bin', 'gate.cjs'), 'utf8')).toBe(BIN_NEW);
    expect(readFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), 'utf8')).toBe(HELPER_NEW);
  });

  it('does nothing (and reports success for hook-wiring path) when source files already match', async () => {
    seedFixture({
      binSource: HELPER_NEW,
      helperSource: HELPER_NEW,
      installedBin: SHARED_OLD,
      installedHelper: SHARED_OLD,
    });

    const ok = await autoFixCheck({ name: 'Gate Health', status: 'fail', message: 'drift', fix: 'sync' });

    expect(ok).toBe(true);
    expect(readFileSync(join(tmpDir, 'bin', 'gate.cjs'), 'utf8')).toBe(HELPER_NEW);
    expect(readFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), 'utf8')).toBe(HELPER_NEW);
  });

  it('bails on drift when node_modules/moflo is absent (no install to anchor direction)', async () => {
    mkdirSync(join(tmpDir, 'bin'), { recursive: true });
    mkdirSync(join(tmpDir, '.claude', 'helpers'), { recursive: true });
    writeFileSync(join(tmpDir, 'bin', 'gate.cjs'), SHARED_OLD);
    writeFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), HELPER_NEW);

    const ok = await autoFixCheck({ name: 'Gate Health', status: 'fail', message: 'drift', fix: 'sync' });

    expect(ok).toBe(false);
    expect(readFileSync(join(tmpDir, 'bin', 'gate.cjs'), 'utf8')).toBe(SHARED_OLD);
    expect(readFileSync(join(tmpDir, '.claude', 'helpers', 'gate.cjs'), 'utf8')).toBe(HELPER_NEW);
    expect(existsSync(join(tmpDir, 'node_modules'))).toBe(false);
  });
});
