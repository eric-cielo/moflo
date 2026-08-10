/**
 * #1434 — the learnings gate must not manufacture filler.
 *
 * `check-before-pr` blocked `gh pr create` until SOME `memory_store` had run in
 * the session, and credited any write regardless of namespace or content. A run
 * that produced no reusable lesson therefore had exactly one way through: write
 * a summary of itself. That summary is audit exhaust — one ticket, one commit,
 * applicable never again — and `memory_search` returns a BOUNDED result set, so
 * each one permanently displaces a reusable lesson from every future search.
 * The cost is retrieval quality, not disk.
 *
 * Two halves are asserted here:
 *   1. Declaring "no durable lesson" satisfies the gate without a write, so the
 *      honest outcome of a run that learned nothing is reachable.
 *   2. The block message names the durability bar AND that escape. An escape
 *      hatch nobody can find is not an escape hatch (#1332's gate deadlock),
 *      and a message naming only the mechanism ("call memory_store") is what
 *      made the filler write the cheapest path in the first place.
 *
 * Assertions run against the SHIPPED `bin/gate.cjs` — the copy a consumer runs
 * is the synced one, not this repo's source tree — plus the generator that
 * writes gate.cjs into a fresh project, which is a third copy of the same logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve, join, isAbsolute } from 'path';

import { generateGateScript } from '../../src/cli/init/helpers-generator.js';

const REPO_ROOT = resolve(__dirname, '../..');
const GATE = resolve(REPO_ROOT, 'bin/gate.cjs');
const PR_CMD = { TOOL_INPUT_command: 'gh pr create --title x --body y' };

let root: string;

/** Run gate.cjs the way the hook bridge does: command + TOOL_INPUT_* env. */
function gate(cmd: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [GATE, cmd], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function readStateFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.claude', 'workflow-state.json'), 'utf-8'));
}

/**
 * Earn every PR credit EXCEPT learnings, through the real recorders, against the
 * already-dirty tree — credits are fingerprinted to the code they describe
 * (#1366), so they must be earned after the source edit or they expire and the
 * block message reports gates this test is not about.
 */
function earnCreditsExceptLearnings() {
  gate('record-skill-run', { TOOL_INPUT_skill: 'flo-simplify' });
  gate('record-test-run', {
    TOOL_INPUT_command: 'npm test',
    TOOL_RESPONSE_stdout: 'Test Files 3 passed (3)\nTests 42 passed (42)',
  });
  gate('record-skill-run', { TOOL_INPUT_skill: 'verify' });
  gate('record-verify-run', { TOOL_INPUT_skill: 'verify' });
}

