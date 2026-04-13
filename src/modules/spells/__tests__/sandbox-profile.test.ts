/**
 * Sandbox Profile Generator Tests
 *
 * Tests for macOS sandbox-exec profile generation and command wrapping.
 * Uses mocking to test on any platform.
 *
 * @see https://github.com/eric-cielo/moflo/issues/410
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StepCapability } from '../src/types/step-command.types.js';

// ============================================================================
// Mocks
// ============================================================================

const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockRandomBytes = vi.fn(() => ({ toString: () => 'abcdef0123456789' }));

vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  existsSync: vi.fn(() => false),
}));

vi.mock('node:crypto', () => ({
  randomBytes: (...args: unknown[]) => mockRandomBytes(...args),
}));

import {
  generateSandboxProfile,
  wrapWithSandboxExec,
} from '../src/core/sandbox-profile.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// generateSandboxProfile()
// ============================================================================

describe('generateSandboxProfile', () => {
  const PROJECT_ROOT = '/Users/dev/myproject';

  it('generates deny-default profile with no capabilities', () => {
    const profile = generateSandboxProfile([], PROJECT_ROOT);
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow process-exec)');
    expect(profile).toContain('(allow process-fork)');
    expect(profile).toContain('(allow signal)');
    // System paths always allowed
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).toContain('(allow file-read* (subpath "/bin"))');
    expect(profile).toContain('(allow file-read* (subpath "/Library"))');
    expect(profile).toContain('(allow file-read* (subpath "/System"))');
    // No fs or net rules beyond system paths
    expect(profile).not.toContain('Filesystem read access');
    expect(profile).not.toContain('Filesystem write access');
    expect(profile).not.toContain('Network access');
  });

  it('adds file-read* for unscoped fs:read', () => {
    const caps: StepCapability[] = [{ type: 'fs:read' }];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).toContain('; Filesystem read access');
    expect(profile).toContain(`(allow file-read* (subpath "${PROJECT_ROOT}"))`);
  });

  it('adds file-read* for scoped fs:read paths', () => {
    const caps: StepCapability[] = [
      { type: 'fs:read', scope: ['/usr/local/share', './config/'] },
    ];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).toContain('(allow file-read* (subpath "/usr/local/share"))');
    // Relative path gets joined with project root — use regex to handle platform separators
    expect(profile).toMatch(/\(allow file-read\* \(subpath ".*config.*"\)\)/);
  });

  it('adds file-write* for unscoped fs:write', () => {
    const caps: StepCapability[] = [{ type: 'fs:write' }];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).toContain('; Filesystem write access');
    expect(profile).toContain(`(allow file-write* (subpath "${PROJECT_ROOT}"))`);
  });

  it('adds file-write* for scoped fs:write paths', () => {
    const caps: StepCapability[] = [
      { type: 'fs:write', scope: ['./dist/', '/tmp/output'] },
    ];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    // Relative path gets joined — use regex to handle platform separators
    expect(profile).toMatch(/\(allow file-write\* \(subpath ".*dist.*"\)\)/);
    expect(profile).toContain('(allow file-write* (subpath "/tmp/output"))');
  });

  it('adds network* when net capability present', () => {
    const caps: StepCapability[] = [{ type: 'net' }];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).toContain('; Network access');
    expect(profile).toContain('(allow network*)');
  });

  it('omits network rules when net capability absent', () => {
    const caps: StepCapability[] = [{ type: 'fs:read' }, { type: 'shell' }];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).not.toContain('network');
    expect(profile).not.toContain('Network');
  });

  it('combines all capability types', () => {
    const caps: StepCapability[] = [
      { type: 'fs:read', scope: ['./src/'] },
      { type: 'fs:write', scope: ['./dist/'] },
      { type: 'net' },
      { type: 'shell' },
    ];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).toContain('Filesystem read access');
    expect(profile).toContain('Filesystem write access');
    expect(profile).toContain('Network access');
    expect(profile).toContain('(allow network*)');
  });

  it('always includes temp directory access', () => {
    const profile = generateSandboxProfile([], PROJECT_ROOT);
    expect(profile).toContain('(allow file-read* (subpath "/private/tmp"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
  });

  it('handles absolute scope paths without joining', () => {
    const caps: StepCapability[] = [
      { type: 'fs:read', scope: ['/opt/data', '/var/log'] },
    ];
    const profile = generateSandboxProfile(caps, PROJECT_ROOT);
    expect(profile).toContain('(allow file-read* (subpath "/opt/data"))');
    expect(profile).toContain('(allow file-read* (subpath "/var/log"))');
  });

  it('adds tool home paths for elevated permission level', () => {
    const profile = generateSandboxProfile([], PROJECT_ROOT, {
      permissionLevel: 'elevated',
      homeDir: '/Users/tester',
    });
    expect(profile).toContain('; Tool home paths (elevated)');
    expect(profile).toContain('(allow file-write* (subpath "/Users/tester/.claude"))');
    expect(profile).toContain('(allow file-write* (subpath "/Users/tester/.claude.json"))');
    expect(profile).toContain('(allow file-write* (subpath "/Users/tester/Library/Application Support/Claude"))');
    expect(profile).toContain('(allow file-write* (subpath "/Users/tester/.config/gh"))');
    expect(profile).toContain('(allow file-write* (subpath "/Users/tester/.gitconfig"))');
  });

  it('adds tool home paths for autonomous permission level', () => {
    const profile = generateSandboxProfile([], PROJECT_ROOT, {
      permissionLevel: 'autonomous',
      homeDir: '/Users/tester',
    });
    expect(profile).toContain('; Tool home paths (elevated)');
  });

  it('does NOT add tool home paths for readonly/standard levels', () => {
    const readonlyProfile = generateSandboxProfile([], PROJECT_ROOT, {
      permissionLevel: 'readonly',
      homeDir: '/Users/tester',
    });
    const standardProfile = generateSandboxProfile([{ type: 'fs:write' }], PROJECT_ROOT, {
      permissionLevel: 'standard',
      homeDir: '/Users/tester',
    });
    expect(readonlyProfile).not.toContain('Tool home paths');
    expect(standardProfile).not.toContain('Tool home paths');
  });
});

// ============================================================================
// wrapWithSandboxExec()
// ============================================================================

describe('wrapWithSandboxExec', () => {
  const PROJECT_ROOT = '/Users/dev/myproject';

  it('returns sandbox-exec binary and correct args', () => {
    const caps: StepCapability[] = [{ type: 'fs:read' }];
    const result = wrapWithSandboxExec('echo hello', caps, PROJECT_ROOT);

    expect(result.bin).toBe('/usr/bin/sandbox-exec');
    expect(result.args[0]).toBe('-f');
    expect(result.args[1]).toMatch(/moflo-sandbox-.*\.sb$/);
    expect(result.args[2]).toBe('bash');
    expect(result.args[3]).toBe('-c');
    expect(result.args[4]).toBe('echo hello');
  });

  it('writes profile to temp file', () => {
    const caps: StepCapability[] = [{ type: 'net' }];
    wrapWithSandboxExec('curl example.com', caps, PROJECT_ROOT);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = mockWriteFileSync.mock.calls[0];
    expect(path).toMatch(/moflo-sandbox-.*\.sb$/);
    expect(content).toContain('(version 1)');
    expect(content).toContain('(allow network*)');
    expect(encoding).toBe('utf8');
  });

  it('cleanup removes the temp profile', () => {
    const caps: StepCapability[] = [];
    const result = wrapWithSandboxExec('ls', caps, PROJECT_ROOT);

    result.cleanup();
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    expect(mockUnlinkSync.mock.calls[0][0]).toMatch(/moflo-sandbox-.*\.sb$/);
  });

  it('cleanup swallows errors on missing file', () => {
    mockUnlinkSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const caps: StepCapability[] = [];
    const result = wrapWithSandboxExec('ls', caps, PROJECT_ROOT);

    // Should not throw
    expect(() => result.cleanup()).not.toThrow();
  });
});
