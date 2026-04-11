/**
 * Permission Resolver Tests
 *
 * Tests for least-privilege permission escalation when spawning Claude CLI.
 */

import { describe, it, expect } from 'vitest';
import {
  resolvePermissions,
  buildClaudeCommand,
  isValidPermissionLevel,
  VALID_PERMISSION_LEVELS,
  type PermissionLevel,
} from '../src/core/permission-resolver.js';
import type { StepCapability } from '../src/types/step-command.types.js';

// ============================================================================
// resolvePermissions
// ============================================================================

describe('resolvePermissions', () => {
  describe('explicit permission levels', () => {
    it('readonly → Read,Glob,Grep only, no permission bypass', () => {
      const result = resolvePermissions('readonly');
      expect(result.level).toBe('readonly');
      expect(result.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
      expect(result.skipPermissions).toBe(false);
      expect(result.cliArgs).toContain('--allowedTools');
      expect(result.cliArgs).toContain('Read,Glob,Grep');
      expect(result.cliArgs).not.toContain('--permission-mode');
    });

    it('standard → Edit,Write,Read,Glob,Grep with acceptEdits', () => {
      const result = resolvePermissions('standard');
      expect(result.level).toBe('standard');
      expect(result.allowedTools).toEqual(['Edit', 'Write', 'Read', 'Glob', 'Grep']);
      expect(result.skipPermissions).toBe(false);
      expect(result.cliArgs).toContain('--permission-mode');
      expect(result.cliArgs).toContain('acceptEdits');
    });

    it('elevated → Edit,Write,Bash,Read,Glob,Grep with bypassPermissions', () => {
      const result = resolvePermissions('elevated');
      expect(result.level).toBe('elevated');
      expect(result.allowedTools).toEqual(['Edit', 'Write', 'Bash', 'Read', 'Glob', 'Grep']);
      expect(result.skipPermissions).toBe(true);
      expect(result.cliArgs).toContain('--permission-mode');
      expect(result.cliArgs).toContain('bypassPermissions');
    });

    it('autonomous → no tool restriction, bypassPermissions', () => {
      const result = resolvePermissions('autonomous');
      expect(result.level).toBe('autonomous');
      expect(result.allowedTools).toBeUndefined();
      expect(result.skipPermissions).toBe(true);
      expect(result.cliArgs).toContain('--permission-mode');
      expect(result.cliArgs).toContain('bypassPermissions');
      expect(result.cliArgs).not.toContain('--allowedTools');
    });
  });

  describe('capability-derived levels', () => {
    it('no capabilities → readonly', () => {
      const result = resolvePermissions(undefined, []);
      expect(result.level).toBe('readonly');
    });

    it('undefined capabilities → readonly', () => {
      const result = resolvePermissions(undefined, undefined);
      expect(result.level).toBe('readonly');
    });

    it('fs:read only → readonly', () => {
      const caps: StepCapability[] = [{ type: 'fs:read' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('readonly');
    });

    it('fs:write → standard', () => {
      const caps: StepCapability[] = [{ type: 'fs:write' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('standard');
    });

    it('agent → standard', () => {
      const caps: StepCapability[] = [{ type: 'agent' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('standard');
    });

    it('shell → elevated', () => {
      const caps: StepCapability[] = [{ type: 'shell' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('elevated');
    });

    it('browser → elevated', () => {
      const caps: StepCapability[] = [{ type: 'browser' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('elevated');
    });

    it('shell + fs:write → elevated (highest wins)', () => {
      const caps: StepCapability[] = [{ type: 'fs:write' }, { type: 'shell' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('elevated');
    });

    it('memory only → readonly', () => {
      const caps: StepCapability[] = [{ type: 'memory' }];
      const result = resolvePermissions(undefined, caps);
      expect(result.level).toBe('readonly');
    });
  });

  describe('explicit level overrides capability derivation', () => {
    it('readonly with shell caps → stays readonly', () => {
      const caps: StepCapability[] = [{ type: 'shell' }];
      const result = resolvePermissions('readonly', caps);
      expect(result.level).toBe('readonly');
    });

    it('autonomous with no caps → stays autonomous', () => {
      const result = resolvePermissions('autonomous', []);
      expect(result.level).toBe('autonomous');
    });
  });

  describe('additional tools', () => {
    it('adds extra tools to the base set', () => {
      const result = resolvePermissions('readonly', undefined, ['Agent', 'WebSearch']);
      expect(result.allowedTools).toContain('Agent');
      expect(result.allowedTools).toContain('WebSearch');
      expect(result.allowedTools).toContain('Read');
    });

    it('does not duplicate tools already in the base set', () => {
      const result = resolvePermissions('readonly', undefined, ['Read', 'Glob']);
      const readCount = result.allowedTools!.filter(t => t === 'Read').length;
      expect(readCount).toBe(1);
    });

    it('additional tools ignored for autonomous level', () => {
      const result = resolvePermissions('autonomous', undefined, ['Read']);
      expect(result.allowedTools).toBeUndefined();
    });
  });

  describe('invalid explicit levels fall back to derivation', () => {
    it('unknown string falls back to capability derivation', () => {
      const caps: StepCapability[] = [{ type: 'shell' }];
      const result = resolvePermissions('invalid-level', caps);
      expect(result.level).toBe('elevated');
    });
  });

  describe('permission bypass only for elevated/autonomous', () => {
    it('readonly does not bypass', () => {
      const result = resolvePermissions('readonly');
      expect(result.skipPermissions).toBe(false);
    });

    it('standard does not bypass', () => {
      const result = resolvePermissions('standard');
      expect(result.skipPermissions).toBe(false);
    });

    it('elevated bypasses', () => {
      const result = resolvePermissions('elevated');
      expect(result.skipPermissions).toBe(true);
    });

    it('autonomous bypasses', () => {
      const result = resolvePermissions('autonomous');
      expect(result.skipPermissions).toBe(true);
    });
  });
});

// ============================================================================
// buildClaudeCommand
// ============================================================================

describe('buildClaudeCommand', () => {
  it('produces a valid claude command for elevated level', () => {
    const cmd = buildClaudeCommand('Do something', 'elevated');
    expect(cmd).toContain('claude');
    expect(cmd).toContain('--permission-mode bypassPermissions');
    expect(cmd).toContain('--allowedTools Edit,Write,Bash,Read,Glob,Grep');
    expect(cmd).toContain('-p "Do something"');
  });

  it('readonly command has no permission-mode flag', () => {
    const cmd = buildClaudeCommand('Analyze code', 'readonly');
    expect(cmd).not.toContain('--permission-mode');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(cmd).toContain('--allowedTools Read,Glob,Grep');
  });

  it('standard command uses acceptEdits mode', () => {
    const cmd = buildClaudeCommand('Edit files', 'standard');
    expect(cmd).toContain('--permission-mode acceptEdits');
    expect(cmd).not.toContain('bypassPermissions');
  });

  it('escapes double quotes in prompt', () => {
    const cmd = buildClaudeCommand('Say "hello"', 'readonly');
    expect(cmd).toContain('Say \\"hello\\"');
  });

  it('autonomous omits --allowedTools', () => {
    const cmd = buildClaudeCommand('Full access', 'autonomous');
    expect(cmd).not.toContain('--allowedTools');
  });
});

// ============================================================================
// isValidPermissionLevel
// ============================================================================

describe('isValidPermissionLevel', () => {
  it('accepts valid levels', () => {
    expect(isValidPermissionLevel('readonly')).toBe(true);
    expect(isValidPermissionLevel('standard')).toBe(true);
    expect(isValidPermissionLevel('elevated')).toBe(true);
    expect(isValidPermissionLevel('autonomous')).toBe(true);
  });

  it('rejects invalid strings', () => {
    expect(isValidPermissionLevel('admin')).toBe(false);
    expect(isValidPermissionLevel('')).toBe(false);
    expect(isValidPermissionLevel('ELEVATED')).toBe(false);
  });
});
