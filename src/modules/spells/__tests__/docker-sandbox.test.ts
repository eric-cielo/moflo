/**
 * Docker Sandbox (Windows) — Unit Tests
 *
 * Tests docker run argument generation from step capabilities. Mirrors the
 * bwrap and sandbox-exec test suites so the three platforms stay aligned.
 *
 * @see docker-sandbox.ts
 */

import { describe, it, expect } from 'vitest';
import { buildDockerArgs, wrapWithDocker } from '../src/core/docker-sandbox.js';
import type { StepCapability } from '../src/types/step-command.types.js';

const PROJECT_ROOT = '/c/Users/tester/project';
const HOME_DIR = '/c/Users/tester';
const IMAGE = 'node:20-bookworm';

function opts(extra: Record<string, unknown> = {}) {
  return { image: IMAGE, homeDir: HOME_DIR, ...extra } as const;
}

describe('buildDockerArgs', () => {
  it('generates baseline args: --rm, -i, ro workspace bind, --network none', () => {
    const args = buildDockerArgs('echo hi', [], PROJECT_ROOT, opts());

    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args).toContain('-i');
    // Workspace bind is read-only by default
    expect(args).toContain(`${PROJECT_ROOT}:/workspace:ro`);
    expect(args).toContain('-w');
    expect(args).toContain('/workspace');
    // Default network is none
    const netIdx = args.indexOf('--network');
    expect(netIdx).toBeGreaterThan(-1);
    expect(args[netIdx + 1]).toBe('none');
    // Image + command at the end
    expect(args).toContain(IMAGE);
    const bashIdx = args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(-1);
    expect(args[bashIdx + 1]).toBe('-c');
    expect(args[bashIdx + 2]).toBe('echo hi');
  });

  it('promotes workspace to rw for unscoped fs:write', () => {
    const caps: StepCapability[] = [{ type: 'fs:write' }];
    const args = buildDockerArgs('touch x', caps, PROJECT_ROOT, opts());

    expect(args).toContain(`${PROJECT_ROOT}:/workspace`);
    expect(args).not.toContain(`${PROJECT_ROOT}:/workspace:ro`);
  });

  it('adds overlay rw bind for inside-project fs:write scope (workspace stays ro)', () => {
    const caps: StepCapability[] = [{ type: 'fs:write', scope: ['./dist'] }];
    const args = buildDockerArgs('build', caps, PROJECT_ROOT, opts());

    const binds = args.filter((_a, i) => args[i - 1] === '-v');
    // Workspace ro + overlay rw bind for dist
    expect(binds).toHaveLength(2);
    expect(binds.some(b => b === `${PROJECT_ROOT}:/workspace:ro`)).toBe(true);
    expect(binds.some(b => b === `${PROJECT_ROOT}/dist:/workspace/dist`)).toBe(true);
  });

  it('adds overlay rw bind for multiple inside-project fs:write scopes', () => {
    const caps: StepCapability[] = [{ type: 'fs:write', scope: ['./dist', './build'] }];
    const args = buildDockerArgs('build', caps, PROJECT_ROOT, opts());

    const binds = args.filter((_a, i) => args[i - 1] === '-v');
    expect(binds.some(b => b === `${PROJECT_ROOT}/dist:/workspace/dist`)).toBe(true);
    expect(binds.some(b => b === `${PROJECT_ROOT}/build:/workspace/build`)).toBe(true);
  });

  it('adds dedicated mount for fs:write scope outside project', () => {
    const caps: StepCapability[] = [{ type: 'fs:write', scope: ['/c/tmp/out'] }];
    const args = buildDockerArgs('build', caps, PROJECT_ROOT, opts());

    const binds = args.filter((_a, i) => args[i - 1] === '-v');
    // Workspace (ro) + dedicated outside mount
    expect(binds).toHaveLength(2);
    expect(binds.some(b => b.startsWith('/c/tmp/out:'))).toBe(true);
  });

  it('adds read-only mount for outside-project fs:read scopes', () => {
    const caps: StepCapability[] = [{ type: 'fs:read', scope: ['/c/shared/data'] }];
    const args = buildDockerArgs('scan', caps, PROJECT_ROOT, opts());

    const readMounts = args.filter((_a, i) => args[i - 1] === '-v' && args[i].endsWith(':ro'));
    expect(readMounts.some(m => m.startsWith('/c/shared/data:'))).toBe(true);
  });

  it('mounts tool home paths for elevated level', () => {
    const args = buildDockerArgs('claude -p', [], PROJECT_ROOT, opts({
      permissionLevel: 'elevated',
    }));

    const binds = args.filter((_a, i) => args[i - 1] === '-v');
    expect(binds.some(b => b === `${HOME_DIR}/.claude:/home/node/.claude`)).toBe(true);
    expect(binds.some(b => b === `${HOME_DIR}/.claude.json:/home/node/.claude.json`)).toBe(true);
    expect(binds.some(b => b === `${HOME_DIR}/.config/gh:/home/node/.config/gh`)).toBe(true);
    expect(binds.some(b => b === `${HOME_DIR}/.gitconfig:/home/node/.gitconfig`)).toBe(true);
  });

  it('mounts tool home paths for autonomous level', () => {
    const args = buildDockerArgs('gh pr list', [], PROJECT_ROOT, opts({
      permissionLevel: 'autonomous',
    }));

    const binds = args.filter((_a, i) => args[i - 1] === '-v');
    expect(binds.some(b => b.includes('/.claude:/home/node/.claude'))).toBe(true);
  });

  it('does not mount tool home paths for readonly/standard levels', () => {
    for (const level of ['readonly', 'standard'] as const) {
      const args = buildDockerArgs('ls', [], PROJECT_ROOT, opts({
        permissionLevel: level,
      }));
      const binds = args.filter((_a, i) => args[i - 1] === '-v');
      expect(binds.some(b => b.includes('/home/node/.claude'))).toBe(false);
    }
  });

  it('installs gh credential helper via GIT_CONFIG_* env vars for elevated', () => {
    const args = buildDockerArgs('git push', [], PROJECT_ROOT, opts({
      permissionLevel: 'elevated',
    }));
    const envs = args.filter((_a, i) => args[i - 1] === '-e');
    expect(envs).toContain('GIT_CONFIG_COUNT=2');
    expect(envs).toContain('GIT_CONFIG_KEY_0=credential.helper');
    expect(envs).toContain('GIT_CONFIG_VALUE_0=');
    expect(envs).toContain('GIT_CONFIG_KEY_1=credential.helper');
    expect(envs).toContain('GIT_CONFIG_VALUE_1=!gh auth git-credential');
  });

  it('installs gh credential helper via GIT_CONFIG_* env vars for autonomous', () => {
    const args = buildDockerArgs('git push', [], PROJECT_ROOT, opts({
      permissionLevel: 'autonomous',
    }));
    const envs = args.filter((_a, i) => args[i - 1] === '-e');
    expect(envs).toContain('GIT_CONFIG_VALUE_1=!gh auth git-credential');
  });

  it('does not set GIT_CONFIG_* env vars for readonly/standard levels', () => {
    for (const level of ['readonly', 'standard'] as const) {
      const args = buildDockerArgs('ls', [], PROJECT_ROOT, opts({
        permissionLevel: level,
      }));
      const envs = args.filter((_a, i) => args[i - 1] === '-e');
      expect(envs.some(e => e.startsWith('GIT_CONFIG_'))).toBe(false);
    }
  });

  it('shares host network for elevated without net capability', () => {
    const args = buildDockerArgs('claude -p', [], PROJECT_ROOT, opts({
      permissionLevel: 'elevated',
    }));
    expect(args).not.toContain('--network');
  });

  it('shares host network for autonomous without net capability', () => {
    const args = buildDockerArgs('gh pr view', [], PROJECT_ROOT, opts({
      permissionLevel: 'autonomous',
    }));
    expect(args).not.toContain('--network');
  });

  it('shares host network when net capability declared', () => {
    const caps: StepCapability[] = [{ type: 'net' }];
    const args = buildDockerArgs('curl example.com', caps, PROJECT_ROOT, opts());
    expect(args).not.toContain('--network');
  });

  it('denies network for readonly/standard without net capability', () => {
    for (const level of ['readonly', 'standard'] as const) {
      const args = buildDockerArgs('ls', [], PROJECT_ROOT, opts({
        permissionLevel: level,
      }));
      const netIdx = args.indexOf('--network');
      expect(netIdx).toBeGreaterThan(-1);
      expect(args[netIdx + 1]).toBe('none');
    }
  });
});

describe('wrapWithDocker', () => {
  it('returns docker binary and built args', () => {
    const result = wrapWithDocker('echo hi', [], PROJECT_ROOT, opts());

    expect(result.bin).toBe('docker');
    expect(result.args[0]).toBe('run');
    expect(result.args).toContain(IMAGE);
  });

  it('cleanup is a no-op (--rm handles container removal)', () => {
    const result = wrapWithDocker('ls', [], PROJECT_ROOT, opts());
    expect(() => result.cleanup()).not.toThrow();
  });

  it('respects dockerBin override', () => {
    const result = wrapWithDocker('ls', [], PROJECT_ROOT, opts({ dockerBin: '/usr/local/bin/docker' }));
    expect(result.bin).toBe('/usr/local/bin/docker');
  });
});
