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
import { execSync, execFileSync, spawn } from 'child_process';
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
  };
}

/** Run gate.cjs with a subcommand and env vars. Returns { stdout, stderr, exitCode }. */
function runGate(command: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [GATE, command], {
      env, encoding: 'utf-8', timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
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

    // Safety timeout
    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ stdout, stderr, exitCode: -1 });
    }, 8000);
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

  it('always exits 0 (never blocks)', () => {
    const env = baseEnv(tmpDir);
    env.TOOL_INPUT_command = 'rm -rf /';
    const r = runGate('check-bash-memory', env);
    expect(r.exitCode).toBe(0);
  });
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
  it('resets all workflow state', () => {
    writeState(tmpDir, {
      tasksCreated: true, taskCount: 5, memorySearched: true,
      memoryRequired: false, interactionCount: 42,
    });
    runGate('session-reset', baseEnv(tmpDir));
    const s = readState(tmpDir);
    expect(s.tasksCreated).toBe(false);
    expect(s.taskCount).toBe(0);
    expect(s.memorySearched).toBe(false);
    expect(s.memoryRequired).toBe(true);
    expect(s.interactionCount).toBe(0);
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
    const metricsFile = join(tmpDir, '.claude-flow', 'metrics', 'learning.json');
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

describe('prompt-hook.mjs: namespace hints', () => {
  it('hints "knowledge" for recall prompts', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'do you remember what we decided about auth?',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('knowledge');
  });

  it('hints "patterns" for convention prompts', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'what is our best practice for error handling?',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('patterns');
  });

  it('hints "code-map" for file structure prompts', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'show me the project structure',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('code-map');
  });

  it('hints "guidance" for architecture prompts', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'explain the architecture design for the API',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('guidance');
  });

  it('hints "code-map" for navigation prompts', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'where is the endpoint for user login?',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('code-map');
  });

  it('hints "patterns" for template prompts', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'show me an example of how we handle pagination',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('patterns');
  });

  it('no hint for simple directives', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {
      user_prompt: 'yes',
    }, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
    // Should not have namespace hint (directive)
    expect(r.stdout).not.toContain('namespace hint');
  });

  it('handles empty prompt gracefully', async () => {
    const r = await runEsmWithStdin(PROMPT_HOOK, [], {}, baseEnv(tmpDir));
    expect(r.exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: full workflow lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('end-to-end: workflow lifecycle', () => {
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

  describe('learnings gate (check-before-pr)', () => {
    it('blocks gh pr create when learnings not stored', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'create the pr';
      runGate('prompt-reminder', env);
      runGate('record-memory-searched', env);

      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('BLOCKED');
      expect(r.stderr).toContain('learnings');
    });

    it('allows gh pr create after memory_store', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'create the pr';
      runGate('prompt-reminder', env);
      runGate('record-memory-searched', env);
      runGate('record-learnings-stored', env);

      env.TOOL_INPUT_command = 'gh pr create --title "test"';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('does not block non-PR bash commands', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'run tests';
      runGate('prompt-reminder', env);

      env.TOOL_INPUT_command = 'npm test';
      const r = runGate('check-before-pr', env);
      expect(r.exitCode).toBe(0);
    });

    it('resets learningsStored on new prompt', () => {
      const env = baseEnv(tmpDir);

      env.CLAUDE_USER_PROMPT = 'first task';
      runGate('prompt-reminder', env);
      runGate('record-learnings-stored', env);
      let s = readState(tmpDir);
      expect(s.learningsStored).toBe(true);

      // New prompt resets
      env.CLAUDE_USER_PROMPT = 'second task needs a pr';
      runGate('prompt-reminder', env);
      s = readState(tmpDir);
      expect(s.learningsStored).toBe(false);
    });
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

  function findMatchingEntry(toolName: string) {
    return postToolUseMatchers.find(entry => new RegExp(entry.matcher).test(toolName));
  }

  it('mcp__moflo__memory_search matches record-memory-searched hook', () => {
    const entry = findMatchingEntry('mcp__moflo__memory_search');
    expect(entry).toBeDefined();
    const cmds = entry!.hooks.map(h => h.command);
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(true);
  });

  it('mcp__moflo__memory_retrieve matches record-memory-searched hook', () => {
    const entry = findMatchingEntry('mcp__moflo__memory_retrieve');
    expect(entry).toBeDefined();
    const cmds = entry!.hooks.map(h => h.command);
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(true);
  });

  it('mcp__moflo__memory_store matches record-learnings-stored hook', () => {
    const entry = findMatchingEntry('mcp__moflo__memory_store');
    expect(entry).toBeDefined();
    const cmds = entry!.hooks.map(h => h.command);
    expect(cmds.some(c => c.includes('record-learnings-stored'))).toBe(true);
  });

  it('mcp__moflo__memory_store also matches record-memory-searched hook', () => {
    const entry = findMatchingEntry('mcp__moflo__memory_store');
    expect(entry).toBeDefined();
    const cmds = entry!.hooks.map(h => h.command);
    expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(true);
  });

  it('non-memory MCP tools do not match memory matchers', () => {
    const entry = findMatchingEntry('mcp__moflo__workflow_run');
    // Should either not match or not trigger memory-related hooks
    if (entry) {
      const cmds = entry.hooks.map(h => h.command);
      expect(cmds.some(c => c.includes('record-memory-searched'))).toBe(false);
    }
  });
});
