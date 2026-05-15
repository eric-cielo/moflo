/**
 * Regression tests for issue #1142 — launcher auto-refreshes the consumer's
 * `<root>/CLAUDE.md` MoFlo block when it drifts from the current generator,
 * mirrored across `bin/session-start-launcher.mjs` and its synced
 * `.claude/scripts/` copy.
 *
 * Source-invariant tests (same pattern as #896 / launcher-896-hook-drift-
 * regenerate.test.ts) because the launcher itself spawns background workers
 * via `spawn(detached + unref)` and isn't easily invoked in-process. The
 * end-to-end behaviour of the drift detector + repair is covered in the
 * shared-service tests (services/claudemd-injection.test.ts) and the doctor
 * check tests (doctor-claudemd-injection-drift.test.ts) which exercise the
 * exact same code path through the same dynamic imports.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

describe.each([
  ['bin/session-start-launcher.mjs', resolve(ROOT, 'bin', 'session-start-launcher.mjs')],
  ['.claude/scripts/session-start-launcher.mjs', resolve(ROOT, '.claude', 'scripts', 'session-start-launcher.mjs')],
])('%s — CLAUDE.md injection drift (#1142)', (_label, file) => {
  const src = readFileSync(file, 'utf-8');

  it('reads the claudemd_injection_drift YAML knob (warn|regenerate|off)', () => {
    // Source string carries a literal regex with the alternation; assert the
    // alternation is wired so a future refactor can't silently drop a mode.
    expect(src).toContain('claudemd_injection_drift:');
    expect(src).toContain('(warn|regenerate|off)');
    expect(src).toContain('claudemdInjectionDrift');
  });

  it('defaults the drift mode to regenerate (consumer cannot refresh on their own)', () => {
    // Pin the default — flipping it to 'warn' would mean stale CLAUDE.md
    // injection content persists forever for any consumer who never re-runs
    // init. The whole point of #1142 was to make this self-healing.
    const initLine = src.match(/claudemdInjectionDrift:\s*'(warn|regenerate|off)'/);
    expect(initLine, 'autoUpdateConfig must initialise claudemdInjectionDrift').toBeTruthy();
    expect(initLine![1]).toBe('regenerate');
  });

  it('defines runClaudeMdInjectionDriftCheck and gates it on auto_update.enabled', () => {
    expect(src).toMatch(/async\s+function\s+runClaudeMdInjectionDriftCheck/);
    expect(src).toMatch(/claudemdInjectionDrift\s*!==\s*'off'/);
    expect(src).toMatch(/autoUpdateConfig\.enabled\s*&&\s*autoUpdateConfig\.claudemdInjectionDrift\s*!==\s*'off'/);
  });

  it('runs the two drift detectors in parallel (Promise.all)', () => {
    // Cold-path latency matters on every consumer install. The two detectors
    // touch independent files and cache files, so they must be awaited via
    // Promise.all, not in series. The hook-drift call has two occurrences
    // (definition + caller); use indexOf-from for the caller occurrence.
    expect(src).toMatch(/Promise\.all\(\[/);
    const idxPromiseAll = src.indexOf('Promise.all([');
    expect(idxPromiseAll).toBeGreaterThan(0);
    // The actual invocations both need to land inside the Promise.all block.
    // .indexOf(needle, fromIndex) finds the first occurrence at or after fromIndex.
    const idxHookCall = src.indexOf('runHookBlockDriftCheck()', idxPromiseAll);
    const idxClaudemdCall = src.indexOf('runClaudeMdInjectionDriftCheck()', idxPromiseAll);
    expect(idxHookCall, 'hook check must be invoked inside Promise.all').toBeGreaterThan(idxPromiseAll);
    expect(idxClaudemdCall, 'claudemd check must be invoked inside Promise.all').toBeGreaterThan(idxPromiseAll);
  });

  it('imports the shared claudemd-injection service from dist (consumer + dev paths)', () => {
    // Both candidates must be checked so the launcher works from a consumer
    // node_modules install AND from the moflo dev source tree (#1057).
    expect(src).toMatch(/node_modules\/moflo\/dist\/src\/cli\/services\/claudemd-injection\.js/);
    expect(src).toMatch(/dist\/src\/cli\/services\/claudemd-injection\.js/);
    // And the generator.
    expect(src).toMatch(/node_modules\/moflo\/dist\/src\/cli\/init\/claudemd-generator\.js/);
    expect(src).toMatch(/dist\/src\/cli\/init\/claudemd-generator\.js/);
  });

  it('writes a cache file so the check is ~free in the steady state', () => {
    expect(src).toMatch(/claudemd-injection-cache\.json/);
    // Cache short-circuits on any (claudeMdMtime, moduleMtime, state) triple
    // match — not just 'in-sync' — so drifted consumers in warn mode also
    // skip the slow path after first detection.
    expect(src).toMatch(/typeof cached\.state\s*===\s*'string'/);
  });

  it('emits a visible mutation message when it repairs the block', () => {
    // emitMutation pipes to stdout which Claude picks up via additionalContext
    // — without this the user has no signal that CLAUDE.md changed.
    expect(src).toMatch(/emitMutation\(\s*'refreshed CLAUDE\.md MoFlo block'/);
  });

  it('falls back to warn when warn mode is configured (no silent skip)', () => {
    // Warn mode must surface SOMETHING — silent no-op would leave the user
    // unaware their CLAUDE.md is stale.
    expect(src).toMatch(/CLAUDE\.md injection.*run.*flo doctor claudemd-drift/);
  });

  it('never auto-creates the MoFlo block when no marker pair exists (no-marker)', () => {
    // Re-adding a removed block on every session start would surprise users
    // who deliberately removed it. The launcher only repairs drift/legacy,
    // not no-marker.
    const noMarkerMessage = src.match(/CLAUDE\.md has no MoFlo injection block/);
    expect(noMarkerMessage, 'no-marker case must emit a warn-style nudge, not auto-write').toBeTruthy();
  });
});
