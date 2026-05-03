/**
 * #896: doctor's `Hook Block Drift` check honours `auto_update.hook_block_drift: off`.
 *
 * Pre-#896, the launcher was the only consumer of this config; the doctor
 * still emitted a warn even when the user had explicitly opted out, leaving
 * `flo doctor --strict` red on consumers using `off` mode. This test pins
 * the suppression so a future change can't silently drop it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkHookBlockDrift } from '../commands/doctor-checks-deep.js';
import { getReferenceHookBlock } from '../services/hook-block-hash.js';

describe('checkHookBlockDrift — auto_update.hook_block_drift: off (#896)', () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moflo-doctor-hook-drift-off-'));
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    // findProjectRoot() walks up from cwd looking for package.json/.git.
    // Drop a marker so it stops at tmpDir instead of bubbling up into the
    // host project (which would cause the doctor check to read the wrong files).
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"tmp-fixture"}');
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns pass when settings have drift but yaml mode is off', () => {
    // Drifted settings: stripped block, would normally produce a warn.
    writeFileSync(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '^Read$', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 }] },
          ],
        },
      }),
    );
    writeFileSync(
      join(tmpDir, 'moflo.yaml'),
      `auto_update:\n  enabled: true\n  hook_block_drift: off\n`,
    );

    return checkHookBlockDrift().then((result) => {
      expect(result.status).toBe('pass');
      expect(result.message).toContain('off');
    });
  });

  it('still warns when drift exists and yaml mode is warn (default behaviour preserved)', () => {
    writeFileSync(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '^Read$', hooks: [{ type: 'command', command: 'custom-handler', timeout: 1000 }] },
          ],
        },
      }),
    );
    writeFileSync(
      join(tmpDir, 'moflo.yaml'),
      `auto_update:\n  enabled: true\n  hook_block_drift: warn\n`,
    );

    return checkHookBlockDrift().then((result) => {
      expect(result.status).toBe('warn');
      expect(result.message).toContain('drift');
    });
  });

  it('passes when settings match reference regardless of mode', () => {
    writeFileSync(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: getReferenceHookBlock() }),
    );
    writeFileSync(
      join(tmpDir, 'moflo.yaml'),
      `auto_update:\n  enabled: true\n  hook_block_drift: regenerate\n`,
    );

    return checkHookBlockDrift().then((result) => {
      expect(result.status).toBe('pass');
      expect(result.message).toContain('matches reference');
    });
  });
});