beforeEach(() => {
  // Deliberately NOT under os.tmpdir(): isEphemeralPath exempts tmp-rooted
  // projects from gate resets (#1348), which would mask what these assert.
  root = resolve(REPO_ROOT, '.testoutput', `gate-1434-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'nl-test', version: '0.0.0' }));
  writeFileSync(join(root, 'src.js'), 'export const safe = 1;\n');
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'init');
  // A real source change, so the no-source-files exemption does not skip the
  // pre-PR gates outright and leave every assertion below vacuous.
  appendFileSync(join(root, 'src.js'), 'export const added = 2;\n');
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold handles — non-fatal */
  }
});

describe('#1434 declaring no durable lesson satisfies the learnings gate', () => {
  it('credits the gate without any memory_store', () => {
    const r = gate('record-no-durable-lesson');
    expect(r.status).toBe(0);
    expect(readStateFile().learningsStored).toBe(true);
  });

  it('says so on stdout, so the declaration is visible rather than silent', () => {
    const r = gate('record-no-durable-lesson');
    expect(r.stdout).toContain('no durable lesson');
    // Names where the run summary DOES belong — the redirect is the point.
    expect(r.stdout.toLowerCase()).toContain('pr body');
  });

  it('lets gh pr create through with no learnings write at all', () => {
    earnCreditsExceptLearnings();
    expect(gate('check-before-pr', PR_CMD).stderr).toContain('BLOCKED');

    gate('record-no-durable-lesson');
    const after = gate('check-before-pr', PR_CMD);
    expect(after.stderr).not.toContain('BLOCKED');
    expect(after.status).toBe(0);
  });

  it('is idempotent and leaves the other credits untouched', () => {
    earnCreditsExceptLearnings();
    const before = readStateFile();
    gate('record-no-durable-lesson');
    gate('record-no-durable-lesson');
    const after = readStateFile();
    expect(after.learningsStored).toBe(true);
    expect(after.testsRun).toBe(before.testsRun);
    expect(after.simplifyRun).toBe(before.simplifyRun);
    expect(after.verifyRun).toBe(before.verifyRun);
  });
});

describe('#1434 the block message teaches the bar, not just the mechanism', () => {
  it('states the durability bar when learnings are missing', () => {
    earnCreditsExceptLearnings();
    const { stderr } = gate('check-before-pr', PR_CMD);
    expect(stderr).toContain('durable lesson');
    // The bar itself — a lesson must transfer to a DIFFERENT task.
    expect(stderr).toContain('DIFFERENT task');
  });

  it('names the no-write escape, so the filler write is never the cheapest path', () => {
    earnCreditsExceptLearnings();
    const { stderr } = gate('check-before-pr', PR_CMD);
    expect(stderr).toContain('record-no-durable-lesson');
  });

  /**
   * The escape is typed by the model into a Bash tool, where $CLAUDE_PROJECT_DIR
   * is NOT set (that is a hook-only variable) and the cwd is not guaranteed to be
   * the project root. Asserting only that the case name appears would pass on a
   * command that cannot run — so run the printed command itself, from a cwd that
   * is deliberately not the project root.
   */
  it('prints a command that actually runs from an unrelated cwd', () => {
    earnCreditsExceptLearnings();
    const { stderr } = gate('check-before-pr', PR_CMD);

    const printed = stderr.match(/node "([^"]+)" record-no-durable-lesson/);
    expect(printed, 'block message must print an absolute, quoted script path').not.toBeNull();
    expect(isAbsolute(printed![1])).toBe(true);
    expect(stderr).not.toContain('$CLAUDE_PROJECT_DIR');

    const r = spawnSync(process.execPath, [printed![1], 'record-no-durable-lesson'], {
      cwd: REPO_ROOT, // deliberately NOT the fixture project root
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    expect(r.status).toBe(0);
    expect(readStateFile().learningsStored).toBe(true);
  });

  it('redirects run narration to the PR body', () => {
    earnCreditsExceptLearnings();
    const { stderr } = gate('check-before-pr', PR_CMD);
    expect(stderr).toContain('PR body');
  });
});

/**
 * The generated copy is the one a FRESH `flo init` writes, and every existing
 * test of it only string-matches the source. A syntax error inside the template
 * literal — a mis-escaped `\n`, an unbalanced brace — would therefore ship to
 * every new consumer project undetected. Run it for real instead.
 */
describe('#1434 the generated gate script runs, not just contains the case', () => {
  it('credits the gate when executed as a fresh init would write it', () => {
    const genPath = join(root, 'generated-gate.cjs');
    writeFileSync(genPath, generateGateScript());

    const r = spawnSync(process.execPath, [genPath, 'record-no-durable-lesson'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });

    // A syntax error surfaces here as a non-zero exit with a parse error on
    // stderr, which substring-matching the source can never catch.
    expect(r.stderr).not.toMatch(/SyntaxError|Unexpected token/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no durable lesson');
    expect(readStateFile().learningsStored).toBe(true);
  });
});

describe('#1434 all three gate copies carry the fix', () => {
  const binSrc = readFileSync(GATE, 'utf-8');
  const helpersSrc = readFileSync(join(REPO_ROOT, '.claude', 'helpers', 'gate.cjs'), 'utf-8');
  const generated = generateGateScript();

  for (const [name, src] of [
    ['bin/gate.cjs', binSrc],
    ['.claude/helpers/gate.cjs', helpersSrc],
    ['generateGateScript()', generated],
  ] as const) {
    it(`${name} handles record-no-durable-lesson`, () => {
      expect(src).toContain("case 'record-no-durable-lesson'");
    });

    it(`${name} names the bar and the escape in the block message`, () => {
      expect(src).toContain('DIFFERENT task');
      expect(src).toContain('record-no-durable-lesson');
    });

    /**
     * The escape path must be the `__filename` TOKEN, resolved when the gate
     * runs in the consumer. The generator embeds this source inside a template
     * literal, so a `${__filename}` slip would instead bake the build machine's
     * absolute path into every consumer's gate message — wrong for them, and a
     * path disclosure besides. Substring-matching the command name cannot tell
     * the two apart.
     */
    it(`${name} resolves the escape path at runtime, not at build time`, () => {
      expect(src).toMatch(/'node "' \+ __filename \+ '"/);
      expect(src).not.toMatch(/node "\/(home|Users)\//);
    });
  }
});
