/**
 * Hook Block Hash / Drift Detection Tests (#881)
 *
 * Validates the self-contained `hook-block-hash` module that the session-start
 * launcher uses to surface drift between a consumer's `.claude/settings.json`
 * hook block and the reference block `generateHooksConfig()` would produce.
 */
import { describe, it, expect } from 'vitest';
import {
  normaliseHooks,
  computeHookBlockHash,
  computeHookBlockDrift,
  formatDriftReport,
  getReferenceHookBlock,
  applyWholesaleRegeneration,
  applyAdditiveRegeneration,
  isHookBlockLocked,
} from '../../services/hook-block-hash.js';
import { generateSettings } from '../../init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../../init/types.js';

// ──────────────────────────────────────────────────────────────────────────
// Cross-check: the inlined reference must match what generateHooksConfig
// would produce with all hook flags enabled — the canonical `flo init` shape.
// ──────────────────────────────────────────────────────────────────────────

describe('hook-block-hash — reference parity with settings-generator', () => {
  it('getReferenceHookBlock matches generateHooksConfig (DEFAULT_INIT_OPTIONS)', () => {
    const settings = generateSettings(DEFAULT_INIT_OPTIONS) as { hooks: Record<string, unknown> };
    const reference = getReferenceHookBlock();
    expect(computeHookBlockHash(reference)).toBe(computeHookBlockHash(settings.hooks));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Hash determinism + normalisation
// ──────────────────────────────────────────────────────────────────────────

describe('computeHookBlockHash — determinism', () => {
  it('returns the same hash for the same input across runs', () => {
    const ref = getReferenceHookBlock();
    expect(computeHookBlockHash(ref)).toBe(computeHookBlockHash(ref));
  });

  it('is stable under event-key reordering', () => {
    const ref = getReferenceHookBlock();
    const reordered: Record<string, unknown> = {};
    const keys = Object.keys(ref).sort().reverse();
    for (const k of keys) reordered[k] = (ref as Record<string, unknown>)[k];
    expect(computeHookBlockHash(reordered)).toBe(computeHookBlockHash(ref));
  });

  it('is stable under hook-array reordering within a matcher block', () => {
    const a = {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [
          { type: 'command', command: 'a', timeout: 1000 },
          { type: 'command', command: 'b', timeout: 1000 },
        ] },
      ],
    };
    const b = {
      PreToolUse: [
        { matcher: '^Bash$', hooks: [
          { type: 'command', command: 'b', timeout: 1000 },
          { type: 'command', command: 'a', timeout: 1000 },
        ] },
      ],
    };
    expect(computeHookBlockHash(a)).toBe(computeHookBlockHash(b));
  });

  it('normalises whitespace inside commands', () => {
    const a = { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node  script.js  --flag', timeout: 1000 }] }] };
    const b = { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node script.js --flag', timeout: 1000 }] }] };
    expect(computeHookBlockHash(a)).toBe(computeHookBlockHash(b));
  });

  it('produces different hashes for different command sets', () => {
    const a = { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'a', timeout: 1 }] }] };
    const b = { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'b', timeout: 1 }] }] };
    expect(computeHookBlockHash(a)).not.toBe(computeHookBlockHash(b));
  });

  it('handles empty / null / non-object inputs gracefully', () => {
    expect(computeHookBlockHash(null)).toBe(computeHookBlockHash(undefined));
    expect(computeHookBlockHash({})).toBe(computeHookBlockHash(null));
    expect(() => computeHookBlockHash('not an object' as unknown)).not.toThrow();
  });
});

