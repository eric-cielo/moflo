/**
 * Bubblewrap (bwrap) Sandbox — Unit Tests
 *
 * Tests bwrap argument generation from step capabilities.
 *
 * @see https://github.com/eric-cielo/moflo/issues/411
 */

import { describe, it, expect } from 'vitest';
import { buildBwrapArgs, wrapWithBwrap } from '../../src/spells/core/bwrap-sandbox.js';
import type { StepCapability } from '../../src/spells/types/step-command.types.js';

const PROJECT_ROOT = '/home/user/project';

describe('buildBwrapArgs', () => {
  it('generates default args with no capabilities', () => {
    const args = buildBwrapArgs('echo hello', [], PROJECT_ROOT);

    expect(args).toContain('--ro-bind');
    expect(args).toContain('--dev');
    expect(args).toContain('--proc');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');

    // Command at the end
    const bashIdx = args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(-1);
    expect(args[bashIdx + 1]).toBe('-c');
    expect(args[bashIdx + 2]).toBe('echo hello');
  });

  it('adds writable bind mount for unscoped fs:write', () => {
    const caps: StepCapability[] = [{ type: 'fs:write' }];
    const args = buildBwrapArgs('touch file.txt', caps, PROJECT_ROOT);

    // Should have --bind projectRoot projectRoot (writable)
    const bindIdx = args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(args[bindIdx + 1]).toBe(PROJECT_ROOT);
    expect(args[bindIdx + 2]).toBe(PROJECT_ROOT);
  });

  it('adds writable bind mounts for scoped fs:write', () => {
    const caps: StepCapability[] = [
      { type: 'fs:write', scope: ['./dist', '/tmp/output'] },
    ];
    const args = buildBwrapArgs('build', caps, PROJECT_ROOT);

    // Should have --bind for each scoped path
    const bindIndices: number[] = [];
    args.forEach((a, i) => { if (a === '--bind') bindIndices.push(i); });

    expect(bindIndices.length).toBe(2);
    // Relative path resolved
    expect(args[bindIndices[0] + 1]).toBe('/home/user/project/dist');
    // Absolute path passed through
    expect(args[bindIndices[1] + 1]).toBe('/tmp/output');
  });

  it('adds read-only bind mounts for scoped fs:read', () => {
    const caps: StepCapability[] = [
      { type: 'fs:read', scope: ['./src', './config'] },
    ];
    const args = buildBwrapArgs('cat src/index.ts', caps, PROJECT_ROOT);

    // Count --ro-bind occurrences (root + 2 scoped)
    const roBind: number[] = [];
    args.forEach((a, i) => { if (a === '--ro-bind') roBind.push(i); });

    // Root bind + 2 scoped = 3
    expect(roBind.length).toBe(3);
    expect(args[roBind[1] + 1]).toBe('/home/user/project/src');
    expect(args[roBind[2] + 1]).toBe('/home/user/project/config');
  });

  it('omits --unshare-net when net capability is granted', () => {
    const caps: StepCapability[] = [{ type: 'net' }];
    const args = buildBwrapArgs('curl example.com', caps, PROJECT_ROOT);

    expect(args).not.toContain('--unshare-net');
  });

  it('includes --unshare-net when no net capability', () => {
    const caps: StepCapability[] = [{ type: 'fs:read' }];
    const args = buildBwrapArgs('echo test', caps, PROJECT_ROOT);

    expect(args).toContain('--unshare-net');
  });

  it('does not duplicate --ro-bind for paths already covered by --bind (fs:write)', () => {
    const caps: StepCapability[] = [
      { type: 'fs:read', scope: ['./src'] },
      { type: 'fs:write', scope: ['./src'] },
    ];
    const args = buildBwrapArgs('test', caps, PROJECT_ROOT);

    // ./src should appear as --bind (writable), not also as --ro-bind
    const resolvedSrc = '/home/user/project/src';
    const roBind: string[] = [];
    const rwBind: string[] = [];
    args.forEach((a, i) => {
      if (a === '--ro-bind' && args[i + 1] === resolvedSrc) roBind.push(args[i + 1]);
      if (a === '--bind' && args[i + 1] === resolvedSrc) rwBind.push(args[i + 1]);
    });

    expect(rwBind.length).toBe(1);
    expect(roBind.length).toBe(0);
  });

  it('always includes --unshare-pid', () => {
    const caps: StepCapability[] = [{ type: 'shell' }, { type: 'net' }];
    const args = buildBwrapArgs('ps aux', caps, PROJECT_ROOT);

    expect(args).toContain('--unshare-pid');
  });

  // Regression: without --die-with-parent, child processes from sandboxed
  // commands (e.g. node workers from `claude -p`) keep the PID namespace
  // alive past entry-script exit and the runner's timeout cleanup can't
  // tear bwrap down. See verify-sandbox-bash-wsl.mjs probe.
  it('always includes --die-with-parent so cleanup propagates', () => {
    const args = buildBwrapArgs('ps aux', [{ type: 'shell' }], PROJECT_ROOT);
    expect(args).toContain('--die-with-parent');
  });

  it('binds tool home paths writable for elevated permission level', () => {
    const home = '/home/tester';
    const args = buildBwrapArgs('claude -p "hi"', [], PROJECT_ROOT, {
      permissionLevel: 'elevated',
      homeDir: home,
    });

    const findBindTry = (path: string): boolean => {
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === '--bind-try' && args[i + 1] === path && args[i + 2] === path) {
          return true;
        }
      }
      return false;
    };

    expect(findBindTry('/home/tester/.claude')).toBe(true);
    expect(findBindTry('/home/tester/.claude.json')).toBe(true);
    expect(findBindTry('/home/tester/.config/gh')).toBe(true);
    expect(findBindTry('/home/tester/.gitconfig')).toBe(true);
    expect(findBindTry('/home/tester/.npmrc')).toBe(true);
  });

  it('binds tool home paths writable for autonomous permission level', () => {
    const args = buildBwrapArgs('claude', [], PROJECT_ROOT, {
      permissionLevel: 'autonomous',
      homeDir: '/home/tester',
    });

    expect(args).toContain('--bind-try');
  });

  it('does NOT bind tool home paths for readonly/standard levels', () => {
    const rArgs = buildBwrapArgs('ls', [], PROJECT_ROOT, {
      permissionLevel: 'readonly',
      homeDir: '/home/tester',
    });
    const sArgs = buildBwrapArgs('edit', [{ type: 'fs:write' }], PROJECT_ROOT, {
      permissionLevel: 'standard',
      homeDir: '/home/tester',
    });

    expect(rArgs).not.toContain('--bind-try');
    expect(sArgs).not.toContain('--bind-try');
  });

  it('omits --unshare-net for elevated permission level (claude -p needs network)', () => {
    const args = buildBwrapArgs('claude -p "hi"', [], PROJECT_ROOT, {
      permissionLevel: 'elevated',
      homeDir: '/home/tester',
    });

    expect(args).not.toContain('--unshare-net');
  });

  it('omits --unshare-net for autonomous permission level', () => {
    const args = buildBwrapArgs('claude', [], PROJECT_ROOT, {
      permissionLevel: 'autonomous',
      homeDir: '/home/tester',
    });

    expect(args).not.toContain('--unshare-net');
  });

  it('includes --unshare-net for readonly/standard levels without net cap', () => {
    const rArgs = buildBwrapArgs('ls', [], PROJECT_ROOT, {
      permissionLevel: 'readonly',
    });
    const sArgs = buildBwrapArgs('edit', [{ type: 'fs:write' }], PROJECT_ROOT, {
      permissionLevel: 'standard',
    });

    expect(rArgs).toContain('--unshare-net');
    expect(sArgs).toContain('--unshare-net');
  });

  it('does not duplicate tool home bind when already covered by fs:write scope', () => {
    const home = '/home/tester';
    const args = buildBwrapArgs('claude', [{ type: 'fs:write', scope: [`${home}/.claude`] }], PROJECT_ROOT, {
      permissionLevel: 'elevated',
      homeDir: home,
    });

    const claudePath = `${home}/.claude`;
    let writableBinds = 0;
    for (let i = 0; i < args.length - 2; i++) {
      if ((args[i] === '--bind' || args[i] === '--bind-try') && args[i + 1] === claudePath) {
        writableBinds++;
      }
    }

    expect(writableBinds).toBe(1);
  });
});

describe('wrapWithBwrap', () => {
  it('returns SandboxWrapResult with bin=bwrap', () => {
    const result = wrapWithBwrap('echo test', [], PROJECT_ROOT);

    expect(result.bin).toBe('bwrap');
    expect(result.args).toContain('bash');
    expect(result.args[result.args.length - 1]).toBe('echo test');
  });

  it('cleanup is a safe no-op', () => {
    const result = wrapWithBwrap('echo test', [], PROJECT_ROOT);

    // Should not throw
    expect(() => result.cleanup()).not.toThrow();
  });
});
