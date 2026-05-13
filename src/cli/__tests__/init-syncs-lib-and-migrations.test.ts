/**
 * Regression: `flo init` must populate `.claude/scripts/lib/` and
 * `.claude/scripts/migrations/` (#1090).
 *
 * Pre-fix, `src/cli/init/moflo-init.ts` `syncScripts` only copied the
 * top-level scripts listed in `SCRIPT_MAP`. The synced scripts import
 * `./lib/moflo-resolve.mjs`, so a consumer that ran `flo init` and then
 * invoked a script directly (e.g. `node .claude/scripts/index-guidance.mjs`)
 * hit `ERR_MODULE_NOT_FOUND` until a separate path (post-install bootstrap
 * or session-start launcher §3) eventually synced `lib/`.
 *
 * pnpm 10+ exposes this most visibly because its default `onlyBuiltDependencies`
 * gate disables npm postinstall scripts, so the bootstrap fallback never runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initMoflo } from '../init/moflo-init.js';

describe('flo init — syncs bin/lib and bin/migrations (#1090)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moflo-init-1090-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates .claude/scripts/lib/ so synced scripts can resolve ./lib/* imports', async () => {
    await initMoflo({ projectRoot: tmpDir, minimal: true, force: true });

    const libDir = path.join(tmpDir, '.claude', 'scripts', 'lib');
    expect(fs.existsSync(libDir), 'expected .claude/scripts/lib/ after init').toBe(true);

    const resolveHelper = path.join(libDir, 'moflo-resolve.mjs');
    expect(fs.existsSync(resolveHelper), 'expected moflo-resolve.mjs in synced lib/').toBe(true);
    expect(fs.statSync(resolveHelper).size).toBeGreaterThan(0);
  });

  it('synced .claude/scripts/lib/ matches bin/lib/ file-for-file', async () => {
    await initMoflo({ projectRoot: tmpDir, minimal: true, force: true });

    const repoBinLib = path.resolve(__dirname, '..', '..', '..', 'bin', 'lib');
    const syncedLib = path.join(tmpDir, '.claude', 'scripts', 'lib');

    const listFiles = (root: string): string[] => {
      const entries = fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[];
      return entries
        .filter(e => e.isFile())
        .map(e => {
          const parent = (e as fs.Dirent & { parentPath?: string }).parentPath
            ?? (e as fs.Dirent & { path?: string }).path
            ?? root;
          return path.relative(root, path.join(parent, e.name)).split(path.sep).join('/');
        })
        .sort();
    };

    expect(listFiles(syncedLib)).toEqual(listFiles(repoBinLib));
  });

  it('populates .claude/scripts/migrations/ when migrations source exists', async () => {
    const repoMigrations = path.resolve(__dirname, '..', '..', '..', 'bin', 'migrations');
    if (!fs.existsSync(repoMigrations)) return; // source not present, nothing to assert

    await initMoflo({ projectRoot: tmpDir, minimal: true, force: true });

    const migrationsDir = path.join(tmpDir, '.claude', 'scripts', 'migrations');
    expect(fs.existsSync(migrationsDir), 'expected .claude/scripts/migrations/ after init').toBe(true);
    const entries = fs.readdirSync(migrationsDir);
    expect(entries.length).toBeGreaterThan(0);
  });
});
