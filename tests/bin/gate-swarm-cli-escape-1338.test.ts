/**
 * The #952 swarm/hive gate must be satisfiable without MCP (#1338 follow-up).
 *
 * `record-swarm-init` / `record-hive-init` fired only on `mcp__moflo__swarm_init`
 * / `mcp__moflo__hive-mind_init`. Claude Code spawns stdio MCP servers once at
 * session start and never respawns them, so a session that lost its moflo
 * server hit `/fl -s` with NO way to satisfy the gate: every Agent spawn hard
 * blocked, telling the reader to call a tool that did not exist in that session.
 * Unlike the memory_first gate — which at least had an unadvertised CLI escape —
 * this one had none short of disabling the gate in moflo.yaml.
 *
 * The CLI is a real satisfaction of the gate, not a stand-in: `flo swarm init`
 * dispatches in-process through the same TOOL_REGISTRY handler the MCP server
 * exposes (`mcp-client.ts` callMCPTool), and the swarm is persisted, so a later
 * process sees the same swarmId. Verified by hand against the installed CLI
 * before this recorder was written.
 *
 * Two invariants matter most and are asserted below:
 *   1. Only a *succeeded* init credits. The recorder is wired PostToolUse,
 *      which Claude Code does not fire on a non-zero exit (#1322). Crediting a
 *      failed init would open the gate with no swarm behind it — the silent
 *      degradation CLAUDE.md's protected-functionality rule forbids.
 *   2. Swarm and hive credit their OWN flag only. Cross-crediting would let
 *      `/fl -h` proceed on a swarm that is not a hive.
 *
 * Cross-platform (Rule #1): the invocation forms include `npx.cmd` and a
 * backslash-separated path, because the matcher keys on command basename.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { REQUIRED_HOOK_WIRING, HOOK_ENTRY_MAP, repairHookWiring } from '../../src/cli/services/hook-wiring.js';
import { getReferenceHookBlock } from '../../src/cli/services/hook-block-hash.js';
import { generateGateScript } from '../../src/cli/init/helpers-generator.js';

const GATE = resolve(__dirname, '../../bin/gate.cjs');

let root: string;

function runGate(command: string, extra: Record<string, string> = {}, script = GATE) {
  const r = spawnSync(process.execPath, [script, command], {
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: root,
      TOOL_INPUT_command: '',
      HOOK_SESSION_ID: '',
      ...extra,
    },
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

/** Run a command through the CLI-init recorder and report what it credited. */
function recorded(cmd: string, script = GATE) {
  writeState({ flMode: 'swarm', swarmInitialized: false, hiveInitialized: false });
  runGate('record-bash-swarm-init', { TOOL_INPUT_command: cmd }, script);
  const s = readState();
  return { swarm: s.swarmInitialized === true, hive: s.hiveInitialized === true };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-swarm-cli-')));
  mkdirSync(join(root, '.claude'), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows may hold handles — non-fatal */
  }
});

describe('the swarm/hive block names the CLI route', () => {
  it('swarm mode names flo swarm init', () => {
    writeState({ flMode: 'swarm', swarmInitialized: false });
    const r = runGate('check-before-agent');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npx flo swarm init');
    expect(r.stderr).toContain('MCP server not connected');
  });

  it('hive mode names flo hive-mind init', () => {
    writeState({ flMode: 'hive', hiveInitialized: false });
    const r = runGate('check-before-agent');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npx flo hive-mind init');
  });
});

describe('blocked → run the CLI init → unblocked (the escape that did not exist)', () => {
  it('swarm', () => {
    writeState({ flMode: 'swarm', swarmInitialized: false });
    expect(runGate('check-before-agent').status).toBe(2);

    runGate('record-bash-swarm-init', { TOOL_INPUT_command: 'npx flo swarm init --topology hierarchical' });
    expect(readState().swarmInitialized).toBe(true);

    const after = runGate('check-before-agent');
    expect(after.stderr).not.toContain('BLOCKED');
    expect(after.status).toBe(0);
  });

  it('hive', () => {
    writeState({ flMode: 'hive', hiveInitialized: false });
    expect(runGate('check-before-agent').status).toBe(2);

    runGate('record-bash-swarm-init', { TOOL_INPUT_command: 'npx flo hive-mind init' });
    expect(readState().hiveInitialized).toBe(true);
    expect(runGate('check-before-agent').status).toBe(0);
  });
});

