/**
 * Regression: `check-task-transition` must stay UNWIRED (#1331).
 *
 * The gate case is an intentional no-op, but it was wired to `^TaskUpdate$` in
 * every consumer `flo init` touched — so each TaskUpdate spawned gate-hook.mjs,
 * which `execFileSync`'d gate.cjs, which fell straight through to `break`. Two
 * process spawns per task update, per consumer, to do nothing.
 *
 * Removing it needs FOUR copies to agree, because three separate mechanisms
 * will each re-graft the hook on a consumer's next session start if their copy
 * still lists it:
 *
 *   1. `settings-generator.ts`  — what `flo init` writes for a new project
 *   2. `hook-block-hash.ts`     — the reference block the launcher regenerates against
 *   3. `hook-wiring.ts`         — `repairHookWiring()`'s missing-hook repair table
 *   4. `.claude/settings.json`  — this repo's own (dogfood) copy
 *
 * These assertions pin all of them. The gate CASE is deliberately retained —
 * see the separate assertion at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getReferenceHookBlock, type HookBlock } from '../../services/hook-block-hash.js';
import { REQUIRED_HOOK_WIRING, HOOK_ENTRY_MAP } from '../../services/hook-wiring.js';
import { generateSettings } from '../../init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../../init/types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Every hook command in a hooks tree, flattened. */
function allCommands(hooks: Record<string, HookBlock[]>): string[] {
  return Object.values(hooks).flatMap(blocks =>
    (blocks ?? []).flatMap(b => (b?.hooks ?? []).map(h => h.command)),
  );
}

/** Matchers present anywhere in a hooks tree. */
function allMatchers(hooks: Record<string, HookBlock[]>): string[] {
  return Object.values(hooks).flatMap(blocks => (blocks ?? []).map(b => b?.matcher ?? ''));
}

describe('#1331 — check-task-transition is not wired', () => {
  it('flo init emits no ^TaskUpdate$ hook block', () => {
    const settings = generateSettings(DEFAULT_INIT_OPTIONS) as {
      hooks: Record<string, HookBlock[]>;
    };
    expect(allMatchers(settings.hooks)).not.toContain('^TaskUpdate$');
    expect(allCommands(settings.hooks).join('\n')).not.toContain('check-task-transition');
  });

  it('the launcher reference block has no ^TaskUpdate$ entry', () => {
    // Load-bearing: an entry here is reported as `missing` against every
    // consumer and grafted back by additive/wholesale regeneration.
    const reference = getReferenceHookBlock();
    expect(allMatchers(reference)).not.toContain('^TaskUpdate$');
    expect(allCommands(reference).join('\n')).not.toContain('check-task-transition');
  });

  it('repairHookWiring tables do not list check-task-transition', () => {
    // Load-bearing: REQUIRED_HOOK_WIRING drives repairHookWiring(), which runs
    // AFTER the drift sweep — a stale entry here would re-add the hook that
    // wholesale regeneration had just removed.
    expect(REQUIRED_HOOK_WIRING.map(r => r.pattern)).not.toContain('check-task-transition');
    expect(HOOK_ENTRY_MAP['check-task-transition']).toBeUndefined();
  });

  // NOTE: there is deliberately NO assertion on this repo's live
  // `.claude/settings.json`. That file is a DERIVED artifact, not source — the
  // session-start launcher regenerates it from the reference block in the
  // INSTALLED `node_modules/moflo`, which until this change is published still
  // carries the `^TaskUpdate$` entry. So the committed removal is re-added
  // locally on every session start, and an assertion here would go red on a
  // correct tree. The three source copies above are what actually ship and are
  // what the launcher will regenerate FROM once published.

  it('retains the gate.cjs case so doctor Gate Health stays green', () => {
    // The case is intentionally kept: doctor-checks-deep.ts lists
    // check-task-transition in REQUIRED_GATE_CASES, so removing it would turn
    // the Gate Health check red in every consumer for no benefit. Both shipped
    // copies must carry it (byte parity itself is guarded separately).
    for (const rel of [['bin', 'gate.cjs'], ['.claude', 'helpers', 'gate.cjs']]) {
      const src = readFileSync(join(REPO_ROOT, ...rel), 'utf-8');
      expect(src).toContain("case 'check-task-transition':");
    }
  });

  it('keeps the launcher npx→node migration row for the retired command', () => {
    // Deliberately NOT deleted with the wiring: the drift sweep only classifies
    // a stale entry as moflo-owned (and therefore droppable) when its command
    // points at a `.claude/helpers|scripts/<basename>` path. An ancient consumer
    // still on the `npx flo gate check-task-transition` form must be migrated to
    // that shape FIRST, or the sweep preserves it as a user customisation.
    const launcher = readFileSync(join(REPO_ROOT, 'bin', 'session-start-launcher.mjs'), 'utf-8');
    expect(launcher).toContain('npx flo gate check-task-transition');
  });
});
