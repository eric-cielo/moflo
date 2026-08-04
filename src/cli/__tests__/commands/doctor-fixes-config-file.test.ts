/**
 * Tests for the `Config File` auto-fix.
 *
 * The regression being pinned: the fix used to `return runFixCommand('npx
 * moflo config init')` — i.e. report success from an exit code. `config init`
 * printed "Creating claude-flow.config.json..." and wrote nothing, so
 * `flo doctor --fix` listed the fix as `applied: true` on every single run
 * while the `Config File` warning never cleared. The fix must now derive its
 * verdict from the file existing on disk.
 *
 * Validates that the fix:
 *  - returns false when the command exits 0 but leaves no file behind
 *  - returns true once a config file is actually present
 *  - short-circuits (no command run) when a config already exists
 *  - honours every candidate filename the check recognises, incl. legacy names
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fixConfigFile } from '../../commands/doctor-fixes.js';
import { CLI_CONFIG_CANDIDATES, cliConfigPath } from '../../config/cli-config-store.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-config-fix-')));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Config File auto-fix', () => {
  it('reports failure when the command exits 0 but writes nothing', async () => {
    // Exactly the old `config init`: succeeds loudly, touches no filesystem.
    const applied = await fixConfigFile({ root: tmpDir, run: async () => true });

    expect(applied).toBe(false);
  });

  it('reports success once the command actually writes the config', async () => {
    const applied = await fixConfigFile({
      root: tmpDir,
      run: async () => {
        writeFileSync(cliConfigPath(tmpDir), JSON.stringify({ version: '3.0.0' }));
        return true;
      },
    });

    expect(applied).toBe(true);
  });

  it('reports success even when the command reports failure, if the file landed', async () => {
    const applied = await fixConfigFile({
      root: tmpDir,
      run: async () => {
        writeFileSync(cliConfigPath(tmpDir), JSON.stringify({ version: '3.0.0' }));
        return false;
      },
    });

    expect(applied).toBe(true);
  });

  it('short-circuits without running the command when a config exists', async () => {
    mkdirSync(join(tmpDir, '.moflo'), { recursive: true });
    writeFileSync(cliConfigPath(tmpDir), JSON.stringify({ version: '3.0.0' }));

    let ran = false;
    const applied = await fixConfigFile({
      root: tmpDir,
      run: async () => {
        ran = true;
        return true;
      },
    });

    expect(applied).toBe(true);
    expect(ran).toBe(false);
  });

  it.each([...CLI_CONFIG_CANDIDATES])('recognises %s as an existing config', async (candidate) => {
    const target = join(tmpDir, candidate);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{}');

    let ran = false;
    const applied = await fixConfigFile({ root: tmpDir, run: async () => { ran = true; return true; } });

    expect(applied).toBe(true);
    expect(ran).toBe(false);
  });
});
