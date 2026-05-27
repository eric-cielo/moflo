/**
 * #1227 — `flo init` settings.json patcher must preserve user-owned hooks.
 *
 * Before this fix, src/cli/init/moflo-init.ts:generateHooks did:
 *   - guarded on `'flo gate' || 'moflo gate'` substring (never matches modern
 *     installs — every command became `node ".../helpers/gate.cjs ..."` after
 *     the launcher's 3a migration), then
 *   - wholesale `existing.hooks = hooks` (the comment claimed "preserve
 *     existing non-MoFlo hooks" but the code did the opposite), against
 *   - an inlined canonical block that had drifted from settings-generator.ts
 *     (no swarm_init / hive-mind_init, no Stop auto-memory-hook, SessionStart
 *     launcher timeout 3000 instead of 5000).
 *
 * The combined effect on Waxstak was 6 silent deletions (2 project gates +
 * 4 stale moflo entries) + 1 timeout downgrade on every `flo init` run.
 *
 * These tests pin the post-fix invariants by driving the real initMoflo()
 * against a synthesized Waxstak-shape settings.json in a tmp directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMoflo } from '../init/moflo-init.js';

interface Hook { type: string; command: string; timeout: number }
interface Block { matcher?: string; hooks: Hook[] }
interface SettingsLike { hooks?: Record<string, Block[]>; [k: string]: unknown }

function findHook(s: SettingsLike, event: string, matcher: string, cmdContains: string): Hook | undefined {
  const arr = s.hooks?.[event];
  if (!Array.isArray(arr)) return undefined;
  for (const block of arr) {
    if ((block?.matcher ?? '') !== matcher) continue;
    const hit = block.hooks?.find(h => h.command?.includes(cmdContains));
    if (hit) return hit;
  }
  return undefined;
}

// The Waxstak-shape consumer settings.json from #1227 — modern moflo commands
// (post npx-migration) + legacy moflo slots (swarm_init/hive_init in
// PreToolUse, auto-memory in SessionEnd) + two project-owned gates that
// existed alongside on disk.
function waxstakSettings(): SettingsLike {
  return {
    hooks: {
      PreToolUse: [
        { matcher: '^Read$', hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 },
        ] },
        { matcher: '^Bash$', hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/e2e-gate.cjs"', timeout: 3000 },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-bash-memory', timeout: 2000 },
        ] },
        { matcher: '^mcp__moflo__swarm_init$', hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-swarm-init', timeout: 2000 },
        ] },
        { matcher: '^mcp__moflo__hive-mind_init$', hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-hive-init', timeout: 2000 },
        ] },
      ],
      PostToolUse: [
        { matcher: '^(Write|Edit|MultiEdit)$', hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/project-analysis-gate.cjs"', timeout: 2000 },
        ] },
      ],
      SessionStart: [
        { hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/session-start-launcher.mjs"', timeout: 5000 },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs" import', timeout: 8000 },
        ] },
      ],
      SessionEnd: [
        { hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs" sync', timeout: 10000 },
        ] },
      ],
    },
    // Project gates are documented in CLAUDE.md but moflo doesn't track them
    // in installed-files.json — exactly the case the old patcher fumbled.
  };
}

describe('moflo-init.generateHooks — #1227 Waxstak repro', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'moflo-1227-'));
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('preserves user-owned project gates that survive on disk', async () => {
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(waxstakSettings(), null, 2));

    await initMoflo({ projectRoot: tmpRoot, minimal: true });

    const after = JSON.parse(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8')) as SettingsLike;

    // Both project-owned gates from #1227 must survive — these were silently
    // deleted by the old wholesale overwrite. We don't pin the exact matcher
    // for e2e-gate.cjs because the #1171 matcher-rewrite rule widens any block
    // containing `check-bash-memory` from `^Bash$` → `^(Bash|PowerShell)$`,
    // and e2e-gate.cjs lived in that block; it rides along to the new matcher,
    // which is a feature (the user's bash gate now covers PowerShell too).
    const e2e = findHook(after, 'PreToolUse', '^Bash$', 'e2e-gate.cjs')
             ?? findHook(after, 'PreToolUse', '^(Bash|PowerShell)$', 'e2e-gate.cjs');
    expect(e2e, 'e2e-gate.cjs must survive in PreToolUse Bash/PowerShell block').toBeDefined();
    expect(e2e!.timeout, 'e2e-gate.cjs timeout must be preserved').toBe(3000);

    const projectAnalysis = findHook(after, 'PostToolUse', '^(Write|Edit|MultiEdit)$', 'project-analysis-gate.cjs');
    expect(projectAnalysis, 'project-analysis-gate.cjs must survive').toBeDefined();
    expect(projectAnalysis!.timeout, 'project-analysis-gate.cjs timeout must be preserved').toBe(2000);
  });

  it('relocates legacy moflo entries (PreToolUse swarm_init → PostToolUse, SessionEnd auto-memory → Stop)', async () => {
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(waxstakSettings(), null, 2));

    await initMoflo({ projectRoot: tmpRoot, minimal: true });

    const after = JSON.parse(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8')) as SettingsLike;

    // swarm_init / hive_init must move out of PreToolUse (their legacy slot)…
    expect(findHook(after, 'PreToolUse', '^mcp__moflo__swarm_init$', 'record-swarm-init'),
      'swarm_init must NOT remain in PreToolUse (legacy slot)').toBeUndefined();
    expect(findHook(after, 'PreToolUse', '^mcp__moflo__hive-mind_init$', 'record-hive-init'),
      'hive_init must NOT remain in PreToolUse (legacy slot)').toBeUndefined();

    // …and land in their canonical PostToolUse slot.
    expect(findHook(after, 'PostToolUse', '^mcp__moflo__swarm_init$', 'record-swarm-init'),
      'swarm_init must land in canonical PostToolUse slot').toBeDefined();
    expect(findHook(after, 'PostToolUse', '^mcp__moflo__hive-mind_init$', 'record-hive-init'),
      'hive_init must land in canonical PostToolUse slot').toBeDefined();

    // auto-memory-hook sync must move out of legacy SessionEnd…
    expect(findHook(after, 'SessionEnd', '', 'auto-memory-hook.mjs'),
      'auto-memory-hook sync must NOT remain in SessionEnd (legacy slot)').toBeUndefined();
    // …and land in canonical Stop.
    expect(findHook(after, 'Stop', '', 'auto-memory-hook.mjs'),
      'auto-memory-hook sync must land in canonical Stop slot').toBeDefined();
  });

  it('does NOT downgrade SessionStart launcher timeout (was 5000 → 3000 in old generateHooks)', async () => {
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(waxstakSettings(), null, 2));

    await initMoflo({ projectRoot: tmpRoot, minimal: true });

    const after = JSON.parse(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8')) as SettingsLike;
    const launcher = findHook(after, 'SessionStart', '', 'session-start-launcher.mjs');
    expect(launcher, 'SessionStart launcher hook must exist').toBeDefined();
    expect(launcher!.timeout, 'launcher timeout must be canonical 5000, not 3000').toBe(5000);
  });

  it('surfaces deletions in the step detail line (no silent removals)', async () => {
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(waxstakSettings(), null, 2));

    const result = await initMoflo({ projectRoot: tmpRoot, minimal: true });
    const settingsStep = result.steps.find(s => s.name === '.claude/settings.json');
    expect(settingsStep, 'settings.json step must exist').toBeDefined();
    expect(settingsStep!.status, 'status must be updated, not silently skipped').toBe('updated');

    // The step detail surfaces +canonical / -stale moflo / ✓preserved counters
    // so the user sees both what was preserved and what was removed.
    expect(settingsStep!.detail, 'detail must mention preserved count').toMatch(/✓\d+ preserved/);
    expect(settingsStep!.detail, 'detail must mention removed count').toMatch(/-\d+ stale moflo/);
  });

  it('creates canonical settings.json when none exists', async () => {
    // Fresh project — no settings.json yet. The old path also handled this but
    // wrote the drifted inlined block; the new path writes the canonical one.
    expect(existsSync(join(tmpRoot, '.claude', 'settings.json'))).toBe(false);

    await initMoflo({ projectRoot: tmpRoot, minimal: true });

    const after = JSON.parse(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8')) as SettingsLike;
    // Canonical = present in settings-generator + hook-block-hash. Spot-check
    // a handful of canonical entries to prove the right block was written.
    expect(findHook(after, 'PostToolUse', '^mcp__moflo__swarm_init$', 'record-swarm-init')).toBeDefined();
    expect(findHook(after, 'Stop', '', 'auto-memory-hook.mjs')).toBeDefined();
    expect(findHook(after, 'SessionStart', '', 'session-start-launcher.mjs')?.timeout).toBe(5000);
    expect(after.statusLine, 'statusLine must be scaffolded').toBeDefined();
  });

  it('is idempotent — second run is a no-op (status skipped)', async () => {
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(waxstakSettings(), null, 2));

    await initMoflo({ projectRoot: tmpRoot, minimal: true });
    const result2 = await initMoflo({ projectRoot: tmpRoot, minimal: true });

    const settingsStep = result2.steps.find(s => s.name === '.claude/settings.json');
    expect(settingsStep, 'settings.json step must exist on second run').toBeDefined();
    // After first run cleans up to canonical, second run sees no drift and no rewrites.
    expect(settingsStep!.status).toBe('skipped');
    expect(settingsStep!.detail).toMatch(/already at canonical/);
  });

  it('respects the moflo.hooks.locked opt-out sentinel', async () => {
    const locked = waxstakSettings();
    locked.moflo = { hooks: { locked: true } };
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(locked, null, 2));

    const result = await initMoflo({ projectRoot: tmpRoot, minimal: true });
    const settingsStep = result.steps.find(s => s.name === '.claude/settings.json');
    expect(settingsStep!.status).toBe('skipped');
    expect(settingsStep!.detail).toMatch(/locked=true|explicit opt-out/);

    // And the consumer's settings are NOT touched.
    const after = JSON.parse(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8')) as SettingsLike;
    expect(findHook(after, 'PreToolUse', '^mcp__moflo__swarm_init$', 'record-swarm-init'),
      'locked settings must be left exactly as-is').toBeDefined();
  });
});
