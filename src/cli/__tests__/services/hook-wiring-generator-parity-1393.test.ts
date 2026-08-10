/**
 * Structural drift guard — #1393 (Epic #1392).
 *
 * The same hook wiring is duplicated across three files:
 *
 *   1. `init/settings-generator.ts`  — what a FRESH `flo init` writes
 *   2. `services/hook-block-hash.ts` — block-hash bookkeeping
 *   3. `services/hook-wiring.ts`     — what `repairHookWiring()` grafts into
 *                                      an EXISTING project on session start
 *
 * Only (1) runs on `flo init`; only (3) runs on upgrade. A hook added to (1)
 * alone reaches new consumers and silently never reaches upgraded ones.
 *
 * That is exactly how #1332 shipped: `record-verify-outcome` was wired in the
 * generator only, so every project that upgraded rather than re-running
 * `flo init` got a verify-before-done gate it could not satisfy — `/verify`
 * stored a correct PASS verdict, nothing transcribed it into
 * workflow-state.json, and the only escape was disabling the gate outright.
 * `flo doctor` reported hook wiring healthy throughout, because the healer
 * re-exports the same incomplete list.
 *
 * settings-generator.ts carried a comment warning that the three copies must
 * not drift. A comment is not a guard. This is the guard.
 *
 * See `.claude/guidance/internal/upgrade-contract.md`
 *   § "Design for the upgrade path first — it is never an afterthought".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REQUIRED_HOOK_WIRING, HOOK_ENTRY_MAP, repairHookWiring } from '../../services/hook-wiring.js';
import { getReferenceHookBlock } from '../../services/hook-block-hash.js';

const GENERATOR_PATH = join(__dirname, '..', '..', 'init', 'settings-generator.ts');

/**
 * Gate subcommands the generator emits that are deliberately NOT repaired into
 * existing consumers. Every entry needs a reason and an issue number — an
 * unexplained exclusion is indistinguishable from the drift this guard exists
 * to catch.
 */
const DELIBERATELY_NOT_REPAIRED: Record<string, string> = {
  // #1227 — advisory-only pre-implementation nudge. Fresh installs get it; it is
  // not load-bearing for any gate, so it is not worth a settings.json write on
  // every existing consumer.
  'check-before-implement': '#1227 — advisory only; not gate-load-bearing',
  // #1393 — emitted CONDITIONALLY (`if (config.preCompact)` in the generator),
  // unlike every other entry here. REQUIRED_HOOK_WIRING has no notion of a
  // condition, so listing it would force the PreCompact hook back on for
  // consumers who deliberately set `preCompact: false`. It is guidance emission,
  // not a gate, so its absence degrades quality rather than deadlocking a run.
  // Repairing config-conditional hooks needs a conditional repair mechanism —
  // tracked separately rather than bodged in here.
  'compact-guidance': '#1393 — config-conditional (config.preCompact); repairing it would override an opt-out',
};

// NOTE: `check-task-transition` is deliberately NOT listed. #1331 removed it from
// the generator as well, so it never reaches this comparison — and the
// "stale exclusion" test below fails if someone re-adds it here out of caution.

/**
 * Extract every `gateCmd('x')` / `gateHookCmd('x')` subcommand the generator emits.
 *
 * Read as source text rather than by invoking generateSettings(): the guard must
 * catch a hook that is emitted under a conditional branch (an option flag, a
 * platform check) which a single generateSettings() call would not exercise.
 */
function generatorGateSubcommands(): Set<string> {
  const src = readFileSync(GENERATOR_PATH, 'utf-8');
  const found = new Set<string>();
  for (const m of src.matchAll(/\bgate(?:Hook)?Cmd\(\s*'([^']+)'\s*\)/g)) {
    found.add(m[1]);
  }
  return found;
}

