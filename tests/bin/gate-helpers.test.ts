/**
 * Integration tests for bin/ gate and hook helper scripts.
 *
 * These test the actual scripts as Claude Code invokes them:
 * - gate.cjs          — workflow gates (memory-first, dangerous-command, etc.)
 * - gate-hook.mjs     — ESM stdin wrapper that calls gate.cjs
 * - hook-handler.cjs  — lightweight hook dispatch (route, edit, task metrics)
 * - prompt-hook.mjs   — prompt classification + namespace hints
 *
 * Each test spawns the script as a child process with controlled env/stdin,
 * exactly like Claude Code's hook runner does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BIN = resolve(__dirname, '../../bin');
const GATE = resolve(BIN, 'gate.cjs');
const GATE_HOOK = resolve(BIN, 'gate-hook.mjs');
const HOOK_HANDLER = resolve(BIN, 'hook-handler.cjs');
const PROMPT_HOOK = resolve(BIN, 'prompt-hook.mjs');

let tmpDir: string;

function makeTmpProject(): string {
  const dir = resolve(tmpdir(), `moflo-gate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  // Copy gate.cjs into the temp project's .claude/helpers/ (for gate-hook.mjs)
  const helpersDir = join(dir, '.claude', 'helpers');
  mkdirSync(helpersDir, { recursive: true });
  const gateSrc = readFileSync(GATE, 'utf-8');
  writeFileSync(join(helpersDir, 'gate.cjs'), gateSrc);
  return dir;
}

function baseEnv(projectDir: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CLAUDE_PROJECT_DIR: projectDir,
    // Clear any inherited tool input vars
    TOOL_INPUT_command: '',
    TOOL_INPUT_pattern: '',
    TOOL_INPUT_path: '',
    TOOL_INPUT_file_path: '',
    CLAUDE_USER_PROMPT: '',
    // Default to no session_id so per-actor tests are explicit about which
    // bucket they target (#931). Tests that exercise per-session emission
    // override HOOK_SESSION_ID after building env.
    HOOK_SESSION_ID: '',
  };
}

/** Run gate.cjs with a subcommand and env vars. Returns { stdout, stderr, exitCode }.
 *  Timeout is generous because under isolation-batch contention (Windows in
 *  particular) `node + load gate.cjs` can take well over the 5 s the test
 *  used to allow; the test measures behavior, not speed.
 *  Uses spawnSync so stderr is captured even on exit 0 — required for the
 *  #1176 no-op-warning tests where stderr is emitted but exit is still 0. */
function runGate(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('node', [GATE, command], {
    env, encoding: 'utf-8', timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: typeof r.status === 'number' ? r.status : 1,
  };
}

/** Run an ESM script (gate-hook.mjs or prompt-hook.mjs) with stdin JSON piped in. */
function runEsmWithStdin(
  script: string,
  args: string[],
  stdinJson: object,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [script, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on('error', () => {
      resolve({ stdout, stderr, exitCode: 1 });
    });

    // Write stdin JSON and close
    proc.stdin.write(JSON.stringify(stdinJson));
    proc.stdin.end();

    // Safety timeout — generous so isolation-batch contention can't false-fail
    // a behavior test (paired with the 30 s runGate budget above).
    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ stdout, stderr, exitCode: -1 });
    }, 30000);
  });
}

/** Read the workflow state file from the temp project. */
function readState(projectDir: string): Record<string, unknown> {
  const stateFile = join(projectDir, '.claude', 'workflow-state.json');
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, 'utf-8'));
}

