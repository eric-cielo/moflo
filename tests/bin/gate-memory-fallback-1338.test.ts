/**
 * The memory_first gate must be escapable without MCP, and creditable only by a
 * real search (#1338).
 *
 * Two opposite defects lived on adjacent lines of `bin/gate.cjs`:
 *
 *   - The block messages named ONLY `mcp__moflo__memory_search`. Claude Code
 *     spawns stdio MCP servers once at session start and never respawns them,
 *     so a session whose moflo server died is told to unblock itself with a
 *     tool that does not exist in it. The CLI escape hatch existed and worked —
 *     it was simply never surfaced.
 *   - `CREDIT_MEMORY_SEARCH_RE` was an unanchored substring test, so
 *     `echo "memory search"` — or a commit message mentioning this very issue —
 *     satisfied the gate for the rest of the prompt. Strict block regex, loose
 *     credit regex, three lines apart.
 *
 * These drive `gate.cjs` as a subprocess exactly as the hooks do, and cover the
 * full arc the ticket describes: blocked → run the suggested fallback → credited.
 *
 * Cross-platform (Rule #1): the invocation forms below include `npx.cmd`, a
 * backslash-separated Windows path and a forward-slash POSIX one, because
 * credit is matched on the command BASENAME, not on a separator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { generateGateScript } from '../../src/cli/init/helpers-generator.js';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

let root: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: root,
    TOOL_INPUT_command: '',
    TOOL_INPUT_pattern: '',
    TOOL_INPUT_path: '',
    TOOL_INPUT_file_path: '',
    CLAUDE_USER_PROMPT: '',
    HOOK_SESSION_ID: '',
    ...extra,
  };
}

/** Run a gate script (bin/ by default) the way the hook bridge does. */
function runGate(command: string, extra: Record<string, string> = {}, script = GATE) {
  const r = spawnSync(process.execPath, [script, command], {
    env: env(extra),
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function writeState(state: Record<string, unknown>) {
  writeFileSync(join(root, '.claude', 'workflow-state.json'), JSON.stringify(state, null, 2));
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.claude', 'workflow-state.json'), 'utf-8'));
}

/** A source path outside the project — never tmp-exempt (#1294 finding 3). */
const READ_TARGET = resolve('/', 'workspace', 'proj', 'src', 'app.ts');

/** Does this command satisfy the gate? Asked of the real recorder path. */
function credits(cmd: string, script = GATE): boolean {
  writeState({ memoryRequired: true, memorySearched: false });
  runGate('check-bash-memory', { TOOL_INPUT_command: cmd }, script);
  return readState().memorySearched === true;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-1338-')));
  mkdirSync(join(root, '.claude'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold handles — non-fatal */
  }
});

describe('memory_first block messages name a working non-MCP fallback', () => {
  const FALLBACK = 'npx flo memory search --query "<topic>" --namespace <ns>';

  beforeEach(() => writeState({ memoryRequired: true, memorySearched: false }));

  it('check-before-read names it', () => {
    const r = runGate('check-before-read', { TOOL_INPUT_file_path: READ_TARGET });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).toContain(FALLBACK);
  });

  it('check-before-scan names it', () => {
    const r = runGate('check-before-scan', { TOOL_INPUT_pattern: '**/*.ts' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(FALLBACK);
  });

  it('check-bash-memory names it', () => {
    const r = runGate('check-bash-memory', { TOOL_INPUT_command: 'grep -rn TODO src/' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(FALLBACK);
  });

  it('says why the fallback exists, so the reader knows when to reach for it', () => {
    const r = runGate('check-before-read', { TOOL_INPUT_file_path: READ_TARGET });
    expect(r.stderr).toContain('MCP server not connected');
  });
});

describe('blocked → run the suggested fallback → credited (the full arc)', () => {
  it('the exact command the block message prints unblocks the read', () => {
    writeState({ memoryRequired: true, memorySearched: false });

    const blocked = runGate('check-before-read', { TOOL_INPUT_file_path: READ_TARGET });
    expect(blocked.status).toBe(2);

    // Take the fallback verbatim off the message and fill in the placeholders,
    // exactly as an agent following the instruction would.
    const suggested = blocked.stderr
      .split('\n')
      .find((l) => l.includes('npx flo memory search'))!
      .replace(/^.*?(npx flo memory search)/, '$1')
      .replace('<topic>', 'memory_first gate')
      .replace('<ns>', 'guidance');

    const credited = runGate('check-bash-memory', { TOOL_INPUT_command: suggested });
    expect(credited.status).toBe(0);
    expect(readState().memorySearched).toBe(true);

    const after = runGate('check-before-read', { TOOL_INPUT_file_path: READ_TARGET });
    expect(after.stderr).not.toContain('BLOCKED');
    expect(after.status).toBe(0);
  });
});

describe('credit requires a real memory-search invocation', () => {
  // Every one of these ran a search. Losing any of them would strand a consumer
  // whose documented recipe stopped working.
  it.each([
    ['flo memory search --query "auth" --namespace patterns'],
    ['npx flo memory search --query "auth" --namespace guidance --limit 5'],
    ["npx flo memory search --query 'task keywords' --namespace patterns"],
    ['npx moflo memory search --query "auth"'],
    ['npx moflo memory retrieve --key auth-pattern'],
    ['npx flo-search semantic-search "patterns"'],
    ['flo-search "auth" --namespace patterns'],
    ['npx -y flo memory search --query "auth"'],
    ['pnpm dlx flo memory search --query "auth"'],
    ['cd /workspace/proj && flo memory search --query "auth"'],
    ['node ./node_modules/moflo/bin/cli.js memory search --query "auth"'],
    ['node .claude/scripts/semantic-search.mjs "auth"'],
    // Windows spellings — shims and backslashes must credit identically.
    ['npx.cmd flo memory search --query "auth"'],
    ['flo.cmd memory search --query "auth"'],
    ['node C:\\proj\\node_modules\\moflo\\bin\\cli.js memory search --query "auth"'],
    ['node .claude\\scripts\\semantic-search.mjs "auth"'],
  ])('credits %s', (cmd) => {
    expect(credits(cmd)).toBe(true);
  });

  // None of these searched anything. The old regex credited all of them.
  it.each([
    ['echo "memory search"'],
    ['echo memory-search'],
    ['git commit -m "fix(gate): anchor the memory search credit regex"'],
    ['git commit -m "notes" -m "ran semantic-search earlier"'],
    ['npm install grep-memory-search'],
    ['printf "%s" "memory retrieve"'],
  ])('does NOT credit %s', (cmd) => {
    expect(credits(cmd)).toBe(false);
  });

  it('does not let a read-like command credit itself by mentioning the phrase', () => {
    // The sharpest form of the bug: the blocked command carries its own escape.
    writeState({ memoryRequired: true, memorySearched: false });
    const r = runGate('check-bash-memory', { TOOL_INPUT_command: 'grep -rn "memory search" src/' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
    expect(readState().memorySearched).not.toBe(true);
  });
});

describe('the flo-init fallback template keeps parity (#1338)', () => {
  // `flo init` writes a consumer's gate from the package's .claude/helpers copy;
  // generateGateScript() is the fallback for when source helpers can't be found.
  // A consumer landing on that path must get the same gate, not the old one.
  let script: string;

  beforeEach(() => {
    script = join(root, 'generated-gate.cjs');
    writeFileSync(script, generateGateScript());
  });

  it('names the fallback in its block messages', () => {
    writeState({ memoryRequired: true, memorySearched: false });
    const r = runGate('check-bash-memory', { TOOL_INPUT_command: 'grep -rn TODO src/' }, script);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npx flo memory search');
  });

  it('credits a real invocation and refuses a bare mention', () => {
    expect(credits('npx flo memory search --query "auth"', script)).toBe(true);
    expect(credits('echo "memory search"', script)).toBe(false);
  });
});
