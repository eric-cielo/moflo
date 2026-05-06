/**
 * Hook Wiring Repair Tests
 *
 * Validates that repairHookWiring() correctly detects and patches
 * missing required hook entries in a settings.json object.
 * This shared logic is used by both `doctor --fix` and `moflo upgrade`.
 */

import { describe, it, expect } from 'vitest';
import {
  repairHookWiring,
  rewriteIncorrectHookWiring,
  HOOK_ENTRY_MAP,
  HOOK_REWRITE_RULES,
} from '../../services/hook-wiring.js';
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

  it('creates UserPromptSubmit blocks without a matcher (#931 — prompt-hook.mjs + prompt-state-reset)', () => {
    const settings: Record<string, unknown> = {};
    repairHookWiring(settings);

    const hooks = settings.hooks as Record<string, unknown[]>;
    const upsBlocks = hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    expect(upsBlocks).toBeDefined();
    expect(upsBlocks.length).toBeGreaterThanOrEqual(2);

    // Both UserPromptSubmit hooks must be bare-block (no matcher key) so
    // Claude Code fires them on every prompt regardless of tool name.
    const promptHookBlock = upsBlocks.find(b => {
      const blockHooks = b.hooks as Array<{ command?: string }>;
      return blockHooks.some(h => h.command?.includes('prompt-hook.mjs'));
    });
    expect(promptHookBlock).toBeDefined();
    expect(promptHookBlock!.matcher).toBeUndefined();

    const safetyNetBlock = upsBlocks.find(b => {
      const blockHooks = b.hooks as Array<{ command?: string }>;
      return blockHooks.some(h => h.command?.includes('prompt-state-reset'));
    });
    expect(safetyNetBlock).toBeDefined();
    expect(safetyNetBlock!.matcher).toBeUndefined();
  });

  it('HOOK_ENTRY_MAP covers every REQUIRED_HOOK_WIRING pattern', () => {
    for (const { pattern } of REQUIRED_HOOK_WIRING) {
      expect(HOOK_ENTRY_MAP[pattern]).toBeDefined();
    }
  });

  it('record-memory-searched maps to gate-hook.mjs (not gate.cjs) — #879', () => {
    const entry = HOOK_ENTRY_MAP['record-memory-searched'];
    expect(entry).toBeDefined();
    expect(entry.hook.command).toContain('gate-hook.mjs');
    expect(entry.hook.command).not.toMatch(/gate\.cjs"\s+record-memory-searched/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// rewriteIncorrectHookWiring — the surgical auto-heal pass that fixes
// existing-but-wrong hook commands in consumer settings.json. Issue #879
// regression coverage: every consumer that upgrades through this version
// should have their stale `gate.cjs record-memory-searched` rewritten to
// `gate-hook.mjs record-memory-searched` on next session start.
// ────────────────────────────────────────────────────────────────────────────

describe('rewriteIncorrectHookWiring (#879)', () => {
  /** Build a settings.json with the OLD buggy wiring (gate.cjs direct). */
  function settingsWithBuggyWiring(): Record<string, unknown> {
    return {
      hooks: {
        PostToolUse: [
          {
            matcher: '^mcp__moflo__memory_(search|retrieve|list|stats)$',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-memory-searched',
                timeout: 3000,
              },
            ],
          },
          {
            matcher: '^Bash$',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-bash-memory',
                timeout: 2000,
              },
            ],
          },
        ],
      },
    };
  }

  function commandsFor(settings: Record<string, unknown>, action: string): string[] {
    const out: string[] = [];
    const events = (settings.hooks ?? {}) as Record<string, unknown>;
    for (const ev of Object.values(events)) {
      if (!Array.isArray(ev)) continue;
      for (const block of ev as Array<Record<string, unknown>>) {
        const hooks = block.hooks;
        if (!Array.isArray(hooks)) continue;
        for (const h of hooks as Array<{ command?: string }>) {
          if (typeof h.command === 'string' && h.command.includes(action)) out.push(h.command);
        }
      }
    }
    return out;
  }

  it('rewrites stale gate.cjs record-memory-searched → gate-hook.mjs', () => {
    const settings = settingsWithBuggyWiring();
    const { rewrites, settings: patched } = rewriteIncorrectHookWiring(settings);

    expect(rewrites.length).toBeGreaterThan(0);
    const cmds = commandsFor(patched, 'record-memory-searched');
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) {
      expect(cmd).toContain('gate-hook.mjs');
      expect(cmd).not.toMatch(/gate\.cjs[^/]*record-memory-searched/);
    }
  });

  it('rewrites stale gate.cjs check-bash-memory → gate-hook.mjs', () => {
    const settings = settingsWithBuggyWiring();
    const { rewrites, settings: patched } = rewriteIncorrectHookWiring(settings);

    expect(rewrites.some(r => r.name.includes('check-bash-memory'))).toBe(true);
    const cmds = commandsFor(patched, 'check-bash-memory');
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) {
      expect(cmd).toContain('gate-hook.mjs');
      expect(cmd).not.toMatch(/gate\.cjs[^/]*check-bash-memory/);
    }
  });

  it('is idempotent — second pass over already-correct settings makes no changes', () => {
    const settings = settingsWithBuggyWiring();
    rewriteIncorrectHookWiring(settings); // first pass fixes everything
    const before = JSON.stringify(settings);
    const { rewrites } = rewriteIncorrectHookWiring(settings);
    expect(rewrites).toEqual([]);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('returns empty rewrites when settings has no offending commands', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {
            matcher: '^mcp__moflo__memory_(search|retrieve|list|stats|store)$',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-memory-searched',
                timeout: 3000,
              },
            ],
          },
        ],
      },
    };
    const { rewrites } = rewriteIncorrectHookWiring(settings);
    expect(rewrites).toEqual([]);
  });

  // ── Issue #929 — matcher rewrite for the per-actor memory gate ──────────────
  // Claude Code anchors hook matchers (`^…$` semantics), so the bare
  // `mcp__moflo__memory_` matcher introduced by #882's #879 fix never fires
  // for any real MCP tool name. The launcher must rewrite this in-place so
  // existing consumers self-heal on session start without `flo doctor --fix`.

  it('rewrites broken `mcp__moflo__memory_` matcher to anchored alternation (#929)', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'mcp__moflo__memory_',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-memory-searched',
                timeout: 3000,
              },
            ],
          },
        ],
      },
    };
    const { rewrites, settings: patched } = rewriteIncorrectHookWiring(settings);

    expect(rewrites.some(r => r.name.includes('#929'))).toBe(true);
    const block = ((patched.hooks as Record<string, unknown[]>).PostToolUse as Array<{ matcher: string }>)[0];
    expect(block.matcher).toBe('^mcp__moflo__memory_(search|retrieve|list|stats|store)$');
  });

  it('matcher rewrite is idempotent — no second-pass changes', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'mcp__moflo__memory_',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-memory-searched',
                timeout: 3000,
              },
            ],
          },
        ],
      },
    };
    rewriteIncorrectHookWiring(settings);
    const before = JSON.stringify(settings);
    const { rewrites } = rewriteIncorrectHookWiring(settings);
    expect(rewrites).toEqual([]);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('matcher rewrite skips blocks whose hook command does not match the gating substring', () => {
    // A user-customised block that happens to share the broken matcher but
    // wires a different action — must NOT be rewritten.
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'mcp__moflo__memory_',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/my-custom-logger.mjs"',
                timeout: 1000,
              },
            ],
          },
        ],
      },
    };
    const { rewrites, settings: patched } = rewriteIncorrectHookWiring(settings);
    expect(rewrites.some(r => r.name.includes('#929'))).toBe(false);
    const block = ((patched.hooks as Record<string, unknown[]>).PostToolUse as Array<{ matcher: string }>)[0];
    expect(block.matcher).toBe('mcp__moflo__memory_');
  });

  it('handles malformed hooks gracefully (no throw on missing keys)', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          { /* no hooks key */ },
          { hooks: 'not-an-array' as unknown as never },
          { hooks: [{ /* no command key */ } as Record<string, unknown>] },
        ],
      },
    };
    expect(() => rewriteIncorrectHookWiring(settings)).not.toThrow();
  });

  it('preserves unrelated hook commands and surrounding settings', () => {
    const settings: Record<string, unknown> = {
      env: { FOO: 'bar' },
      hooks: {
        PostToolUse: [
          {
            matcher: '^mcp__moflo__memory_search$',
            hooks: [
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-memory-searched',
                timeout: 3000,
              },
              // Unrelated extra hook the user added — must survive untouched.
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/my-custom-logger.mjs"',
                timeout: 1000,
              },
            ],
          },
        ],
      },
    };
    const { settings: patched } = rewriteIncorrectHookWiring(settings);
    expect(patched.env).toEqual({ FOO: 'bar' });
    const cmds = ((patched.hooks as Record<string, unknown[]>).PostToolUse as Array<{ hooks: Array<{ command: string }> }>)[0].hooks.map(h => h.command);
    expect(cmds[0]).toContain('gate-hook.mjs');
    expect(cmds[1]).toContain('my-custom-logger.mjs');
  });

  it('HOOK_REWRITE_RULES has at least one rule for #879', () => {
    expect(HOOK_REWRITE_RULES.some(r => r.name.includes('#879') && r.from.includes('record-memory-searched'))).toBe(true);
  });
});
