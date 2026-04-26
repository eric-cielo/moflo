/**
 * Official Hooks Bridge — Happy-path smoke tests
 *
 * Validates that the OfficialHooksBridge can convert between V3 internal
 * hook events and the official Claude Code hook API without throwing.
 */

import { describe, it, expect } from 'vitest';
import {
  OfficialHooksBridge,
  V3_TO_OFFICIAL_HOOK_MAP,
  V3_TOOL_MATCHERS,
  executeWithBridge,
  outputOfficialHookResult,
  type OfficialHookInput,
  type OfficialHookOutput,
} from '../../hooks/bridge/official-hooks-bridge.js';
import { HookEvent } from '../../hooks/types.js';

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
describe('OfficialHooksBridge — exports', () => {
  it('exports the bridge class', () => {
    expect(OfficialHooksBridge).toBeDefined();
  });

  it('exports V3_TO_OFFICIAL_HOOK_MAP', () => {
    expect(V3_TO_OFFICIAL_HOOK_MAP).toBeDefined();
    expect(typeof V3_TO_OFFICIAL_HOOK_MAP).toBe('object');
  });

  it('exports V3_TOOL_MATCHERS', () => {
    expect(V3_TOOL_MATCHERS).toBeDefined();
    expect(typeof V3_TOOL_MATCHERS).toBe('object');
  });

  it('exports executeWithBridge function', () => {
    expect(executeWithBridge).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// toV3Context
// ---------------------------------------------------------------------------
describe('OfficialHooksBridge.toV3Context', () => {
  const baseInput: OfficialHookInput = {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.json',
    cwd: '/workspace',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  };

  it('converts official input to V3 context', () => {
    const ctx = OfficialHooksBridge.toV3Context(baseInput);
    expect(ctx.event).toBe(HookEvent.PreCommand);
    expect(ctx.timestamp).toBeInstanceOf(Date);
    expect(ctx.metadata?.session_id).toBe('sess-1');
  });

  it('populates command info for Bash tool', () => {
    const ctx = OfficialHooksBridge.toV3Context(baseInput);
    expect(ctx.command?.raw).toBe('ls -la');
    expect(ctx.command?.workingDirectory).toBe('/workspace');
  });

  it('populates file info for Edit tool', () => {
    const editInput: OfficialHookInput = {
      ...baseInput,
      tool_name: 'Edit',
      tool_input: { file_path: '/src/main.ts' },
    };
    const ctx = OfficialHooksBridge.toV3Context(editInput);
    expect(ctx.event).toBe(HookEvent.PreEdit);
    expect(ctx.file?.path).toBe('/src/main.ts');
    expect(ctx.file?.operation).toBe('modify');
  });

  it('populates task info for Task tool', () => {
    const taskInput: OfficialHookInput = {
      ...baseInput,
      tool_name: 'Task',
      tool_input: { prompt: 'Refactor auth', subagent_type: 'coder' },
    };
    const ctx = OfficialHooksBridge.toV3Context(taskInput);
    expect(ctx.event).toBe(HookEvent.PreTask);
    expect(ctx.task?.description).toBe('Refactor auth');
    expect(ctx.task?.agent).toBe('coder');
  });
});

// ---------------------------------------------------------------------------
// toOfficialOutput
// ---------------------------------------------------------------------------
describe('OfficialHooksBridge.toOfficialOutput', () => {
  it('maps success result to continue', () => {
    const output = OfficialHooksBridge.toOfficialOutput(
      { success: true, message: 'ok' },
      'PreToolUse',
    );
    expect(output.decision).toBe('continue');
    expect(output.continue).toBe(true);
    expect(output.reason).toBe('ok');
  });

  it('maps abort result to block for tool hooks', () => {
    const output = OfficialHooksBridge.toOfficialOutput(
      { success: false, abort: true, error: 'forbidden' },
      'PreToolUse',
    );
    expect(output.decision).toBe('block');
    expect(output.continue).toBe(false);
    expect(output.reason).toBe('forbidden');
  });

  it('maps abort result to deny for PermissionRequest', () => {
    const output = OfficialHooksBridge.toOfficialOutput(
      { success: false, abort: true },
      'PermissionRequest',
    );
    expect(output.decision).toBe('deny');
  });

  it('passes through updatedInput', () => {
    const output = OfficialHooksBridge.toOfficialOutput(
      { success: true, data: { updatedInput: { command: 'echo safe' } } },
      'PreToolUse',
    );
    expect(output.updatedInput).toEqual({ command: 'echo safe' });
  });
});

// ---------------------------------------------------------------------------
// officialToV3Event
// ---------------------------------------------------------------------------
describe('OfficialHooksBridge.officialToV3Event', () => {
  it('maps PreToolUse + Read to PreRead', () => {
    expect(OfficialHooksBridge.officialToV3Event('PreToolUse', 'Read')).toBe(HookEvent.PreRead);
  });

  it('maps PostToolUse + Bash to PostCommand', () => {
    expect(OfficialHooksBridge.officialToV3Event('PostToolUse', 'Bash')).toBe(HookEvent.PostCommand);
  });

  it('maps Stop to SessionEnd', () => {
    expect(OfficialHooksBridge.officialToV3Event('Stop')).toBe(HookEvent.SessionEnd);
  });

  it('maps SubagentStop to AgentTerminate', () => {
    expect(OfficialHooksBridge.officialToV3Event('SubagentStop')).toBe(HookEvent.AgentTerminate);
  });

  it('maps SessionStart to SessionStart', () => {
    expect(OfficialHooksBridge.officialToV3Event('SessionStart')).toBe(HookEvent.SessionStart);
  });
});

// ---------------------------------------------------------------------------
// getToolMatcher / hasOfficialMapping
// ---------------------------------------------------------------------------
describe('OfficialHooksBridge — utility methods', () => {
  it('getToolMatcher returns regex for PreEdit', () => {
    const matcher = OfficialHooksBridge.getToolMatcher(HookEvent.PreEdit);
    expect(matcher).toBe('^(Write|Edit|MultiEdit)$');
  });

  it('getToolMatcher returns null for internal-only events', () => {
    expect(OfficialHooksBridge.getToolMatcher(HookEvent.PatternLearned)).toBeNull();
  });

  it('hasOfficialMapping returns true for PreEdit', () => {
    expect(OfficialHooksBridge.hasOfficialMapping(HookEvent.PreEdit)).toBe(true);
  });

  it('hasOfficialMapping returns false for PatternLearned', () => {
    expect(OfficialHooksBridge.hasOfficialMapping(HookEvent.PatternLearned)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeWithBridge
// ---------------------------------------------------------------------------
describe('executeWithBridge', () => {
  it('invokes handler and bridges output', async () => {
    const input: OfficialHookInput = {
      session_id: 'sess-2',
      transcript_path: '/tmp/t.json',
      cwd: '/workspace',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    };

    const handler = async () => ({ success: true, message: 'allowed' });
    const output = await executeWithBridge(input, handler);
    expect(output.decision).toBe('continue');
    expect(output.reason).toBe('allowed');
  });
});

// ---------------------------------------------------------------------------
// createCLICommand
// ---------------------------------------------------------------------------
describe('OfficialHooksBridge.createCLICommand', () => {
  it('generates a CLI string for PreEdit', () => {
    const cmd = OfficialHooksBridge.createCLICommand(HookEvent.PreEdit, 'pre-edit');
    expect(cmd).toContain('hooks pre-edit');
    expect(cmd).toContain('$TOOL_INPUT_file_path');
  });

  it('generates a CLI string for SessionStart', () => {
    const cmd = OfficialHooksBridge.createCLICommand(HookEvent.SessionStart, 'session-start');
    expect(cmd).toContain('session-start');
    expect(cmd).toContain('$SESSION_ID');
  });
});
