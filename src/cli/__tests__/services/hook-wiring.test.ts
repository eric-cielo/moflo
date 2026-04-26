/**
 * Hook Wiring Repair Tests
 *
 * Validates that repairHookWiring() correctly detects and patches
 * missing required hook entries in a settings.json object.
 * This shared logic is used by both `doctor --fix` and `moflo upgrade`.
 */

import { describe, it, expect } from 'vitest';
import { repairHookWiring, HOOK_ENTRY_MAP } from '../../services/hook-wiring.js';
import { REQUIRED_HOOK_WIRING } from '../../commands/doctor-checks-deep.js';

/** Build a minimal settings object that contains ALL required hooks. */
function buildFullyWiredSettings(): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};

  for (const { pattern } of REQUIRED_HOOK_WIRING) {
    const entry = HOOK_ENTRY_MAP[pattern];
    if (!entry) continue;

    const eventArray = (hooks[entry.event] ?? []) as Array<Record<string, unknown>>;
    const block: Record<string, unknown> = { hooks: [entry.hook] };
    if (entry.matcher) block.matcher = entry.matcher;
    eventArray.push(block);
    hooks[entry.event] = eventArray;
  }

  return { hooks };
}

describe('repairHookWiring', () => {
  it('returns empty repaired list when all hooks are present', () => {
    const settings = buildFullyWiredSettings();
    const { repaired } = repairHookWiring(settings);
    expect(repaired).toEqual([]);
  });

  it('adds all hooks to an empty settings object', () => {
    const settings: Record<string, unknown> = {};
    const { repaired, settings: patched } = repairHookWiring(settings);

    expect(repaired.length).toBe(REQUIRED_HOOK_WIRING.length);
    expect(patched.hooks).toBeDefined();

    // Every required pattern should now be present in the serialised output
    const raw = JSON.stringify(patched);
    for (const { pattern } of REQUIRED_HOOK_WIRING) {
      expect(raw).toContain(pattern);
    }
  });

  it('adds only missing hooks, preserving existing ones', () => {
    // Start with just check-before-scan wired
    const entry = HOOK_ENTRY_MAP['check-before-scan'];
    const settings: Record<string, unknown> = {
      hooks: {
        [entry.event]: [{ matcher: entry.matcher, hooks: [entry.hook] }],
      },
    };

    const { repaired } = repairHookWiring(settings);

    // check-before-scan should NOT be in the repaired list
    expect(repaired).not.toContain('check-before-scan');
    // Everything else should have been added
    expect(repaired.length).toBe(REQUIRED_HOOK_WIRING.length - 1);
  });

  it('appends to an existing matcher block instead of duplicating it', () => {
    // Create a Bash PreToolUse block with check-dangerous-command but NOT check-before-pr
    const dangerousEntry = HOOK_ENTRY_MAP['check-dangerous-command'];
    const settings: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: '^Bash$', hooks: [dangerousEntry.hook] },
        ],
      },
    };

    const { repaired, settings: patched } = repairHookWiring(settings);

    expect(repaired).toContain('check-before-pr');

    // The ^Bash$ PreToolUse block should have both hooks, not two separate blocks
    const preToolUse = (patched.hooks as Record<string, unknown[]>).PreToolUse as Array<Record<string, unknown>>;
    const bashBlocks = preToolUse.filter(b => b.matcher === '^Bash$');
    expect(bashBlocks.length).toBe(1);

    const bashHooks = bashBlocks[0].hooks as unknown[];
    expect(bashHooks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles settings with hooks key but empty object', () => {
    const settings: Record<string, unknown> = { hooks: {} };
    const { repaired } = repairHookWiring(settings);
    expect(repaired.length).toBe(REQUIRED_HOOK_WIRING.length);
  });

  it('does not mutate unrelated settings keys', () => {
    const settings: Record<string, unknown> = {
      env: { FOO: 'bar' },
      statusLine: { type: 'command', command: 'echo hi' },
    };

    repairHookWiring(settings);

    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.statusLine).toEqual({ type: 'command', command: 'echo hi' });
  });

  it('creates prompt-reminder without a matcher (UserPromptSubmit)', () => {
    const settings: Record<string, unknown> = {};
    repairHookWiring(settings);

    const hooks = settings.hooks as Record<string, unknown[]>;
    const upsBlocks = hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    expect(upsBlocks).toBeDefined();
    expect(upsBlocks.length).toBeGreaterThanOrEqual(1);

    // The prompt-reminder block should have no matcher key
    const reminderBlock = upsBlocks.find(b => {
      const blockHooks = b.hooks as Array<{ command?: string }>;
      return blockHooks.some(h => h.command?.includes('prompt-reminder'));
    });
    expect(reminderBlock).toBeDefined();
    expect(reminderBlock!.matcher).toBeUndefined();
  });

  it('HOOK_ENTRY_MAP covers every REQUIRED_HOOK_WIRING pattern', () => {
    for (const { pattern } of REQUIRED_HOOK_WIRING) {
      expect(HOOK_ENTRY_MAP[pattern]).toBeDefined();
    }
  });
});
