/**
 * #1394 + #1395 (Epic #1392) — gate.cjs behaviour around the verify transcriber.
 *
 * #1394: `check-before-done` must distinguish "the agent skipped Step 5" from
 *        "the hook that transcribes the verdict is not wired". They need opposite
 *        remedies; the old single message fit only the first, so a correct verdict
 *        read as agent error and the prescribed fix (re-run /verify) could never
 *        work.
 * #1395: editing `.claude/` CONFIG must not reset the verify/test/simplify gates —
 *        otherwise repairing hook wiring on a gate's own instruction invalidates
 *        the verification the repair existed to permit.
 *
 * Both assertions are made against the SHIPPED `bin/gate.cjs` source, and the
 * three copies are asserted identical, because the copy that actually runs in a
 * consumer is the synced one — not this repo's source tree.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const BIN_GATE = join(REPO_ROOT, 'bin', 'gate.cjs');
const HELPERS_GATE = join(REPO_ROOT, '.claude', 'helpers', 'gate.cjs');

const gateSrc = readFileSync(BIN_GATE, 'utf-8');

/**
 * Pull the live EDIT_RESET_SKIP_PATH_RE out of the shipped source and evaluate
 * it, rather than restating the pattern here. A copy of the regex in the test
 * would keep passing after the real one regressed.
 */
function editResetSkipRe(): RegExp {
  const m = gateSrc.match(/^var EDIT_RESET_SKIP_PATH_RE = (\/.*\/i);$/m);
  if (!m) throw new Error('EDIT_RESET_SKIP_PATH_RE not found in bin/gate.cjs');
  // eslint-disable-next-line no-eval
  return eval(m[1]) as RegExp;
}

describe('#1395 — .claude config edits do not reset the gates', () => {
  const re = editResetSkipRe();

  // Both separators everywhere: TOOL_INPUT paths arrive backslashed on Windows,
  // and a POSIX-only pattern would silently never match there (Rule #1).
  const exempt = [
    '.claude/settings.json',
    '.claude\\settings.json',
    '.claude/settings.local.json',
    'repo/.claude/settings.json',
    '.claude/skills/fl/SKILL.md',
    '.claude\\skills\\fl\\SKILL.md',
    '.claude/guidance/internal/upgrade-contract.md',
    '.claude/agents/reviewer.md',
  ];
  for (const p of exempt) {
    it(`exempts ${p}`, () => {
      expect(re.test(p)).toBe(true);
    });
  }

  // The invariant #1395 must NOT break: editing executable code still
  // invalidates a verification, including executable code under .claude/.
  const stillResets = [
    'src/cli/services/hook-wiring.ts',
    'bin/gate.cjs',
    '.claude/scripts/index-all.mjs',
    '.claude\\scripts\\index-all.mjs',
    '.claude/helpers/gate.cjs',
    '.claude/helpers/gate-hook.mjs',
  ];
  for (const p of stillResets) {
    it(`still resets on ${p}`, () => {
      expect(re.test(p)).toBe(false);
    });
  }

  it('does not exempt a .claude-prefixed path outside the directory', () => {
    // Guards against an unanchored alternative matching e.g. `src/.claudex/`.
    expect(re.test('src/.claudex/settings.json')).toBe(false);
    expect(re.test('myclaude/settings.json')).toBe(false);
  });

  it('keeps the pre-existing #1176/#1348 exemptions', () => {
    expect(re.test('.github/workflows/ci.yml')).toBe(true);
    expect(re.test('.github/PULL_REQUEST_TEMPLATE.md')).toBe(true);
    expect(re.test('.moflo/specs/foo/plan.md')).toBe(true);
    expect(re.test('src/index.ts')).toBe(false);
  });
});

describe('#1394 — check-before-done names the real cause', () => {
  it('defines isVerifyOutcomeHookWired', () => {
    expect(gateSrc).toContain('function isVerifyOutcomeHookWired()');
  });

  it('branches the no-verdict message on whether the hook is wired', () => {
    expect(gateSrc).toContain('if (!isVerifyOutcomeHookWired())');
    expect(gateSrc).toContain('`record-verify-outcome` is not wired in .claude/settings.json');
  });

  it('prescribes flo doctor --fix and a restart, not a futile /verify re-run', () => {
    const idx = gateSrc.indexOf('is not wired in .claude/settings.json');
    const branch = gateSrc.slice(idx, idx + 600);
    expect(branch).toContain('flo doctor --fix');
    expect(branch).toContain('restart the session');
    expect(branch).toContain('will not help');
  });

  it('keeps the original Step 5 message for the genuinely-missing-verdict case', () => {
    expect(gateSrc).toContain('Step 5 of the verify skill must pass metadata.overall to memory_store');
    expect(gateSrc).toContain('Re-invoking /verify clears the prior verdict');
  });

  it('falls back to the generic message when settings.json is unreadable', () => {
    // The catch must return TRUE ("assume wired"), so a parse failure produces
    // the pre-existing message rather than asserting a wiring bug that may not
    // exist. Returning false here would make every malformed-settings project
    // see a confident, wrong diagnosis.
    const fn = gateSrc.slice(
      gateSrc.indexOf('function isVerifyOutcomeHookWired()'),
      gateSrc.indexOf('function isVerifyOutcomeHookWired()') + 500,
    );
    expect(fn).toMatch(/catch \(e\) \{ return true; \}/);
  });

  it('reads settings lazily, not at module scope', () => {
    // check-before-done is the only caller and only on an already-blocked path.
    // Hoisting the read would add a syscall to every Write/Edit in every consumer.
    expect(gateSrc).not.toMatch(/^var VERIFY_HOOK_WIRED = /m);
  });
});

describe('gate.cjs copies stay in sync (consumer runs the synced copy)', () => {
  it('bin/gate.cjs and .claude/helpers/gate.cjs are byte-identical', () => {
    expect(readFileSync(HELPERS_GATE, 'utf-8')).toBe(gateSrc);
  });

  /**
   * The generator holds a THIRD copy of this regex, hand-escaped for a TS
   * template literal (`[\\\/]` becomes `[\\\\\\/]`). Double-escaping is silent
   * when wrong: the pattern still compiles, it just stops matching. Compare the
   * compiled sources so a mis-escape fails here instead of in a consumer.
   */
  /** Built once — both assertions below read the same generated source. */
  let generated: string;
  beforeAll(async () => {
    const { generateGateScript } = await import(
      join(REPO_ROOT, 'dist', 'src', 'cli', 'init', 'helpers-generator.js')
    );
    generated = generateGateScript();
  });

  it('helpers-generator emits the same EDIT_RESET_SKIP_PATH_RE as bin/gate.cjs (#1395)', () => {
    const m = generated.match(/^var EDIT_RESET_SKIP_PATH_RE = (\/.*\/i);$/m);
    expect(m, 'EDIT_RESET_SKIP_PATH_RE missing from generated gate.cjs').toBeTruthy();

    // eslint-disable-next-line no-eval
    const generatedRe = eval(m![1]) as RegExp;
    expect(generatedRe.source).toBe(editResetSkipRe().source);
  });

  it('helpers-generator emits the #1394 wiring branch', () => {
    expect(generated).toContain('function isVerifyOutcomeHookWired()');
    expect(generated).toContain('is not wired in .claude/settings.json');
  });
});