describe('#1393 — settings-generator ↔ hook-wiring parity', () => {
  it('finds gate subcommands in the generator (guard is actually looking at something)', () => {
    // Self-check: a regex that silently matches nothing would make every
    // assertion below vacuously pass.
    expect(generatorGateSubcommands().size).toBeGreaterThan(10);
  });

  it('every gate hook the generator emits is either repaired into existing projects or explicitly excluded', () => {
    const required = new Set(REQUIRED_HOOK_WIRING.map(h => h.pattern));
    const unreachable = [...generatorGateSubcommands()]
      .filter(cmd => !required.has(cmd))
      .filter(cmd => !(cmd in DELIBERATELY_NOT_REPAIRED));

    expect(
      unreachable,
      `These hooks are written by \`flo init\` but never grafted into an existing ` +
      `project by repairHookWiring(), so consumers who UPGRADE never get them:\n` +
      unreachable.map(c => `  - ${c}`).join('\n') +
      `\n\nFix by adding each to REQUIRED_HOOK_WIRING + HOOK_ENTRY_MAP in ` +
      `services/hook-wiring.ts, or — if it genuinely should not be repaired — to ` +
      `DELIBERATELY_NOT_REPAIRED in this file with an issue number and a reason.`,
    ).toEqual([]);
  });

  it('every REQUIRED_HOOK_WIRING pattern has a HOOK_ENTRY_MAP entry', () => {
    // Without the map entry, repairHookWiring() hits `if (!entry) continue` and
    // skips the hook — listing the pattern alone repairs nothing. This is the
    // second half of how #1332's gap survived review.
    const missing = REQUIRED_HOOK_WIRING
      .map(h => h.pattern)
      .filter(p => !HOOK_ENTRY_MAP[p]);

    expect(
      missing,
      `Listed in REQUIRED_HOOK_WIRING but absent from HOOK_ENTRY_MAP — ` +
      `repairHookWiring() will silently skip these: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * Presence parity is not enough — the EVENT has to match too, and it had
   * drifted. `check-bash-memory` was listed here under `PostToolUse` while the
   * generator and the reference block put it under `PreToolUse`, where #1132
   * deliberately moved it so its `process.exit(2)` prevents the read rather than
   * reporting one that already happened. Because the presence check is a raw
   * substring scan over settings.json, the mismatch was invisible on every
   * project that already had the hook; it would only bite a consumer missing it
   * entirely, who would then be "repaired" into a gate that cannot block.
   */
  it('every repaired pattern is grafted under the same event the reference block uses', () => {
    const reference = getReferenceHookBlock();
    const eventOf = (pattern: string): string | undefined =>
      Object.keys(reference).find(event =>
        (reference[event] ?? []).some(block =>
          (block.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes(pattern)),
        ),
      );

    const mismatched = Object.keys(HOOK_ENTRY_MAP)
      .map(pattern => ({ pattern, mapped: HOOK_ENTRY_MAP[pattern].event, reference: eventOf(pattern) }))
      .filter(r => r.reference !== undefined && r.reference !== r.mapped)
      .map(r => `${r.pattern}: HOOK_ENTRY_MAP=${r.mapped} but reference block=${r.reference}`);

    expect(
      mismatched,
      `repairHookWiring() would graft these under the wrong hook event:\n  ${mismatched.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every DELIBERATELY_NOT_REPAIRED entry is still emitted by the generator', () => {
    // Keeps the exclusion list honest: once the generator stops emitting a hook,
    // its exclusion is dead weight that would mask a real future drift.
    const emitted = generatorGateSubcommands();
    const stale = Object.keys(DELIBERATELY_NOT_REPAIRED).filter(c => !emitted.has(c));

    expect(
      stale,
      `Excluded here but no longer emitted by settings-generator.ts — remove the ` +
      `stale exclusion: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('record-verify-outcome is repaired into existing projects and routes via gate-hook.mjs (#1393)', () => {
    // The regression under test. Routing matters as much as presence: the
    // TOOL_INPUT_* env vars gate.cjs reads are built by gate-hook.mjs from the
    // hook's stdin payload, so a direct gate.cjs invocation would fire and
    // record nothing — the gate would stay closed with the hook "present".
    expect(REQUIRED_HOOK_WIRING.map(h => h.pattern)).toContain('record-verify-outcome');

    const entry = HOOK_ENTRY_MAP['record-verify-outcome'];
    expect(entry).toBeDefined();
    expect(entry.event).toBe('PostToolUse');
    expect(entry.matcher).toBe('^mcp__moflo__memory_store$');
    expect(entry.hook.command).toContain('gate-hook.mjs');
    expect(entry.hook.command).not.toMatch(/gate\.cjs/);
  });
});

/**
 * The upgrade path itself — the point of the story. A pre-#1332 consumer has the
 * `^mcp__moflo__memory_store$` block WITH record-learnings-stored and WITHOUT
 * record-verify-outcome. Repair must append into that existing block.
 */
describe('#1393 — a pre-#1332 project self-heals on session start', () => {
  /** Settings as `flo init` wrote them before #1332 added the transcriber. */
  function preFixSettings(): Record<string, unknown> {
    return {
      hooks: {
        PostToolUse: [
          {
            matcher: '^mcp__moflo__memory_store$',
            hooks: [{
              type: 'command',
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-learnings-stored',
              timeout: 2000,
            }],
          },
        ],
      },
    };
  }

  function commandsFor(settings: Record<string, unknown>, matcher: string): string[] {
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    return (hooks.PostToolUse || [])
      .filter(b => b.matcher === matcher)
      .flatMap(b => (b.hooks as Array<{ command: string }>) || [])
      .map(h => h.command);
  }

  it('grafts record-verify-outcome into the existing memory_store block', () => {
    const settings = preFixSettings();
    const { repaired } = repairHookWiring(settings);

    expect(repaired).toContain('record-verify-outcome');

    const cmds = commandsFor(settings, '^mcp__moflo__memory_store$');
    expect(cmds.some(c => c.includes('record-verify-outcome'))).toBe(true);
    // Appended, not replaced — the consumer's existing hook survives.
    expect(cmds.some(c => c.includes('record-learnings-stored'))).toBe(true);
  });

  it('does not create a second memory_store block', () => {
    const settings = preFixSettings();
    repairHookWiring(settings);

    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    const blocks = hooks.PostToolUse.filter(b => b.matcher === '^mcp__moflo__memory_store$');
    expect(blocks).toHaveLength(1);
  });

  it('is idempotent — a second session start changes nothing', () => {
    const settings = preFixSettings();
    repairHookWiring(settings);
    const afterFirst = JSON.stringify(settings);

    const { repaired } = repairHookWiring(settings);

    expect(repaired).not.toContain('record-verify-outcome');
    expect(JSON.stringify(settings)).toBe(afterFirst);
  });

  it('routes the grafted hook through gate-hook.mjs, so it can actually see the verdict', () => {
    // Presence is not enough. gate.cjs reads TOOL_INPUT_* env vars that
    // gate-hook.mjs builds from the hook's stdin payload; wired directly to
    // gate.cjs the hook fires and records nothing, leaving the gate shut with
    // the wiring looking correct.
    const settings = preFixSettings();
    repairHookWiring(settings);

    const cmd = commandsFor(settings, '^mcp__moflo__memory_store$')
      .find(c => c.includes('record-verify-outcome'));
    expect(cmd).toContain('gate-hook.mjs');
  });

  it('grafts the swarm/hive MCP recorders that #1338 left behind', () => {
    // Same defect class, protected surface: without these, check-before-agent
    // blocks every Agent spawn under `/fl -s` and `/fl -h` on an upgraded
    // project, and the MCP init call that should release it credits nothing.
    const settings = preFixSettings();
    const { repaired } = repairHookWiring(settings);

    expect(repaired).toContain('record-swarm-init');
    expect(repaired).toContain('record-hive-init');
    expect(commandsFor(settings, '^mcp__moflo__swarm_init$')
      .some(c => c.includes('record-swarm-init'))).toBe(true);
    expect(commandsFor(settings, '^mcp__moflo__hive-mind_init$')
      .some(c => c.includes('record-hive-init'))).toBe(true);
  });
});
