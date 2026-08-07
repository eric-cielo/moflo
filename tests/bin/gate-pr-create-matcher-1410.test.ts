/**
 * Gate-boundary tests for the #1410 PR-create matcher.
 *
 * pr-create-command.test.ts proves the matcher. This proves the GATES USE IT —
 * a distinction that matters here because the old regex was duplicated at two
 * call sites (`check-before-pr` and `check-before-done`) and a fix applied to
 * one of them would leave the other bypassable while every unit test stayed
 * green. Each shape is therefore asserted at both gates.
 *
 * Blocking is the gate's only signal, so the two failure directions are:
 *   - a real invocation that exits 0 → PR opens with every gate skipped, silently
 *   - quoted text that exits 2      → unrelated work is blocked
 *
 * Runs the real `bin/gate.cjs` as a subprocess with no credits earned, which is
 * the state a genuine PR-create attempt has to be refused from.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');
const GATE = resolve(REPO_ROOT, 'bin/gate.cjs');
const MATCHER = resolve(REPO_ROOT, 'bin/pr-create-command.cjs');

let root: string;

/** Run a gate script the way the hook bridge does: subcommand + TOOL_INPUT_* env. */
function runGate(script: string, sub: string, command: string) {
  const r = spawnSync(process.execPath, [script, sub], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, TOOL_INPUT_command: command },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const gate = (sub: string, command: string) => runGate(GATE, sub, command);

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const lines = (...l: string[]): string => l.join('\n');

beforeEach(() => {
  // Under the repo, not os.tmpdir(): isEphemeralPath exempts tmp-rooted projects
  // from gate behaviour these assertions depend on (#1348).
  root = resolve(REPO_ROOT, '.testoutput', `gate-1410-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pr-matcher-test', version: '0.0.0' }));
  writeFileSync(join(root, 'src.js'), 'export const safe = 1;\n');
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold handles — non-fatal */
  }
});

/** Shapes that open a PR: both gates must refuse them with no credit earned. */
const MUST_BLOCK: Array<[string, string]> = [
  ['chained (worked before #1410)', 'cd /repo && gh pr create --fill'],
  ['newline-separated', lines('cd /repo', 'gh pr create --fill')],
  ['piped body file', 'cat body.md | gh pr create --body-file -'],
  ['parenthesised subshell', '( gh pr create --fill )'],
  ['heredoc-fed body', lines('gh pr create --body-file - <<EOF', 'body text', 'EOF')],
];

/** Text that only quotes the literal: neither gate may block it. */
const MUST_PASS: Array<[string, string]> = [
  ['commit message', 'git commit -m "run cd /r && gh pr create next"'],
  ['node -e probe', `node -e 'cd /r && gh pr create'`],
  ['heredoc body', lines('cat <<EOF > notes.md', 'then cd /r && gh pr create', 'EOF')],
  ['issue body describing the form', 'gh issue create --title x --body "use cd /r && gh pr create"'],
];

describe('check-before-pr uses the #1410 matcher', () => {
  for (const [label, cmd] of MUST_BLOCK) {
    it(`blocks: ${label}`, () => {
      const r = gate('check-before-pr', cmd);
      expect(r.stderr).toContain('BLOCKED');
      expect(r.status).toBe(2);
    });
  }

  for (const [label, cmd] of MUST_PASS) {
    it(`does not block: ${label}`, () => {
      const r = gate('check-before-pr', cmd);
      expect(r.stderr).not.toContain('BLOCKED');
      expect(r.status).toBe(0);
    });
  }
});

describe('check-before-done uses the #1410 matcher', () => {
  // The second call site. It carried an identical copy of the old regex, so it
  // is the one a single-site fix would leave behind.
  for (const [label, cmd] of MUST_BLOCK) {
    it(`blocks: ${label}`, () => {
      const r = gate('check-before-done', cmd);
      expect(r.stderr).toContain('BLOCKED');
      expect(r.status).toBe(2);
    });
  }

  for (const [label, cmd] of MUST_PASS) {
    it(`does not block: ${label}`, () => {
      const r = gate('check-before-done', cmd);
      expect(r.stderr).not.toContain('BLOCKED');
      expect(r.status).toBe(0);
    });
  }
});

describe('matcher module missing — degrades, never wedges', () => {
  // gate-hook.mjs maps ANY non-zero exit from gate.cjs to exit 2, so an
  // unhandled failure to load the sibling would not degrade one gate — it would
  // block every Bash call the consumer makes. The window is real: a consumer
  // upgrading picks up gate.cjs and pr-create-command.cjs in the same sync pass,
  // and a pass that half-completes leaves exactly this state.
  function gateWithoutMatcher(sub: string, command: string) {
    const helpers = join(root, '.claude', 'helpers');
    mkdirSync(helpers, { recursive: true });
    const lone = join(helpers, 'gate.cjs');
    copyFileSync(GATE, lone);
    return runGate(lone, sub, command);
  }

  it('still refuses a PR-create command, via the legacy matcher', () => {
    const r = gateWithoutMatcher('check-before-pr', 'cd /repo && gh pr create --fill');
    expect(r.stderr).toContain('BLOCKED');
    expect(r.status).toBe(2);
  });

  it('advises on stderr rather than failing silently', () => {
    const r = gateWithoutMatcher('check-before-pr', 'cd /repo && gh pr create --fill');
    expect(r.stderr).toContain('pr-create-command.cjs unavailable');
    expect(r.stderr).toContain('flo doctor --fix');
  });

  it('does not block an ordinary command', () => {
    const r = gateWithoutMatcher('check-before-pr', 'npm test');
    expect(r.stderr).not.toContain('BLOCKED');
    expect(r.status).toBe(0);
  });

  it('recovers once the sibling is present', () => {
    const helpers = join(root, '.claude', 'helpers');
    mkdirSync(helpers, { recursive: true });
    copyFileSync(GATE, join(helpers, 'gate.cjs'));
    copyFileSync(MATCHER, join(helpers, 'pr-create-command.cjs'));
    // A shape only the new matcher catches — proof the sibling is the one answering.
    const r = runGate(join(helpers, 'gate.cjs'), 'check-before-pr', lines('cd /repo', 'gh pr create --fill'));
    expect(r.stderr).not.toContain('unavailable');
    expect(r.stderr).toContain('BLOCKED');
    expect(r.status).toBe(2);
  });
});

describe('shipped copies stay in step', () => {
  // gate.cjs ships from two places and the matcher now does too. The dogfood
  // parity guard covers bin/ -> .claude/, this covers the manifest that makes
  // the sync happen at all — without the entry, consumers get the new gate.cjs
  // and no sibling, i.e. the degraded path above, forever.
  it('lists the matcher in the shipped-scripts manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'bin/lib/shipped-scripts.json'), 'utf-8'));
    expect(manifest.binHelperFiles).toContain('pr-create-command.cjs');
  });

  it('leaves no inline PR-create regex behind in either gate copy', () => {
    for (const p of ['bin/gate.cjs', '.claude/helpers/gate.cjs']) {
      const src = readFileSync(resolve(REPO_ROOT, p), 'utf-8');
      // One occurrence only: the named legacy fallback constant.
      const hits = src.match(/gh\\s\+pr\\s\+create/g) || [];
      expect(hits, `${p} should reference the legacy regex exactly once`).toHaveLength(1);
      expect(src).toContain('LEGACY_PR_CREATE_RE');
      expect(src).toContain("require('./pr-create-command.cjs')");
    }
  });
});