describe('only a real init credits, and only its own mode', () => {
  it.each([
    ['flo swarm init'],
    ['npx flo swarm init --topology mesh --max-agents 5'],
    ['npx.cmd flo swarm init'],
    ['node .\\node_modules\\moflo\\bin\\cli.js swarm init'],
    ['cd /workspace/proj && npx flo swarm init'],
  ])('credits swarm for %s', (cmd) => {
    expect(recorded(cmd)).toEqual({ swarm: true, hive: false });
  });

  it.each([
    ['flo hive-mind init'],
    ['npx flo hive-mind init --workers 4'],
    ['npx flo hive init'],
  ])('credits hive for %s', (cmd) => {
    expect(recorded(cmd)).toEqual({ swarm: false, hive: true });
  });

  it.each([
    ['echo "flo swarm init"'],
    ['git commit -m "wire flo swarm init into the gate"'],
    ['flo swarm status'],
    ['flo swarm'],
    ['git init'],
    ['npm init -y'],
    ['flo memory search --query "swarm init"'],
  ])('credits nothing for %s', (cmd) => {
    expect(recorded(cmd)).toEqual({ swarm: false, hive: false });
  });
});

describe('the recorder is wired where only success reaches it', () => {
  // The whole honesty argument rests on this: PostToolUse does not fire when a
  // command exits non-zero (#1322), so a failed `flo swarm init` cannot credit.
  // If someone moves this to PreToolUse, the gate starts opening on failures.
  it('is a PostToolUse hook, not PreToolUse', () => {
    const req = REQUIRED_HOOK_WIRING.find((h) => h.pattern === 'record-bash-swarm-init');
    expect(req?.event).toBe('PostToolUse');
    expect(HOOK_ENTRY_MAP['record-bash-swarm-init'].event).toBe('PostToolUse');
  });

  it('rides the Bash/PowerShell block, so PowerShell sessions record too (Rule #1)', () => {
    expect(HOOK_ENTRY_MAP['record-bash-swarm-init'].matcher).toBe('^(Bash|PowerShell)$');
    const post = getReferenceHookBlock().PostToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const block = post.find((b) => b.matcher === '^(Bash|PowerShell)$');
    expect(block?.hooks.some((h) => h.command.includes('record-bash-swarm-init'))).toBe(true);
  });

  it('grafts itself into an existing consumer that predates it', () => {
    // Without the REQUIRED_HOOK_WIRING entry, only consumers who re-run
    // `flo init` would get the escape — everyone else keeps the deadlock.
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: '^(Bash|PowerShell)$',
            hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-test-run', timeout: 2000 }],
          },
        ],
      },
    };
    const { settings: repaired, repaired: fixed } = repairHookWiring(settings);
    expect(fixed).toContain('record-bash-swarm-init');

    const block = (repaired.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>)
      .PostToolUse.find((b) => b.matcher === '^(Bash|PowerShell)$');
    expect(block?.hooks.some((h) => h.command.includes('record-bash-swarm-init'))).toBe(true);
  });
});

describe('the flo-init fallback template carries the same escape', () => {
  let script: string;

  beforeEach(() => {
    script = join(root, 'generated-gate.cjs');
    writeFileSync(script, generateGateScript());
  });

  it('names the CLI route when it blocks', () => {
    writeState({ flMode: 'swarm', swarmInitialized: false });
    const r = runGate('check-before-agent', {}, script);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npx flo swarm init');
  });

  it('records a real init and ignores a mention', () => {
    expect(recorded('npx flo swarm init', script)).toEqual({ swarm: true, hive: false });
    expect(recorded('echo "flo swarm init"', script)).toEqual({ swarm: false, hive: false });
  });
});