/** Write a workflow state file to the temp project. */
function writeState(projectDir: string, state: Record<string, unknown>): void {
  const stateFile = join(projectDir, '.claude', 'workflow-state.json');
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = makeTmpProject();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-dangerous-command
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-dangerous-command', () => {
  it('allows safe commands (exit 0)', () => {
    const env = baseEnv(tmpDir);
    const safeCommands = [
      'npx vitest run --reporter=verbose',
      'git status',
      'npm test',
      'ls -la',
      'cd /tmp && echo hello',
      'node server.js',
      'cat package.json',
    ];
    for (const cmd of safeCommands) {
      env.TOOL_INPUT_command = cmd;
      const r = runGate('check-dangerous-command', env);
      expect(r.exitCode, `Should allow: ${cmd}`).toBe(0);
    }
  });

  it('blocks rm -rf / (exit 2)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'rm -rf /';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('BLOCKED');
  });

  it('blocks format c: (exit 2)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'format c:';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
  });

  it('blocks fork bomb (exit 2)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = ':(){:|:&};:';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
  });

  it('blocks del /s /q c:\\ (exit 2)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'del /s /q c:\\';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
  });

  it('blocks mkfs. commands (exit 2)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'mkfs.ext4 /dev/sda1';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
  });

  it('blocks > /dev/sda (exit 2)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'dd if=/dev/zero > /dev/sda';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
  });

  // #1171 — PowerShell destructive cmdlets added when the matcher widened to
  // include the dedicated `PowerShell` tool. Case-insensitive substring match,
  // symmetric to the POSIX entries above.
  it.each([
    ['Remove-Item -Recurse -Force C:\\', 'PS recursive force-remove of C: drive'],
    ['Remove-Item -Recurse -Force /', 'PS recursive force-remove of POSIX root'],
    ['Remove-Item -Recurse -Force ~', 'PS recursive force-remove of home dir'],
    ['Format-Volume -DriveLetter D', 'PS Format-Volume'],
    ['Clear-Disk -Number 0 -RemoveData', 'PS Clear-Disk'],
  ])('blocks PS dangerous: %s (#1171)', (cmd) => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = cmd;
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(2);
  });

  // #1171 follow-up — DANGEROUS substring matching used to scan the entire
  // command string, so dangerous-shaped patterns in quoted message bodies
  // (`git commit -m "...remove-item -recurse -force c:\\..."`) tripped the gate
  // even though no destructive command would execute. Now strips quoted bodies
  // and heredocs before matching. These tests pin both halves: quoted-body
  // patterns pass; actual commands still block.
  it.each([
    ['git commit -m "fix: removed remove-item -recurse -force c:\\ pattern"', 'dangerous string inside double-quoted commit message'],
    ["git commit -m 'note: format-volume bug fixed'", 'dangerous string inside single-quoted commit message'],
    ['echo "rm -rf /"', 'echo with dangerous string in quoted argument'],
    ['printf "%s\\n" "clear-disk demo"', 'printf with dangerous string in quoted argument'],
    ['gh pr create --body "fixes remove-item -recurse -force / issue"', 'gh pr create with dangerous string in body arg'],
    // Heredoc with dangerous body — strips from `<<EOF` through end-of-input.
    ['git commit -F - <<EOF\nfix: remove-item -recurse -force c:\\\nEOF', 'heredoc body with dangerous-shaped text'],
    // Hyphenated heredoc token — `\w+` would halt at `END` and leak `-OF-DOC`
    // plus the dangerous body; `[\w-]+` matches the full token. Regression
    // guard for the edge case the SMALL reviewer flagged.
    ['cat <<END-OF-DOC\nformat-volume target=D\nEND-OF-DOC', 'hyphenated heredoc token strips the full body'],
    // Escaped double-quote inside a quoted body — regex must NOT terminate
    // the strip on the `\"` and leak the remainder.
    ['git commit -m "fix \\"remove-item -recurse -force c:\\\\\\" handling"', 'escaped quote inside quoted body must not leak'],
  ])('allows dangerous-shaped substring inside quoted/heredoc body: %s (#1171)', (cmd) => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = cmd;
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode, `quoted body should pass: ${cmd}`).toBe(0);
  });

  it('allows rm -rf with a safe path', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'rm -rf ./node_modules';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(0);
  });

  it('exits 0 with empty command', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = '';
    const r = runGate('check-dangerous-command', env);
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-before-agent (advisory only, never blocks)
// Agent spawning is never blocked — memory-first is enforced at scan/read layer.
// SubagentStart hook injects guidance directive into subagent context.
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-before-agent', () => {
  it('shows reminder when memory not searched (never blocks)', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('REMINDER');
    expect(r.stdout).toContain('memory');
  });

  it('allows when memory already searched', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: true });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('allows when memory not required', () => {
    writeState(tmpDir, { memoryRequired: false, memorySearched: false });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('shows TaskCreate reminder when tasks not created', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: true, tasksCreated: false });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('REMINDER');
    expect(r.stdout).toContain('TaskCreate');
  });

  it('no reminder when tasks already created', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: true, tasksCreated: true });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('REMINDER');
  });

  it('uses defaults when no state file — shows reminder, never blocks', () => {
    // Default: memoryRequired=true, memorySearched=false → advisory reminder
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-before-scan (Glob/Grep gate)
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-before-scan', () => {
  it('blocks scan when memory not searched', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = '**/*.ts';
    env.TOOL_INPUT_path = 'src/';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('allows scan when memory searched', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = '**/*.ts';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts .claude/ paths', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = '*.json';
    env.TOOL_INPUT_path = '.claude/';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts CLAUDE.md', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = 'CLAUDE.md';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts node_modules', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_path = 'node_modules/moflo';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts workflow-state', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = 'workflow-state.json';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });

  it('allows when memoryRequired is false', () => {
    writeState(tmpDir, { memoryRequired: false, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = 'src/**/*.ts';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-before-read (guidance file gate)
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-before-read', () => {
  it('blocks reading guidance files when memory not searched', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/.claude/guidance/rules.md';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('blocks reading non-exempt files when memory not searched', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/src/index.ts';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('allows reading any file when memory searched', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/.claude/guidance/rules.md';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts .claude/ config paths (non-guidance) from read gate', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/.claude/settings.json';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('does NOT exempt .claude/guidance/ from read gate', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/.claude/guidance/shipped/moflo-core.md';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(2);
  });

  it('exempts CLAUDE.md from read gate', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/CLAUDE.md';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts MEMORY.md from read gate', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/MEMORY.md';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts node_modules from read gate', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/node_modules/moflo/index.js';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('exempts workflow-state from read gate', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/.claude/workflow-state.json';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('allows when memoryRequired is false', () => {
    writeState(tmpDir, { memoryRequired: false, memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_file_path = '/project/src/index.ts';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — record-task-created / record-memory-searched
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: state recording', () => {
  it('record-task-created sets tasksCreated and increments count', () => {
    writeState(tmpDir, { tasksCreated: false, taskCount: 0 });
    runGate('record-task-created', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.tasksCreated).toBe(true);
    expect(s.taskCount).toBe(1);
  });

  it('record-task-created increments count on repeated calls', () => {
    writeState(tmpDir, { tasksCreated: true, taskCount: 3 });
    runGate('record-task-created', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.taskCount).toBe(4);
  });

  it('readState merges defaults for missing keys', () => {
    // Simulate a state file from an older gate version missing learningsStored
    writeState(tmpDir, { tasksCreated: true, taskCount: 2, memorySearched: false });
    // Any gate call that reads state should see defaults for missing keys
    runGate('record-memory-searched', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.memorySearched).toBe(true);
    // learningsStored should be filled in as false (default), not undefined
    expect(s.learningsStored).toBe(false);
    expect(s.interactionCount).toBe(0);
  });

  it('record-memory-searched sets memorySearched', () => {
    writeState(tmpDir, { memorySearched: false });
    runGate('record-memory-searched', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.memorySearched).toBe(true);
  });

  it('record-memory-searched is idempotent when already set', () => {
    writeState(tmpDir, { memorySearched: true, taskCount: 5 });
    runGate('record-memory-searched', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.memorySearched).toBe(true);
    expect(s.taskCount).toBe(5); // other state preserved
  });

  it('any writer of memorySearched=true satisfies the scan gate (#354)', () => {
    // The MCP memory_search handler writes memorySearched directly to
    // workflow-state.json (via WorkflowGateService) because PostToolUse
    // hooks don't fire reliably for MCP tools. This test verifies the
    // contract: regardless of who sets the flag, the gate passes.
    writeState(tmpDir, { memorySearched: true, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_pattern = '**/*.ts';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-bash-memory
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-bash-memory', () => {
  it('detects "memory search" in bash command and records it', () => {
    writeState(tmpDir, { memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'npx moflo memory search --query "auth"';
    runGate('check-bash-memory', env);
    const s = readState(tmpDir);
    expect(s.memorySearched).toBe(true);
  });

  it('detects "semantic-search" in bash command', () => {
    writeState(tmpDir, { memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'npx flo-search semantic-search "patterns"';
    runGate('check-bash-memory', env);
    expect(readState(tmpDir).memorySearched).toBe(true);
  });

  it('detects "memory retrieve" in bash command', () => {
    writeState(tmpDir, { memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'npx moflo memory retrieve --key auth-pattern';
    runGate('check-bash-memory', env);
    expect(readState(tmpDir).memorySearched).toBe(true);
  });

  it('does not flag unrelated bash commands', () => {
    writeState(tmpDir, { memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'npx vitest run --reporter=verbose';
    runGate('check-bash-memory', env);
    expect(readState(tmpDir).memorySearched).toBe(false);
  });

  it('does not flag git commands', () => {
    writeState(tmpDir, { memorySearched: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'git diff HEAD~1';
    runGate('check-bash-memory', env);
    expect(readState(tmpDir).memorySearched).toBe(false);
  });

  it('does not block non-read operational commands when memory is unsatisfied', () => {
    // #1132 — `rm -rf /` is caught by check-dangerous-command, not check-bash-memory.
    // The Bash-memory gate only blocks read-like commands (cat/grep/find/etc.).
    writeState(tmpDir, { memorySearched: false, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'rm -rf /';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-bash-memory BLOCK behavior (#1132)
// Reads via Bash were the documented escape hatch from the memory-first gate.
// These tests pin the BLOCK matrix from the issue so regressions surface
// instead of silently re-opening the gap.
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-bash-memory BLOCK (#1132)', () => {
  const block: Array<[string, string]> = [
    ['cat src/foo.ts', 'POSIX cat'],
    ['cat file1 file2 file3', 'multi-arg cat'],
    ['head -50 README.md', 'head'],
    ['tail -f app.log', 'tail -f'],
    ['grep -r "TODO" src/', 'grep recursive'],
    ['grep "TODO" src/foo.ts | head -5', 'grep at start of pipeline still blocks'],
    ['rg "TODO" src/', 'ripgrep'],
    ['type src\\foo.ts | grep x', 'Windows type piped'],
    ['cat src/foo.ts | head -20', 'cat at start of pipeline still blocks'],
    ['find . -name "*.test.ts"', 'find -name'],
    ["sed -n '1,20p' file.ts", 'sed -n'],
    ["awk '/TODO/' file.ts", 'awk with pattern'],
    ["awk '{print $1}' file.ts", 'awk without pattern'],
    ['type src\\foo.ts', 'Windows cmd type'],
    ['Get-Content src\\foo.ts', 'PowerShell Get-Content'],
    ['gc src\\foo.ts', 'PowerShell gc alias'],
    ['Select-String "pattern" src\\', 'PowerShell Select-String'],
    // #1171 — PS-native exploration forms covered by the widened matcher.
    ['Get-ChildItem -Recurse src\\', 'PowerShell Get-ChildItem -Recurse'],
    ['Get-ChildItem -Path src\\ -Recurse -Filter *.ts', 'gci with flags + -Recurse'],
    ['gci -Recurse', 'PowerShell gci alias with -Recurse'],
    ['dir /s', 'cmd-style dir /s'],
    ['dir src\\ /S', 'cmd-style dir /S uppercase'],
    ['Format-Hex C:\\file.bin', 'PowerShell Format-Hex'],
  ];

  for (const [cmd, label] of block) {
    it(`blocks: ${label} — ${cmd}`, () => {
      writeState(tmpDir, { memorySearched: false, memoryRequired: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = cmd;
      const r = runGate('check-bash-memory', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('BLOCKED');
      expect(r.stderr).toContain('memory_search');
    });
  }

  const pass: Array<[string, string]> = [
    ['cat > out.txt', 'cat redirect (write)'],
    ['cat <<EOF', 'cat heredoc'],
    ['tee output.log', 'tee'],
    ['find . -name foo -delete', 'find -delete'],
    ['find . -name foo -exec rm {} \\;', 'find -exec rm'],
    ['npm install grep', 'npm install with grep arg'],
    ['npm test', 'npm test'],
    ['git log --grep="fix"', 'git --grep'],
    ['gh pr list', 'gh'],
    ['curl https://example.com', 'curl'],
    ['docker ps', 'docker'],
    ['echo "hello"', 'echo'],
    ['npm test 2>&1 | grep FAIL', 'pipe-grep filter'],
    ['ls src/ | head -5', 'pipe-head filter'],
    ['curl https://x | jq .', 'curl piped to jq'],
    // #1171 — PS introspection / metadata cmdlets that LOOK read-shaped but
    // are not content reads; the matcher widening must not gate them.
    ['Get-Process node', 'PS Get-Process'],
    ['Get-Service moflo', 'PS Get-Service'],
    ['Get-Module', 'PS Get-Module'],
    ['Get-Command flo', 'PS Get-Command'],
    ['Get-Help Get-ChildItem', 'PS Get-Help'],
    ['Test-Path .\\package.json', 'PS Test-Path'],
    ['Resolve-Path src\\', 'PS Resolve-Path'],
    ['Get-ChildItem src\\', 'PS Get-ChildItem (no -Recurse)'],
    ['gci', 'PS gci alias (no -Recurse)'],
    // #1171 cross-platform — POSIX `dir` is aliased to `ls -l` on many distros.
    // `dir -s` (sort-by-size flag) is a legitimate non-recursive listing and
    // MUST NOT trip the gate. Only the Windows `dir /s` form is blocked.
    ['dir -s', 'POSIX dir -s (sort-by-size, not recursive)'],
    ['dir --sort=size src/', 'POSIX dir --sort=size'],
  ];

  for (const [cmd, label] of pass) {
    it(`passes: ${label} — ${cmd}`, () => {
      writeState(tmpDir, { memorySearched: false, memoryRequired: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = cmd;
      const r = runGate('check-bash-memory', env);
      expect(r.exitCode).toBe(0);
    });
  }

  it('does NOT block when memoryRequired is false (e.g. directive prompt)', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: false });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'cat src/foo.ts';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
  });

  it('does NOT block when the actor has already searched memory', () => {
    writeState(tmpDir, { memorySearched: true, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'grep -r "TODO" src/';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
  });

  it('honors per-actor memorySearchedBy when HOOK_SESSION_ID is set', () => {
    writeState(tmpDir, {
      memorySearched: false,
      memoryRequired: true,
      memorySearchedBy: { 'subagent-A': true },
    });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-A';
    env.TOOL_INPUT_command = 'cat src/foo.ts';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
  });

  it('blocks a different actor even when one actor has searched', () => {
    writeState(tmpDir, {
      memorySearched: false,
      memoryRequired: true,
      memorySearchedBy: { 'subagent-A': true },
    });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-B';
    env.TOOL_INPUT_command = 'cat src/foo.ts';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
  });

  it('respects moflo.yaml gates.memory_first: false', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  memory_first: false\n');
    writeState(tmpDir, { memorySearched: false, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'cat src/foo.ts';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
    rmSync(join(tmpDir, 'moflo.yaml'));
  });

  it('still credits real memory-search invocations and lets them pass', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'npx flo-search semantic-search "auth"';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
    expect(readState(tmpDir).memorySearched).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — check-bash-memory BLOCK message enrichment (#1132 follow-up)
// The block message must surface a namespace hint so the agent can route its
// search instead of stamping the gate with an arbitrary query. Two sources:
// (1) `lastNamespaceHint` from prompt classification (parent agents);
// (2) command-shape classification (subagents that never saw the prompt).
// Plus the inline example showing the canonical tool-call shape.
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: check-bash-memory BLOCK message enrichment (#1132)', () => {
  it('includes the inline mcp__moflo__memory_search example', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'cat src/foo.ts';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('Example: mcp__moflo__memory_search');
    expect(r.stderr).toContain('namespace');
  });

  it('echoes lastNamespaceHint when set (prompt-derived precedence)', () => {
    writeState(tmpDir, {
      memorySearched: false,
      memoryRequired: true,
      lastNamespaceHint: 'Memory namespace hint: use "tests" for test inventory and coverage lookups.',
    });
    const env = baseEnv(tmpDir);
    // Use a command whose shape would say code-map — prompt hint must win.
    env.TOOL_INPUT_command = 'grep -r foo src/';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('"tests"');
    expect(r.stderr).not.toContain('"code-map"');
  });

  it('falls back to command-shape hint for search-like commands → code-map', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: true, lastNamespaceHint: '' });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'grep -r foo src/';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('"code-map"');
  });

  it('falls back to command-shape hint for doc reads → guidance', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: true, lastNamespaceHint: '' });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'cat README.md';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('"guidance"');
  });

  it('handles flag-prefixed doc reads (head -50 CLAUDE.md)', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: true, lastNamespaceHint: '' });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'head -50 CLAUDE.md';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('"guidance"');
  });

  it('emits no specific hint for ambiguous reads (cat package.json)', () => {
    writeState(tmpDir, { memorySearched: false, memoryRequired: true, lastNamespaceHint: '' });
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'cat package.json';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(2);
    // Block message still appears; just no "Memory namespace hint:" line.
    expect(r.stderr).toContain('BLOCKED');
    expect(r.stderr).not.toMatch(/Memory namespace hint:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — `type` regex tightening (#1132 follow-up)
// Shell-builtin lookups like `type ls` and `type cd` are not file reads and
// have no business being blocked. Tighten the regex to require a path-ish
// argument (slash, backslash, or dot) before BLOCK fires.
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: type regex tightening (#1132)', () => {
  const builtinPass: Array<[string, string]> = [
    ['type ls', 'builtin lookup, single token'],
    ['type cd', 'builtin lookup, builtin name'],
    ['type my-command', 'custom command, no path char'],
  ];
  for (const [cmd, label] of builtinPass) {
    it(`type passes (${label}): ${cmd}`, () => {
      writeState(tmpDir, { memorySearched: false, memoryRequired: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = cmd;
      const r = runGate('check-bash-memory', env);
      expect(r.exitCode).toBe(0);
    });
  }

  const fileBlock: Array<[string, string]> = [
    ['type src\\foo.ts', 'backslash path'],
    ['type ./config', 'slash path'],
    ['type README.md', 'dot in extension'],
    ['type C:\\Users\\eric\\file', 'absolute Windows path'],
  ];
  for (const [cmd, label] of fileBlock) {
    it(`type blocks (${label}): ${cmd}`, () => {
      writeState(tmpDir, { memorySearched: false, memoryRequired: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = cmd;
      const r = runGate('check-bash-memory', env);
      expect(r.exitCode).toBe(2);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — prompt-reminder
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: prompt-reminder', () => {
  it('classifies task prompts as requiring memory', () => {
    writeState(tmpDir, { memorySearched: true });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'fix the authentication bug in the login page';
    runGate('prompt-reminder', env);
    const s = readState(tmpDir);
    expect(s.memoryRequired).toBe(true);
    expect(s.memorySearched).toBe(false); // reset each prompt
  });

  it('classifies directives as not requiring memory', () => {
    writeState(tmpDir, { memorySearched: true, memoryRequired: true });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'yes';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('classifies "ok" as directive (no memory)', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'ok';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('classifies short prompts (<4 chars) as no memory', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'no';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('@@ escape hatch bypasses memory requirement', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '@@ how does the login flow work and what are the edge cases we should worry about';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('@@ escape hatch works even with task keywords', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '@@ fix the auth bug — just thinking out loud';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('@@ escape hatch with extra whitespace after prefix', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = '@@   what do you think about this approach';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('increments interaction count', () => {
    writeState(tmpDir, { interactionCount: 5 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'yes';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).interactionCount).toBe(6);
  });

  it('shows context warning at >10 interactions', () => {
    writeState(tmpDir, { interactionCount: 11 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement the feature';
    const r = runGate('prompt-reminder', env);
    expect(r.stdout).toContain('MODERATE');
  });

  it('shows depleted warning at >20 interactions', () => {
    writeState(tmpDir, { interactionCount: 21 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement the feature';
    const r = runGate('prompt-reminder', env);
    expect(r.stdout).toContain('DEPLETED');
  });

  it('shows critical warning at >30 interactions', () => {
    writeState(tmpDir, { interactionCount: 31 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement the feature';
    const r = runGate('prompt-reminder', env);
    expect(r.stdout).toContain('CRITICAL');
  });

  it('long non-task prompts require memory (>20 chars)', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'I was thinking about how the application handles the various edge cases in the rendering pipeline when multiple users connect';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(true);
  });

  it('medium non-task prompts (>20 chars) require memory', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'how does the login flow work exactly';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(true);
  });

  it('long directive-prefixed prompts still require memory', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'yes but also fix the authentication bug while you are at it';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(true);
  });

  it('short directive-prefixed prompts bypass memory', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'ok sure';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('directive at exactly DIRECTIVE_MAX_LEN (20) bypasses memory', () => {
    // 20 chars: "exactly twenty chars" — under the limit
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'yes do that please';  // 18 chars, directive, under 20
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(false);
  });

  it('directive just over DIRECTIVE_MAX_LEN requires memory', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'ok let me think about this for a moment';  // 39 chars, starts with "ok"
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).memoryRequired).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — session-reset
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: session-reset', () => {
  it('resets all spell state', () => {
    writeState(tmpDir, {
      tasksCreated: true, taskCount: 5, memorySearched: true,
      memoryRequired: false, interactionCount: 42,
      learningsStored: true, testsRun: true, simplifyRun: true,
    });
    runGate('session-reset', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.tasksCreated).toBe(false);
    expect(s.taskCount).toBe(0);
    expect(s.memorySearched).toBe(false);
    expect(s.memoryRequired).toBe(true);
    expect(s.interactionCount).toBe(0);
    expect(s.learningsStored).toBe(false);
    expect(s.testsRun).toBe(false);
    expect(s.simplifyRun).toBe(false);
    expect(s.sessionStart).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — compact-guidance
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: compact-guidance', () => {
  it('outputs pre-compact reminder', () => {
    const r = runGate('compact-guidance', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('CLAUDE.md');
    expect(r.stdout).toContain('memory search');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — unknown command
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: unknown commands', () => {
  it('exits 0 for unknown command', () => {
    const r = runGate('nonexistent-gate', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('exits 0 with no command', () => {
    try {
      const stdout = execFileSync('node', [GATE], {
        env: baseEnv(tmpDir), encoding: 'utf-8', timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // no crash = pass
    } catch (err: any) {
      expect(err.status).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — moflo.yaml config override
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: moflo.yaml config', () => {
  it('disables memory_first gate when config says false', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  memory_first: false\n');
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.exitCode).toBe(0); // Not blocked
  });

  it('disables task_create_first reminder when config says false', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  task_create_first: false\n');
    writeState(tmpDir, { memoryRequired: true, memorySearched: true, tasksCreated: false });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.stdout).not.toContain('REMINDER');
  });

  it('disables context tracking when config says false', () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  context_tracking: false\n');
    writeState(tmpDir, { interactionCount: 31 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement the feature';
    const r = runGate('prompt-reminder', env);
    expect(r.stdout).not.toContain('CRITICAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate-hook.mjs — stdin JSON → env vars → gate.cjs
// ─────────────────────────────────────────────────────────────────────────────

describe('gate-hook.mjs: stdin integration', () => {
  it('passes tool_input from stdin JSON to gate.cjs as env vars', async () => {
    writeState(tmpDir, { memorySearched: false });
    const r = await runEsmWithStdin(GATE_HOOK, ['check-bash-memory'], {
      tool_name: 'Bash',
      tool_input: { command: 'npx moflo memory search --query "auth"' },
      hook_event_name: 'PostToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    // Verify side effect: memorySearched should be true
    expect(readState(tmpDir).memorySearched).toBe(true);
  });

  it('blocks dangerous commands via stdin JSON', async () => {
    const r = await runEsmWithStdin(GATE_HOOK, ['check-dangerous-command'], {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      hook_event_name: 'PreToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('allows safe commands via stdin JSON', async () => {
    const r = await runEsmWithStdin(GATE_HOOK, ['check-dangerous-command'], {
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
      hook_event_name: 'PreToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('handles empty stdin gracefully', async () => {
    const r = await runEsmWithStdin(GATE_HOOK, ['check-dangerous-command'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('exits 0 with no command arg', async () => {
    const r = await runEsmWithStdin(GATE_HOOK, [], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('handles large tool_output without error', async () => {
    const largeOutput = 'FAIL test line output\n'.repeat(5000);
    const r = await runEsmWithStdin(GATE_HOOK, ['check-bash-memory'], {
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
      tool_output: largeOutput,
      hook_event_name: 'PostToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('forwards advisory reminder from gate.cjs (exit 0, not blocked)', async () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false });
    const r = await runEsmWithStdin(GATE_HOOK, ['check-before-agent'], {
      tool_name: 'Agent',
      tool_input: { prompt: 'do stuff' },
      hook_event_name: 'PreToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('REMINDER');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hook-handler.cjs — lightweight hook dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe('hook-handler.cjs', () => {
  it('route: outputs routing info with prompt', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['route'], {
      prompt: 'fix the login bug',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[INFO]');
    expect(r.stdout).toContain('fix the login bug');
  });

  it('route: outputs ready with no prompt', async () => {
    const env = baseEnv(tmpDir);
    // Clear Windows PROMPT env var so hook-handler doesn't pick it up
    delete env.PROMPT;
    const r = await runEsmWithStdin(HOOK_HANDLER, ['route'], {}, env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[INFO] Ready');
  });

  it('pre-edit: records metric and outputs OK', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['pre-edit'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[OK] Edit recorded');
  });

  it('post-edit: records metric', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['post-edit'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[OK] Edit recorded');
  });

  it('pre-task: records metric', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['pre-task'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[OK] Task started');
  });

  it('post-task: records metric', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['post-task'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[OK] Task completed');
  });

  it('session-end: acknowledges', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['session-end'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[OK] Session ended');
  });

  it('notification: silent (no output)', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['notification'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('unknown command: outputs OK with command name', async () => {
    const r = await runEsmWithStdin(HOOK_HANDLER, ['custom-hook'], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[OK] Hook: custom-hook');
  });

  it('bumps metrics file on edit', async () => {
    const metricsFile = join(tmpDir, '.moflo', 'metrics', 'learning.json');
    await runEsmWithStdin(HOOK_HANDLER, ['pre-edit'], {}, baseEnv(tmpDir));
    await runEsmWithStdin(HOOK_HANDLER, ['post-edit'], {}, baseEnv(tmpDir));
    expect(existsSync(metricsFile)).toBe(true);
    const metrics = JSON.parse(readFileSync(metricsFile, 'utf-8'));
    expect(metrics.edits).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prompt-hook.mjs — prompt classification + namespace hints
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// #931 — Namespace hints
//
// Before #931 the hint emitted on every prompt from prompt-hook.mjs (~40 tokens
// × every prompt × every consumer). Now prompt-hook.mjs runs gate.cjs
// `prompt-reminder` which CLASSIFIES the prompt and stores the result on
// workflow-state.json — and check-before-agent emits it once at Agent-spawn
// time, then clears. Two-step flow keeps per-prompt overhead at zero for
// non-Agent turns.
// ─────────────────────────────────────────────────────────────────────────────

describe('namespace hints (#931): prompt-reminder stores; check-before-agent emits', () => {
  function expectStoredHint(prompt: string, expectedNs: string) {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = prompt;
    runGate('prompt-reminder', env);
    const state = readState(tmpDir);
    expect(state.lastNamespaceHint, `expected hint for: ${prompt}`).toContain(expectedNs);
  }

  it('classifies "learnings" for recall prompts', () => {
    expectStoredHint('do you remember what we decided about auth?', 'learnings');
  });

  it('classifies "tests" for test/coverage prompts', () => {
    expectStoredHint('where are the tests for the auth middleware?', 'tests');
  });

  it('classifies "patterns" for convention prompts', () => {
    expectStoredHint('what is our best practice for error handling?', 'patterns');
  });

  it('classifies "code-map" for file structure prompts', () => {
    expectStoredHint('show me the project structure', 'code-map');
  });

  it('classifies "guidance" for architecture prompts', () => {
    expectStoredHint('explain the architecture design for the API', 'guidance');
  });

  it('classifies "code-map" for navigation prompts', () => {
    expectStoredHint('where is the endpoint for user login?', 'code-map');
  });

  it('classifies "patterns" for template prompts', () => {
    expectStoredHint('show me an example of how we handle pagination', 'patterns');
  });

  it('stores empty hint for simple directives (no false positives)', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'yes';
    runGate('prompt-reminder', env);
    expect(readState(tmpDir).lastNamespaceHint).toBe('');
  });

  it('check-before-agent emits the hint once per session_id (per-actor single-shot)', () => {
    writeState(tmpDir, { tasksCreated: true, memorySearched: true, lastNamespaceHint: 'Memory namespace hint: use "tests" for test inventory and coverage lookups.' });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'parent-session';
    const r1 = runGate('check-before-agent', env);
    expect(r1.stdout).toContain('Memory namespace hint');
    expect(r1.stdout).toContain('tests');
    // Same session, second Agent spawn — already emitted to this actor.
    const r2 = runGate('check-before-agent', env);
    expect(r2.stdout).not.toContain('Memory namespace hint');
    // Hint itself is preserved — a different actor (subagent) is still entitled
    // to its own first emission.
    expect(readState(tmpDir).lastNamespaceHint).toContain('tests');
  });

  it('check-before-agent emits the hint to a different session_id (subagent gets its own first-shot)', () => {
    writeState(tmpDir, { tasksCreated: true, memorySearched: true, lastNamespaceHint: 'Memory namespace hint: use "code-map" for codebase navigation.' });
    const parentEnv = baseEnv(tmpDir);
    parentEnv.HOOK_SESSION_ID = 'parent-session';
    const r1 = runGate('check-before-agent', parentEnv);
    expect(r1.stdout).toContain('code-map');
    // A subagent (different session_id) spawning its own agent is a new actor;
    // the per-session bucket lets it see the hint exactly once too.
    const subagentEnv = baseEnv(tmpDir);
    subagentEnv.HOOK_SESSION_ID = 'subagent-session-1';
    const r2 = runGate('check-before-agent', subagentEnv);
    expect(r2.stdout).toContain('code-map');
    // Same subagent, second spawn → already emitted to this actor.
    const r3 = runGate('check-before-agent', subagentEnv);
    expect(r3.stdout).not.toContain('code-map');
  });

  it('check-before-agent without HOOK_SESSION_ID emits once via _legacy_ bucket', () => {
    writeState(tmpDir, { tasksCreated: true, memorySearched: true, lastNamespaceHint: 'Memory namespace hint: use "tests" for test inventory and coverage lookups.' });
    // Older Claude Code hosts / direct CLI invocation — no session_id forwarded.
    const r1 = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r1.stdout).toContain('Memory namespace hint');
    const r2 = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r2.stdout).not.toContain('Memory namespace hint');
  });

  it('new prompt resets lastNamespaceHintEmittedBy → all actors get the new hint', () => {
    // Parent saw last prompt's hint already.
    writeState(tmpDir, { lastNamespaceHint: 'old hint', lastNamespaceHintEmittedBy: { 'parent': true, 'sub-1': true } });
    // New prompt classifies a different namespace; reset clears the bucket.
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'where is the login route defined?';
    runGate('prompt-reminder', env);
    const s = readState(tmpDir);
    expect(s.lastNamespaceHintEmittedBy).toEqual({});
    expect(s.lastNamespaceHint).toContain('code-map');
  });

  it('check-before-agent emits nothing namespace-related when no hint stored', () => {
    writeState(tmpDir, { tasksCreated: true, memorySearched: true, lastNamespaceHint: '' });
    const r = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r.stdout).not.toContain('Memory namespace hint');
  });

  it('end-to-end: prompt-hook.mjs (no inline emission) → state stored → check-before-agent emits', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'where is the endpoint for user login?',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    // prompt-hook.mjs no longer emits the hint inline — it lives on state now.
    expect(r.stdout).not.toContain('Memory namespace hint');
    expect(readState(tmpDir).lastNamespaceHint).toContain('code-map');
    const r2 = runGate('check-before-agent', baseEnv(tmpDir));
    expect(r2.stdout).toContain('code-map');
  });

  it('handles empty prompt gracefully', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #931 — prompt-state-reset (defensive safety-net for the second
// UserPromptSubmit hook). Idempotent state reset only — no emission, no
// interactionCount increment. Wired alongside prompt-hook.mjs so an exception
// in prompt-hook.mjs still resets per-actor memory tracking.
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: prompt-state-reset (#931 dedupe safety-net)', () => {
  it('resets memorySearched + memorySearchedBy + reclassifies memoryRequired', () => {
    writeState(tmpDir, { memorySearched: true, memorySearchedBy: { 's-1': true }, memoryRequired: false });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'fix the auth bug in the login flow';
    runGate('prompt-state-reset', env);
    const s = readState(tmpDir);
    expect(s.memorySearched).toBe(false);
    expect(s.memorySearchedBy).toEqual({});
    expect(s.memoryRequired).toBe(true);
  });

  it('emits nothing on stdout', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement user auth';
    const r = runGate('prompt-state-reset', env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('does NOT increment interactionCount (only prompt-reminder does)', () => {
    writeState(tmpDir, { interactionCount: 7 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement the feature';
    runGate('prompt-state-reset', env);
    expect(readState(tmpDir).interactionCount).toBe(7);
  });

  it('stores the same lastNamespaceHint as prompt-reminder', () => {
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'where is the login route defined?';
    runGate('prompt-state-reset', env);
    const s = readState(tmpDir);
    expect(s.lastNamespaceHint).toContain('code-map');
  });

  it('is idempotent: running prompt-reminder then prompt-state-reset increments interactionCount exactly once', () => {
    writeState(tmpDir, { interactionCount: 0 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement user auth';
    runGate('prompt-reminder', env);
    runGate('prompt-state-reset', env);
    expect(readState(tmpDir).interactionCount).toBe(1);
  });

  it('full UserPromptSubmit dedupe — neither hook emits the TaskCreate REMINDER per prompt', () => {
    writeState(tmpDir, { tasksCreated: false, interactionCount: 0 });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'implement user auth';
    const r1 = runGate('prompt-reminder', env);
    const r2 = runGate('prompt-state-reset', env);
    // Per-prompt token leak fix — REMINDER no longer fires from either hook.
    expect(r1.stdout).not.toContain('REMINDER: Use TaskCreate');
    expect(r2.stdout).not.toContain('REMINDER: Use TaskCreate');
    // ...but the gate still arms it for check-before-agent at Agent-spawn time.
    const r3 = runGate('check-before-agent', env);
    expect(r3.stdout).toContain('REMINDER: Use TaskCreate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: full workflow lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('end-to-end: spell lifecycle', () => {
  it('session-reset → prompt → memory search → agent spawn', () => {
    const env = baseEnv(tmpDir);

    // 1. Reset session
    runGate('session-reset', env);
    let s = readState(tmpDir);
    expect(s.tasksCreated).toBe(false);
    expect(s.memorySearched).toBe(false);

    // 2. User sends a task prompt
    env.CLAUDE_USER_PROMPT = 'implement user authentication';
    runGate('prompt-reminder', env);
    s = readState(tmpDir);
    expect(s.memoryRequired).toBe(true);

    // 3. Agent spawn shows reminder but is never blocked (advisory only)
    let r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('REMINDER');

    // 4. Memory search via bash
    env.TOOL_INPUT_command = 'npx moflo memory search --query "auth"';
    runGate('check-bash-memory', env);
    s = readState(tmpDir);
    expect(s.memorySearched).toBe(true);

    // 5. Agent spawn allowed after memory search (TaskCreate reminder is advisory)
    r = runGate('check-before-agent', env);
    expect(r.exitCode).toBe(0);
    // Memory reminder gone, but TaskCreate reminder may still show (tasks not created yet)

    // 6. Record task created
    runGate('record-task-created', env);
    s = readState(tmpDir);
    expect(s.tasksCreated).toBe(true);

    // 7. Next prompt resets memorySearched
    env.CLAUDE_USER_PROMPT = 'now add tests for it';
    runGate('prompt-reminder', env);
    s = readState(tmpDir);
    expect(s.memorySearched).toBe(false);

    // 8. Direct memory search via MCP (record-memory-searched)
    runGate('record-memory-searched', env);
    s = readState(tmpDir);
    expect(s.memorySearched).toBe(true);
  });

  describe('task transition gate (check-task-transition)', () => {
    it('resets memorySearched when task moves to in_progress', () => {
      const env = baseEnv(tmpDir);

      // Set up: memory searched, required
      env.CLAUDE_USER_PROMPT = 'implement the feature';
      runGate('prompt-reminder', env);
      runGate('record-memory-searched', env);
      let s = readState(tmpDir);
      expect(s.memorySearched).toBe(true);
      expect(s.memoryRequired).toBe(true);

      // Transition a task to in_progress — no longer resets (#352)
      // Memory gate only resets on new user prompts via prompt-reminder.
      env.TOOL_INPUT_status = 'in_progress';
      runGate('check-task-transition', env);
      s = readState(tmpDir);
      expect(s.memorySearched).toBe(true);
      expect(s.learningsStored).toBe(false);
    });

    it('does not reset for non-in_progress transitions', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'implement the feature';
      runGate('prompt-reminder', env);
      runGate('record-memory-searched', env);

      env.TOOL_INPUT_status = 'completed';
      runGate('check-task-transition', env);
      const s = readState(tmpDir);
      expect(s.memorySearched).toBe(true);
    });

    it('does not reset when memory was not yet searched', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'implement the feature';
      runGate('prompt-reminder', env);
      // Don't search memory

      env.TOOL_INPUT_status = 'in_progress';
      runGate('check-task-transition', env);
      const s = readState(tmpDir);
      expect(s.memorySearched).toBe(false); // stays false, no redundant reset
    });
  });

  describe('PR gates (check-before-pr)', () => {
    function fullySatisfied(): void {
      writeState(tmpDir, {
        testsRun: true,
        simplifyRun: true,
        learningsStored: true,
      });
    }

    it('blocks PR when learnings have not been stored', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: true, simplifyRun: true, learningsStored: false });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('BLOCKED');
      expect(r.stderr).toContain('learnings have not been stored');
    });

    it('blocks PR when tests have not run', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: false, simplifyRun: true, learningsStored: true });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('tests have not run');
    });

    it('blocks PR when /flo-simplify has not run', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: true, simplifyRun: false, learningsStored: true });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('/flo-simplify has not run');
    });

    it('lists every missing gate when more than one is unsatisfied', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: false, simplifyRun: false, learningsStored: false });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('tests have not run');
      expect(r.stderr).toContain('/flo-simplify has not run');
      expect(r.stderr).toContain('learnings have not been stored');
    });

    it('allows PR when all three gates are satisfied', () => {
      const env = baseEnv(tmpDir);
      fullySatisfied();
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain('BLOCKED');
    });

    it('blocks env-prefixed gh pr create (e.g. GH_TOKEN=x gh pr create)', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: false, simplifyRun: true, learningsStored: true });
      env.TOOL_INPUT_command = 'GH_TOKEN=secret gh pr create --title test';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('tests have not run');
    });

    it('blocks gh pr create with multiple env-var prefixes', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: true, simplifyRun: true, learningsStored: false });
      env.TOOL_INPUT_command = 'GH_TOKEN=x BUILD_ID=1 gh pr create --title test';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('learnings have not been stored');
    });

    it('does not block non-PR bash commands', () => {
      const env = baseEnv(tmpDir);
      // Even with all gates unsatisfied, non-PR commands pass through.
      writeState(tmpDir, { testsRun: false, simplifyRun: false, learningsStored: false });
      env.TOOL_INPUT_command = 'npm test';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('does not match "gh pr create" appearing inside a quoted heredoc body', () => {
      // Regression: regex must be anchored to command-start, not match the
      // string anywhere — `git commit -m "...gh pr create..."` is common.
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: false, simplifyRun: false, learningsStored: false });
      env.TOOL_INPUT_command = `git commit -m "promotes check-before-pr to block gh pr create until ready"`;
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('blocks chained gh pr create (after && or ;)', () => {
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: false, simplifyRun: true, learningsStored: true });
      env.TOOL_INPUT_command = 'git push -u origin feature/x && gh pr create --title test';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('tests have not run');
    });

    it('respects testing_gate: false in moflo.yaml', () => {
      writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  testing_gate: false\n');
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: false, simplifyRun: true, learningsStored: true });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('respects simplify_gate: false in moflo.yaml', () => {
      writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  simplify_gate: false\n');
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: true, simplifyRun: false, learningsStored: true });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('respects learnings_gate: false in moflo.yaml', () => {
      writeFileSync(join(tmpDir, 'moflo.yaml'), 'gates:\n  learnings_gate: false\n');
      const env = baseEnv(tmpDir);
      writeState(tmpDir, { testsRun: true, simplifyRun: true, learningsStored: false });
      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('learningsStored persists across prompts (session-scoped)', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'first task';
      runGate('prompt-reminder', env);
      runGate('record-learnings-stored', env);
      let s = readState(tmpDir);
      expect(s.learningsStored).toBe(true);

      // New prompt does NOT reset — learningsStored is session-scoped
      env.CLAUDE_USER_PROMPT = 'second task needs a pr';
      runGate('prompt-reminder', env);
      s = readState(tmpDir);
      expect(s.learningsStored).toBe(true);
    });
  });

  describe('record-test-run', () => {
    function expectTestsRecognised(cmd: string) {
      writeState(tmpDir, { testsRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = cmd;
      runGate('record-test-run', env);
      expect(readState(tmpDir).testsRun, `should recognise: ${cmd}`).toBe(true);
    }

    function expectTestsNotRecognised(cmd: string) {
      writeState(tmpDir, { testsRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = cmd;
      runGate('record-test-run', env);
      expect(readState(tmpDir).testsRun, `should not recognise: ${cmd}`).toBe(false);
    }

    it('recognises common test runners', () => {
      [
        'npm test',
        'npm run test',
        'npm run test:unit',
        'yarn test',
        'pnpm test',
        'pnpm t',
        'npx vitest run',
        'npx jest',
        'vitest run --reporter=verbose',
        'jest --coverage',
        'pytest -x',
        'cargo test',
        'go test ./...',
        'deno test',
        'dotnet test',
        'mvn test',
        'gradle test',
        './gradlew test',
      ].forEach(expectTestsRecognised);
    });

    it('does not recognise unrelated bash commands', () => {
      [
        'git status',
        'ls -la',
        'npm install',
        'echo testing',
        'grep test src/',
        // Common false-positive shapes — runner name appears as an argument,
        // dependency, search target, or commit message but no tests run.
        'npm install jest',
        'npm install --save-dev vitest',
        'pnpm add -D pytest',
        'grep -r vitest src/',
        'git commit -m "add jest config"',
        'echo "running pytest"',
        'cat package.json | grep jest',
      ].forEach(expectTestsNotRecognised);
    });

    it('always exits 0 (never blocks)', () => {
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = 'rm -rf /';
      const r = runGate('record-test-run', env);
      expect(r.exitCode).toBe(0);
    });

    it('emits stderr crumb on no-op when TOOL_INPUT_command does not match (#1176)', () => {
      // Direct-CLI invocation (the friction case): user runs the stamp manually
      // to "satisfy the gate" with a command that doesn't look like a test runner.
      // Silent no-op pre-#1176 made this indistinguishable from success.
      writeState(tmpDir, { testsRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_command = 'git status';
      const r = runGate('record-test-run', env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('record-test-run no-op');
      expect(r.stderr).toContain('TEST_RUNNER_RE');
      expect(readState(tmpDir).testsRun).toBe(false);
    });

    it('does not emit stderr crumb when command is empty (#1176 — hook-fired with no command)', () => {
      writeState(tmpDir, { testsRun: false });
      const env = baseEnv(tmpDir);
      // No TOOL_INPUT_command — would emit a noisy warning on every hook fire if
      // we didn't guard for empty.
      const r = runGate('record-test-run', env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
    });
  });

  describe('record-skill-run', () => {
    it('sets simplifyRun=true when /simplify is invoked (built-in or legacy name — backward compat)', () => {
      writeState(tmpDir, { simplifyRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_skill = 'simplify';
      runGate('record-skill-run', env);
      expect(readState(tmpDir).simplifyRun).toBe(true);
    });

    it('sets simplifyRun=true when /flo-simplify is invoked (renamed moflo skill)', () => {
      writeState(tmpDir, { simplifyRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_skill = 'flo-simplify';
      runGate('record-skill-run', env);
      expect(readState(tmpDir).simplifyRun).toBe(true);
    });

    it('does not set simplifyRun for other skills', () => {
      writeState(tmpDir, { simplifyRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_skill = 'eldar';
      runGate('record-skill-run', env);
      expect(readState(tmpDir).simplifyRun).toBe(false);
    });

    it('always exits 0 (never blocks)', () => {
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_skill = 'simplify';
      const r = runGate('record-skill-run', env);
      expect(r.exitCode).toBe(0);
    });

    it('emits stderr crumb on no-op when TOOL_INPUT_skill is not simplify/flo-simplify (#1176)', () => {
      writeState(tmpDir, { simplifyRun: false });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_skill = 'eldar';
      const r = runGate('record-skill-run', env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('record-skill-run no-op');
      expect(r.stderr).toContain('"eldar"');
      expect(readState(tmpDir).simplifyRun).toBe(false);
    });

    it('does not emit stderr crumb when TOOL_INPUT_skill is empty (#1176)', () => {
      writeState(tmpDir, { simplifyRun: false });
      const env = baseEnv(tmpDir);
      // No TOOL_INPUT_skill — empty-string is the hook-fired-without-skill case.
      const r = runGate('record-skill-run', env);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
    });
  });

  describe('reset-edit-gates', () => {
    it('resets testsRun and simplifyRun on source edits', () => {
      writeState(tmpDir, { testsRun: true, simplifyRun: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/src/index.ts';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir);
      expect(s.testsRun).toBe(false);
      expect(s.simplifyRun).toBe(false);
    });

    it('does not reset for markdown edits', () => {
      writeState(tmpDir, { testsRun: true, simplifyRun: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/README.md';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir);
      expect(s.testsRun).toBe(true);
      expect(s.simplifyRun).toBe(true);
    });

    it('does not reset for inert files (lockfiles, .gitignore, CHANGELOG, .env.example)', () => {
      const env = baseEnv(tmpDir);
      for (const fp of [
        '/project/package-lock.json',
        '/project/.gitignore',
        '/project/CHANGELOG.md',
        '/project/.env.example',
      ]) {
        writeState(tmpDir, { testsRun: true, simplifyRun: true });
        env.TOOL_INPUT_file_path = fp;
        runGate('reset-edit-gates', env);
        const s = readState(tmpDir);
        expect(s.testsRun, `should not reset for ${fp}`).toBe(true);
        expect(s.simplifyRun, `should not reset for ${fp}`).toBe(true);
      }
    });

    it('DOES reset for package.json and moflo.yaml edits', () => {
      // These ARE source files — editing them changes runtime behavior, so
      // tests/simplify must rerun before opening a PR.
      const env = baseEnv(tmpDir);
      for (const fp of ['/project/package.json', '/project/moflo.yaml', '/project/tsconfig.json']) {
        writeState(tmpDir, { testsRun: true, simplifyRun: true });
        env.TOOL_INPUT_file_path = fp;
        runGate('reset-edit-gates', env);
        const s = readState(tmpDir);
        expect(s.testsRun, `should reset for ${fp}`).toBe(false);
        expect(s.simplifyRun, `should reset for ${fp}`).toBe(false);
      }
    });

    it('always exits 0 (never blocks)', () => {
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/src/index.ts';
      const r = runGate('reset-edit-gates', env);
      expect(r.exitCode).toBe(0);
    });

    it('is a no-op when both flags already false', () => {
      writeState(tmpDir, { testsRun: false, simplifyRun: false, taskCount: 5 });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/src/index.ts';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir);
      expect(s.taskCount).toBe(5); // other state preserved
    });

    it('does not reset for .github/workflows/*.yml edits (#1176 inert path)', () => {
      const env = baseEnv(tmpDir);
      // Path-based inertness covers CI config — runtime surface is untouched.
      for (const fp of [
        '/project/.github/workflows/ci.yml',
        '/project/.github/workflows/release.yaml',
        '/project/.github/workflows/cost-tracking.yml',
      ]) {
        writeState(tmpDir, { testsRun: true, simplifyRun: true });
        env.TOOL_INPUT_file_path = fp;
        runGate('reset-edit-gates', env);
        const s = readState(tmpDir);
        expect(s.testsRun, `should not reset for ${fp}`).toBe(true);
        expect(s.simplifyRun, `should not reset for ${fp}`).toBe(true);
      }
    });

    it('does not reset for .github/ISSUE_TEMPLATE and PULL_REQUEST_TEMPLATE edits (#1176)', () => {
      const env = baseEnv(tmpDir);
      for (const fp of [
        '/project/.github/ISSUE_TEMPLATE/bug.md',
        '/project/.github/ISSUE_TEMPLATE/config.yml',
        '/project/.github/PULL_REQUEST_TEMPLATE.md',
        '/project/.github/PULL_REQUEST_TEMPLATE/feature.md',
      ]) {
        writeState(tmpDir, { testsRun: true, simplifyRun: true });
        env.TOOL_INPUT_file_path = fp;
        runGate('reset-edit-gates', env);
        const s = readState(tmpDir);
        expect(s.testsRun, `should not reset for ${fp}`).toBe(true);
        expect(s.simplifyRun, `should not reset for ${fp}`).toBe(true);
      }
    });

    it('STILL resets for moflo.yaml even though it is .yaml (#1176 — path-based, not extension-based)', () => {
      // Regression guard: the path-based inert RE must NOT exempt every YAML
      // file; moflo.yaml is source — editing it changes daemon/gate behavior.
      writeState(tmpDir, { testsRun: true, simplifyRun: true });
      const env = baseEnv(tmpDir);
      env.TOOL_INPUT_file_path = '/project/moflo.yaml';
      runGate('reset-edit-gates', env);
      const s = readState(tmpDir);
      expect(s.testsRun).toBe(false);
      expect(s.simplifyRun).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.cjs — per-actor memory-first enforcement (#838)
// The legacy `memorySearched` boolean is session-wide and short-circuits the
// gate for every actor as soon as the parent searches once. When the
// gate-hook forwards Claude Code's session_id as HOOK_SESSION_ID, the gate
// must enforce per-session: a fresh subagent (unknown session_id) gets
// blocked even when the parent already satisfied its own gate.
// ─────────────────────────────────────────────────────────────────────────────

describe('gate.cjs: per-actor memory-first (#838)', () => {
  it('blocks scan for an unknown subagent session even when parent has searched', () => {
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: { 'parent-session-1': true },
    });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-fresh';
    env.TOOL_INPUT_pattern = '**/*.ts';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('allows scan for a subagent session that has already searched', () => {
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: {
        'parent-session-1': true,
        'subagent-session-A': true,
      },
    });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-A';
    env.TOOL_INPUT_pattern = '**/*.ts';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });

  it('blocks read for an unknown subagent session', () => {
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: { 'parent-session-1': true },
    });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-fresh';
    env.TOOL_INPUT_file_path = '/project/src/index.ts';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('allows read for a subagent session that is in the map', () => {
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: { 'subagent-session-B': true },
    });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-B';
    env.TOOL_INPUT_file_path = '/project/src/index.ts';
    const r = runGate('check-before-read', env);
    expect(r.exitCode).toBe(0);
  });

  it('record-memory-searched stamps the per-actor map when HOOK_SESSION_ID is set', () => {
    writeState(tmpDir, { memorySearched: false, memorySearchedBy: {} });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-X';
    runGate('record-memory-searched', env);
    const s = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(s.memorySearched).toBe(true);
    expect(s.memorySearchedBy['subagent-session-X']).toBe(true);
  });

  it('record-memory-searched without HOOK_SESSION_ID still updates the legacy bool only', () => {
    writeState(tmpDir, { memorySearched: false, memorySearchedBy: {} });
    runGate('record-memory-searched', baseEnv(tmpDir));
    const s = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(s.memorySearched).toBe(true);
    expect(Object.keys(s.memorySearchedBy)).toHaveLength(0);
  });

  it('check-bash-memory stamps the per-actor map when HOOK_SESSION_ID is set', () => {
    writeState(tmpDir, { memorySearched: false, memorySearchedBy: {} });
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-Y';
    env.TOOL_INPUT_command = 'npx flo-search semantic-search "auth"';
    runGate('check-bash-memory', env);
    const s = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(s.memorySearched).toBe(true);
    expect(s.memorySearchedBy['subagent-session-Y']).toBe(true);
  });

  it('check-bash-memory does not rewrite state when the actor is already marked', () => {
    // Hot-path: a subagent that runs flo-search repeatedly should not fsync
    // workflow-state.json on every invocation once it is already satisfied.
    writeState(tmpDir, {
      memorySearched: true,
      memorySearchedBy: { 'subagent-session-Z': true },
    });
    const stateFile = join(tmpDir, '.claude', 'workflow-state.json');
    const mtimeBefore = readState(tmpDir);
    void mtimeBefore;
    const before = readFileSync(stateFile, 'utf-8');
    const env = baseEnv(tmpDir);
    env.HOOK_SESSION_ID = 'subagent-session-Z';
    env.TOOL_INPUT_command = 'npx flo-search semantic-search "auth"';
    runGate('check-bash-memory', env);
    const after = readFileSync(stateFile, 'utf-8');
    expect(after).toBe(before);
  });

  it('prompt-reminder clears the per-actor map (new prompt = clean window)', () => {
    writeState(tmpDir, {
      memorySearched: true,
      memorySearchedBy: { 'parent': true, 'subA': true },
    });
    const env = baseEnv(tmpDir);
    env.CLAUDE_USER_PROMPT = 'fix the next bug please';
    runGate('prompt-reminder', env);
    const s = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(s.memorySearched).toBe(false);
    expect(s.memorySearchedBy).toEqual({});
  });

  it('session-reset clears the per-actor map', () => {
    writeState(tmpDir, {
      memorySearched: true,
      memorySearchedBy: { 'a': true, 'b': true },
    });
    runGate('session-reset', baseEnv(tmpDir));
    const s = readState(tmpDir) as { memorySearchedBy: Record<string, boolean> };
    expect(s.memorySearchedBy).toEqual({});
  });

  it('end-to-end: parent satisfies, subagent blocked, subagent searches, subagent allowed', () => {
    writeState(tmpDir, { memoryRequired: true, memorySearched: false, memorySearchedBy: {} });

    // 1. Parent searches memory (no HOOK_SESSION_ID forwarded for the parent
    //    when the host is older / the parent's session_id is the default).
    //    Even with a parent session id, this test focuses on the subagent path.
    const parentEnv = baseEnv(tmpDir);
    parentEnv.HOOK_SESSION_ID = 'parent-S';
    runGate('record-memory-searched', parentEnv);

    // 2. Fresh subagent attempts Grep — should BLOCK because its session_id
    //    isn't in the map yet, even though `memorySearched` is true.
    const subEnv = baseEnv(tmpDir);
    subEnv.HOOK_SESSION_ID = 'sub-S-1';
    subEnv.TOOL_INPUT_pattern = 'src/**/*.ts';
    let r = runGate('check-before-scan', subEnv);
    expect(r.exitCode).toBe(2);

    // 3. Subagent does its own memory search.
    runGate('record-memory-searched', subEnv);

    // 4. Subagent retries Grep — now allowed.
    r = runGate('check-before-scan', subEnv);
    expect(r.exitCode).toBe(0);

    // 5. A second subagent (different session_id) is still blocked until it
    //    too searches — proving the map is per-actor, not per-session-once.
    const sub2Env = baseEnv(tmpDir);
    sub2Env.HOOK_SESSION_ID = 'sub-S-2';
    sub2Env.TOOL_INPUT_pattern = 'src/**/*.ts';
    r = runGate('check-before-scan', sub2Env);
    expect(r.exitCode).toBe(2);
  });

  it('legacy callers (no HOOK_SESSION_ID) still see the old session-wide behavior', () => {
    // Existing tests assume gate.cjs invocations without HOOK_SESSION_ID
    // behave exactly like before — the bool drives the gate. Pin that.
    writeState(tmpDir, { memoryRequired: true, memorySearched: true });
    const env = baseEnv(tmpDir);
    delete env.HOOK_SESSION_ID;
    env.TOOL_INPUT_pattern = '**/*.ts';
    const r = runGate('check-before-scan', env);
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate-hook.mjs — forwards stdin session_id as HOOK_SESSION_ID (#838)
// ─────────────────────────────────────────────────────────────────────────────

describe('gate-hook.mjs: session_id forwarding (#838)', () => {
  it('blocks a fresh subagent scan even when parent has already satisfied the gate', async () => {
    // Parent has searched (legacy bool true) and is in the per-actor map.
    // Fresh subagent comes in via stdin with a new session_id — should block.
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: { 'parent-session': true },
    });
    const r = await runEsmWithStdin(GATE_HOOK, ['check-before-scan'], {
      session_id: 'fresh-subagent-session',
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO', path: 'src/' },
      hook_event_name: 'PreToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  });

  it('allows the fresh subagent scan after it records its own memory search', async () => {
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: true,
      memorySearchedBy: { 'parent-session': true, 'subagent-A': true },
    });
    const r = await runEsmWithStdin(GATE_HOOK, ['check-before-scan'], {
      session_id: 'subagent-A',
      tool_name: 'Grep',
      tool_input: { pattern: 'TODO', path: 'src/' },
      hook_event_name: 'PreToolUse',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });

  it('record-memory-searched via gate-hook stamps the map keyed on stdin session_id', async () => {
    writeState(tmpDir, { memorySearched: false, memorySearchedBy: {} });
    await runEsmWithStdin(GATE_HOOK, ['record-memory-searched'], {
      session_id: 'subagent-Z',
      tool_name: 'mcp__moflo__memory_search',
      tool_input: { query: 'auth', namespace: 'guidance' },
      hook_event_name: 'PostToolUse',
    }, baseEnv(tmpDir));
    const s = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(s.memorySearched).toBe(true);
    expect(s.memorySearchedBy['subagent-Z']).toBe(true);
  });
});

// ── Settings.json PostToolUse Matcher Validation ────────────────────────────
// Verifies that the hook matchers in settings.json correctly match MCP tool names.
// This catches the class of bug where a generic matcher is shadowed by a specific one.

describe('settings.json: PostToolUse matcher coverage', () => {
  const settingsPath = resolve(__dirname, '../../.claude/settings.json');
  let postToolUseMatchers: Array<{ matcher: string; hooks: Array<{ command: string }> }>;

  // Load settings once
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    postToolUseMatchers = settings.hooks?.PostToolUse ?? [];
  } catch {
    postToolUseMatchers = [];
  }

  // Claude Code fires ALL matching entries for a tool, not just the first —
  // and it requires the matcher regex to match the WHOLE tool name (anchored
  // semantics). A bare `new RegExp(matcher).test(name)` partial-matches, which
  // would let an unanchored matcher like `mcp__moflo__memory_` falsely appear
  // to match `mcp__moflo__memory_search` and hide regressions like #929 where
  // the hook never fires in production. Compare the captured match against
  // the full input to enforce full-match without double-anchoring matchers
  // that already start with `^` / end with `$`.
  function findAllMatchingEntries(toolName: string) {
    return postToolUseMatchers.filter(entry => {
      const m = toolName.match(new RegExp(entry.matcher));
      return m !== null && m[0] === toolName;
    });
  }
  function allCommandsFor(toolName: string): string[] {
    return findAllMatchingEntries(toolName).flatMap(e => e.hooks.map(h => h.command));
  }

  it('mcp__moflo__memory_search matches record-memory-searched hook', () => {
    const cmds = allCommandsFor('mcp__moflo__memory_search');
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(true);
  });

  it('mcp__moflo__memory_retrieve matches record-memory-searched hook', () => {
    const cmds = allCommandsFor('mcp__moflo__memory_retrieve');
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(true);
  });

  it('mcp__moflo__memory_store matches record-learnings-stored hook', () => {
    const cmds = allCommandsFor('mcp__moflo__memory_store');
    expect(cmds.some(c => c.includes('record-learnings-stored'))).toBe(true);
  });

  it('mcp__moflo__memory_store also matches record-memory-searched hook', () => {
    const cmds = allCommandsFor('mcp__moflo__memory_store');
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(true);
  });

  it('non-memory MCP tools do not match memory matchers', () => {
    const cmds = allCommandsFor('mcp__moflo__spell_cast');
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(false);
    expect(cmds.some(c => c.includes('record-learnings-stored'))).toBe(false);
  });

  it('Bash matches record-test-run hook', () => {
    const cmds = allCommandsFor('Bash');
    expect(cmds.some(c => c.includes('record-test-run'))).toBe(true);
  });

  it('Skill matches record-skill-run hook', () => {
    const cmds = allCommandsFor('Skill');
    expect(cmds.some(c => c.includes('record-skill-run'))).toBe(true);
  });

  it('Write matches reset-edit-gates hook', () => {
    const cmds = allCommandsFor('Write');
    expect(cmds.some(c => c.includes('reset-edit-gates'))).toBe(true);
  });

  it('Edit matches reset-edit-gates hook', () => {
    const cmds = allCommandsFor('Edit');
    expect(cmds.some(c => c.includes('reset-edit-gates'))).toBe(true);
  });

  it('MultiEdit matches reset-edit-gates hook', () => {
    const cmds = allCommandsFor('MultiEdit');
    expect(cmds.some(c => c.includes('reset-edit-gates'))).toBe(true);
  });

  // ── Issue #879 — wiring: session_id-dependent hooks must use gate-hook.mjs ──
  // Calling gate.cjs directly skips the stdin-reading wrapper that forwards
  // Claude Code's session_id as HOOK_SESSION_ID. Without it, the per-actor
  // map (memorySearchedBy[sid]) stays empty and the gate blocks every Read.
  function commandFor(tool: string, action: string): string | undefined {
    return allCommandsFor(tool).find(c => c.includes(action));
  }

  it('record-memory-searched is wired through gate-hook.mjs (#879)', () => {
    const cmd = commandFor('mcp__moflo__memory_search', 'record-memory-searched');
    expect(cmd).toBeDefined();
    expect(cmd).toContain('gate-hook.mjs');
    expect(cmd).not.toMatch(/gate\.cjs"\s+record-memory-searched/);
  });

  it('check-bash-memory is NOT in PostToolUse[Bash] anymore (#1132)', () => {
    // #1132 — moved to PreToolUse so process.exit(2) can actually block.
    const cmd = commandFor('Bash', 'check-bash-memory');
    expect(cmd).toBeUndefined();
  });

  it('check-bash-memory is wired into PreToolUse[Bash] via gate-hook.mjs (#1132)', () => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const preToolUse = (settings.hooks?.PreToolUse ?? []) as Array<{
      matcher: string;
      hooks: Array<{ command: string }>;
    }>;
    const bashEntry = preToolUse.find(e => 'Bash'.match(new RegExp(e.matcher))?.[0] === 'Bash');
    expect(bashEntry, 'no PreToolUse entry matches Bash').toBeDefined();
    const cmd = bashEntry!.hooks.find(h => h.command.includes('check-bash-memory'));
    expect(cmd, 'check-bash-memory not present in PreToolUse[Bash]').toBeDefined();
    expect(cmd!.command).toContain('gate-hook.mjs');
    // #879 — must NOT call gate.cjs directly (session_id forwarding).
    expect(cmd!.command).not.toMatch(/gate\.cjs"\s+check-bash-memory/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #879 — production round-trip: record→check across the wrapper boundary
// Simulates exactly what Claude Code does: post-hook for memory_search via
// gate-hook.mjs (which forwards stdin session_id), then pre-hook for Read via
// gate-hook.mjs (same session_id). The per-actor map must be stamped by the
// post-hook so the pre-hook doesn't block.
// ─────────────────────────────────────────────────────────────────────────────

describe('production round-trip: record-memory-searched → check-before-read (#879)', () => {
  it('parent searches memory via gate-hook then reads — must NOT block', async () => {
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: false,
      memorySearchedBy: {},
    });

    // 1. Post-hook fires after mcp__moflo__memory_search — gate-hook.mjs reads
    //    stdin session_id and forwards it as HOOK_SESSION_ID to gate.cjs.
    const searchCtx = {
      session_id: 'parent-roundtrip',
      tool_name: 'mcp__moflo__memory_search',
      tool_input: { query: 'auth', namespace: 'guidance' },
      hook_event_name: 'PostToolUse',
    };
    const postR = await runEsmWithStdin(GATE_HOOK, ['record-memory-searched'], searchCtx, baseEnv(tmpDir));
    expect(postR.exitCode).toBe(0);

    // 2. State must reflect the per-actor stamp.
    const after = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(after.memorySearched).toBe(true);
    expect(after.memorySearchedBy['parent-roundtrip']).toBe(true);

    // 3. Pre-hook fires before Read — same session_id forwarded — must allow.
    const readCtx = {
      session_id: 'parent-roundtrip',
      tool_name: 'Read',
      tool_input: { file_path: '/project/src/index.ts' },
      hook_event_name: 'PreToolUse',
    };
    const preR = await runEsmWithStdin(GATE_HOOK, ['check-before-read'], readCtx, baseEnv(tmpDir));
    expect(preR.exitCode).toBe(0);
  });

  it('regression: record via gate.cjs DIRECTLY leaves the per-actor map empty', async () => {
    // This documents the failure mode the fix prevents: when the post-hook is
    // wired to gate.cjs directly (no wrapper), HOOK_SESSION_ID isn't forwarded,
    // so markMemorySearched only updates the legacy bool — and the pre-hook
    // (which DOES go through gate-hook.mjs) blocks because the map is empty.
    writeState(tmpDir, {
      memoryRequired: true,
      memorySearched: false,
      memorySearchedBy: {},
    });

    // Direct gate.cjs call — no wrapper, no HOOK_SESSION_ID.
    const env = baseEnv(tmpDir);
    delete env.HOOK_SESSION_ID;
    runGate('record-memory-searched', env);

    const after = readState(tmpDir) as { memorySearched: boolean; memorySearchedBy: Record<string, boolean> };
    expect(after.memorySearched).toBe(true);          // legacy bool was set
    expect(Object.keys(after.memorySearchedBy)).toHaveLength(0); // but the map is empty

    // Pre-hook through gate-hook.mjs WITH session_id — sees empty map, blocks.
    const readCtx = {
      session_id: 'parent-roundtrip',
      tool_name: 'Read',
      tool_input: { file_path: '/project/src/index.ts' },
      hook_event_name: 'PreToolUse',
    };
    const preR = await runEsmWithStdin(GATE_HOOK, ['check-before-read'], readCtx, baseEnv(tmpDir));
    expect(preR.exitCode).toBe(2);
    expect(preR.stderr).toContain('BLOCKED');
  });
});