describe('normaliseHooks', () => {
  it('drops invalid blocks and entries without throwing', () => {
    const out = normaliseHooks({
      PreToolUse: [
        null,
        { /* no hooks */ },
        { hooks: 'not-an-array' },
        { hooks: [{ /* no command */ }] },
        { hooks: [{ command: 'real', timeout: 100 }] },
      ],
    });
    expect(out.PreToolUse).toBeDefined();
    expect(out.PreToolUse.length).toBe(1);
    expect(out.PreToolUse[0].hooks[0].command).toBe('real');
  });

  it('drops events with no surviving blocks rather than emitting empty arrays', () => {
    const out = normaliseHooks({
      PreToolUse: [{ hooks: [] }],
      PostToolUse: [{ hooks: [{ command: 'ok', timeout: 1 }] }],
    });
    expect(out.PreToolUse).toBeUndefined();
    expect(out.PostToolUse).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Drift detection — covers the two AC test cases verbatim
// ──────────────────────────────────────────────────────────────────────────

describe('computeHookBlockDrift — AC test cases', () => {
  it('AC: consumer hand-edits a hook command — drift is "modified" (warn fires, no rewrite)', () => {
    // Take the reference and tweak one Bash command to add a custom flag.
    // Drift detector should report 1 missing (original) + 1 extra (tweaked).
    // The launcher handles "no rewrite when extras exist" — this test only
    // proves the report surfaces the modification.
    const consumer = JSON.parse(JSON.stringify(getReferenceHookBlock())) as Record<string, unknown[]>;
    // #1171 — Bash-shaped block matcher widened to `^(Bash|PowerShell)$`
    const bashBlock = (consumer.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>)
      .find(b => b.matcher === '^(Bash|PowerShell)$')!;
    const target = bashBlock.hooks.find(h => h.command.includes('check-dangerous-command'))!;
    target.command = target.command + ' --my-custom-flag';

    const report = computeHookBlockDrift(consumer);
    expect(report.drifted).toBe(true);
    // Original command shows up as missing
    expect(report.missing.some(m => m.command.endsWith('check-dangerous-command'))).toBe(true);
    // Customised command shows up as extra
    expect(report.extra.some(e => e.command.endsWith('--my-custom-flag'))).toBe(true);
    // No unrelated entries are missing — only the one modification
    expect(report.missing.length).toBe(1);
    expect(report.extra.length).toBe(1);
  });

  it('AC: a future hook event ships — drift detects the missing event without nuking unrelated hooks', () => {
    // Simulate a future moflo version that ships a `SessionEnd` event the
    // consumer doesn't yet have. The reference (synthesised here) includes it;
    // the consumer is on today's reference.
    const futureReference = JSON.parse(JSON.stringify(getReferenceHookBlock())) as Record<string, unknown>;
    (futureReference as Record<string, unknown[]>).SessionEnd = [
      { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/session-end.cjs"', timeout: 5000 }] },
    ];

    const consumer = getReferenceHookBlock();
    const report = computeHookBlockDrift(consumer, futureReference);

    expect(report.drifted).toBe(true);
    // Exactly one missing entry — the new event
    expect(report.missing.length).toBe(1);
    expect(report.missing[0].event).toBe('SessionEnd');
    // No unrelated drift — every other event is identical
    expect(report.extra.length).toBe(0);
    // Confirm unrelated existing matchers are unchanged in the consumer
    const consumerHooks = consumer as Record<string, unknown[]>;
    expect(consumerHooks.PreToolUse).toBeDefined();
    expect(consumerHooks.PostToolUse).toBeDefined();
  });

  it('reports drifted=false when consumer matches reference exactly', () => {
    const report = computeHookBlockDrift(getReferenceHookBlock());
    expect(report.drifted).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.consumerHash).toBe(report.referenceHash);
  });

  it('reports purely-additive drift correctly (consumer missing entries, no extras)', () => {
    // Consumer has a stripped-down hook block with only the Read gate.
    const consumer = {
      PreToolUse: [
        { matcher: '^Read$', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 }] },
      ],
    };
    const report = computeHookBlockDrift(consumer);
    expect(report.drifted).toBe(true);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.extra.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Wholesale regeneration (#896) — heals stale extras the additive variant
// cannot drop. Covers the AC that exposes the gap that triggered #896.
// ──────────────────────────────────────────────────────────────────────────

describe('applyWholesaleRegeneration (#896)', () => {
  it('replaces hooks block wholesale — drops extras AND adds missing in one pass', () => {
    // Simulates the #896 repro: consumer settings carry a stale SessionStart
    // hook from before #842 (an extra) plus a partial canonical block (missing entries).
    const settings: Record<string, unknown> = {
      permissions: { allow: ['Bash(npm:*)'] },
      hooks: {
        PreToolUse: [
          { matcher: '^Read$', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" session-reset', timeout: 2000 }] },
        ],
      },
    };
    const report = computeHookBlockDrift(settings.hooks);
    expect(report.drifted).toBe(true);
    expect(report.extra.length).toBeGreaterThan(0);
    expect(report.missing.length).toBeGreaterThan(0);

    const result = applyWholesaleRegeneration(settings, report);
    expect(result.added).toBe(report.missing.length);
    expect(result.removed).toBe(report.extra.length);

    // Post-regeneration, the hook block must match the canonical reference.
    const post = computeHookBlockDrift(settings.hooks);
    expect(post.drifted).toBe(false);
    expect(post.missing).toEqual([]);
    expect(post.extra).toEqual([]);

    // Non-hooks fields (permissions, etc.) survive untouched — wholesale only
    // replaces the `hooks` field.
    expect(settings.permissions).toEqual({ allow: ['Bash(npm:*)'] });
  });

  it('is a no-op when not drifted', () => {
    const settings: Record<string, unknown> = { hooks: getReferenceHookBlock() };
    const report = computeHookBlockDrift(settings.hooks);
    const result = applyWholesaleRegeneration(settings, report);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('does not corrupt the cached reference (returns a deep clone)', () => {
    // Defence-in-depth: if a future caller mutates settings.hooks after
    // wholesale regen, the cached reference used by computeHookBlockDrift
    // must not see those mutations on the next call.
    const a: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: '^Read$', hooks: [{ command: 'wrong', timeout: 1 }] }] } };
    applyWholesaleRegeneration(a, computeHookBlockDrift(a.hooks));
    const aHooks = a.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    aHooks.PreToolUse.push({ matcher: '^Custom$', hooks: [{ command: 'mut', timeout: 1 }] });

    // A fresh consumer, drifted, run through the same call should not see
    // the previous test's mutation in its own regenerated block.
    const b: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: '^Read$', hooks: [{ command: 'wrong', timeout: 1 }] }] } };
    applyWholesaleRegeneration(b, computeHookBlockDrift(b.hooks));
    const bHooks = b.hooks as Record<string, Array<{ matcher?: string }>>;
    expect(bHooks.PreToolUse.some((blk) => blk.matcher === '^Custom$')).toBe(false);
  });
});

describe('isHookBlockLocked', () => {
  it('returns true when claudeFlow.hooks.locked === true', () => {
    expect(isHookBlockLocked({ claudeFlow: { hooks: { locked: true } } })).toBe(true);
  });

  it('returns false on missing/falsy/non-object input', () => {
    expect(isHookBlockLocked({})).toBe(false);
    expect(isHookBlockLocked(null)).toBe(false);
    expect(isHookBlockLocked({ claudeFlow: {} })).toBe(false);
    expect(isHookBlockLocked({ claudeFlow: { hooks: { locked: false } } })).toBe(false);
  });
});

describe('applyAdditiveRegeneration — kept for fallback path', () => {
  it('still adds missing entries without touching extras (regression guard)', () => {
    // The launcher uses additive only when wholesale isn't exported (older
    // moflo install). Pin the legacy contract so we don't accidentally drop
    // both code paths in a future cleanup.
    const settings: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          { matcher: '^Read$', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 }] },
        ],
      },
    };
    const report = computeHookBlockDrift(settings.hooks);
    const result = applyAdditiveRegeneration(settings, report);
    expect(result.added).toBeGreaterThan(0);
  });
});

describe('formatDriftReport', () => {
  it('produces a one-line "matches" string when no drift', () => {
    const report = computeHookBlockDrift(getReferenceHookBlock());
    expect(formatDriftReport(report)).toContain('matches reference');
  });

  it('produces a multi-line summary listing missing + extra entries', () => {
    const consumer = {
      PreToolUse: [
        { matcher: '^Read$', hooks: [{ type: 'command', command: 'custom-read-handler', timeout: 1000 }] },
      ],
    };
    const report = computeHookBlockDrift(consumer);
    const formatted = formatDriftReport(report);
    expect(formatted).toContain('drift detected');
    expect(formatted).toContain('missing');
    expect(formatted).toContain('extra');
    // Human-readable: contains event names + matcher + command.
    // #1171 — Bash-shaped block matcher widened to `^(Bash|PowerShell)$`.
    expect(formatted).toMatch(/PreToolUse.*\^\(Bash\|PowerShell\)\$/);
  });
});
