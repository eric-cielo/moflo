#!/usr/bin/env node
/**
 * Comprehensive WSL + bwrap verification probe.
 *
 * Exercises the real bwrap wrapping path (filesystem, network, DNS, TLS,
 * PID isolation) across every permission level and capability combination
 * we care about for epic spells. Run this BEFORE a publish that touches
 * sandbox behavior, so we can catch regressions locally instead of
 * discovering them on Linux after a round-trip.
 *
 * Usage:
 *   node scripts/verify-bwrap-wsl.mjs
 *
 * Exits 0 if all scenarios match expectations, 1 otherwise.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { buildBwrapArgs } from '../src/modules/spells/dist/core/bwrap-sandbox.js';

const WIN_PROJECT_ROOT = 'C:/Users/eric/Projects/moflo';

function wslPath(winPath) {
  return execFileSync('wsl', ['--', 'wslpath', '-a', winPath], { encoding: 'utf8' }).trim();
}

function wslHome() {
  return execFileSync('wsl', ['--', 'bash', '-lc', 'echo $HOME'], { encoding: 'utf8' }).trim();
}

function runInWsl(bwrapArgs) {
  const r = spawnSync('wsl', ['--', 'bwrap', ...bwrapArgs], { encoding: 'utf8' });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

const PROJECT_ROOT = wslPath(WIN_PROJECT_ROOT);
const HOME_DIR = wslHome();

// ── Scenarios ─────────────────────────────────────────────────────────

/**
 * Inner script exercising every surface we want to verify. Each line emits
 * a tagged token so the outer runner can grep for it independently.
 */
const INNER_SCRIPT = `
set +e

# DNS resolution
if getent hosts api.anthropic.com >/dev/null 2>&1; then echo TAG_DNS_OK; else echo TAG_DNS_FAIL; fi

# Outbound HTTPS — a curl exit code of 0 means the connection succeeded,
# regardless of HTTP status (404/401 are fine; only connect/DNS/TLS errors
# return non-zero). --max-time caps slow retries.
if curl -sS -o /dev/null --max-time 8 https://api.anthropic.com/ ; then echo TAG_HTTPS_ANTHROPIC_OK; else echo TAG_HTTPS_ANTHROPIC_FAIL; fi
if curl -sS -o /dev/null --max-time 8 https://api.github.com/ ; then echo TAG_HTTPS_GITHUB_OK; else echo TAG_HTTPS_GITHUB_FAIL; fi

# Tool-home writes (claude, gh, git, npm)
if (: >>"$HOME/.claude.json") 2>/dev/null; then echo TAG_WRITE_CLAUDE_JSON_OK; else echo TAG_WRITE_CLAUDE_JSON_FAIL; fi
if touch "$HOME/.claude/sandbox-probe.tmp" 2>/dev/null; then rm -f "$HOME/.claude/sandbox-probe.tmp"; echo TAG_WRITE_CLAUDE_DIR_OK; else echo TAG_WRITE_CLAUDE_DIR_FAIL; fi

# Root filesystem should still be read-only
if touch /etc/probe.tmp 2>/dev/null; then rm -f /etc/probe.tmp; echo TAG_ETC_UNEXPECTEDLY_WRITABLE; else echo TAG_ETC_READONLY_OK; fi

# /tmp should be a tmpfs (writable)
if touch /tmp/sandbox-probe.tmp 2>/dev/null; then rm -f /tmp/sandbox-probe.tmp; echo TAG_TMP_OK; else echo TAG_TMP_FAIL; fi
`.trim();

const scenarios = [
  {
    name: 'elevated / no-caps — epic implement-story workload',
    opts: { permissionLevel: 'elevated', homeDir: HOME_DIR },
    caps: [],
    expect: {
      mustContain: [
        'TAG_DNS_OK',
        'TAG_HTTPS_ANTHROPIC_OK',
        'TAG_HTTPS_GITHUB_OK',
        'TAG_WRITE_CLAUDE_JSON_OK',
        'TAG_WRITE_CLAUDE_DIR_OK',
        'TAG_ETC_READONLY_OK',
        'TAG_TMP_OK',
      ],
      mustNotContain: ['TAG_DNS_FAIL', 'TAG_ETC_UNEXPECTEDLY_WRITABLE'],
    },
  },
  {
    name: 'autonomous / no-caps — same network/home posture as elevated',
    opts: { permissionLevel: 'autonomous', homeDir: HOME_DIR },
    caps: [],
    expect: {
      mustContain: ['TAG_DNS_OK', 'TAG_HTTPS_ANTHROPIC_OK', 'TAG_WRITE_CLAUDE_JSON_OK', 'TAG_ETC_READONLY_OK'],
      mustNotContain: ['TAG_DNS_FAIL'],
    },
  },
  {
    name: 'readonly / no-caps — network MUST be isolated',
    opts: { permissionLevel: 'readonly', homeDir: HOME_DIR },
    caps: [],
    expect: {
      mustContain: ['TAG_DNS_FAIL', 'TAG_ETC_READONLY_OK'],
      mustNotContain: ['TAG_DNS_OK', 'TAG_HTTPS_ANTHROPIC_OK', 'TAG_ETC_UNEXPECTEDLY_WRITABLE'],
    },
  },
  {
    name: 'standard / fs:write only — network MUST be isolated',
    opts: { permissionLevel: 'standard', homeDir: HOME_DIR },
    caps: [{ type: 'fs:write' }],
    expect: {
      mustContain: ['TAG_DNS_FAIL', 'TAG_ETC_READONLY_OK'],
      mustNotContain: ['TAG_DNS_OK', 'TAG_HTTPS_ANTHROPIC_OK'],
    },
  },
  {
    name: 'standard + explicit net capability — network MUST work (no tool home)',
    opts: { permissionLevel: 'standard', homeDir: HOME_DIR },
    caps: [{ type: 'net' }, { type: 'fs:write' }],
    expect: {
      mustContain: [
        'TAG_DNS_OK',
        'TAG_HTTPS_ANTHROPIC_OK',
        'TAG_ETC_READONLY_OK',
        // standard does NOT get tool home binding — writes to $HOME should fail.
        'TAG_WRITE_CLAUDE_JSON_FAIL',
        'TAG_WRITE_CLAUDE_DIR_FAIL',
      ],
      mustNotContain: ['TAG_DNS_FAIL'],
    },
  },
];

// ── Run ───────────────────────────────────────────────────────────────

console.log(`WSL project root: ${PROJECT_ROOT}`);
console.log(`WSL $HOME:        ${HOME_DIR}`);
console.log('');

let allPassed = true;
const results = [];

for (const s of scenarios) {
  const args = buildBwrapArgs(INNER_SCRIPT, s.caps, PROJECT_ROOT, s.opts);
  const r = runInWsl(args);

  const out = r.stdout + '\n' + r.stderr;
  const missing = s.expect.mustContain.filter((t) => !out.includes(t));
  const unexpected = (s.expect.mustNotContain || []).filter((t) => out.includes(t));
  const passed = missing.length === 0 && unexpected.length === 0;
  if (!passed) allPassed = false;

  results.push({ scenario: s.name, passed, missing, unexpected, exit: r.status });

  console.log(`${passed ? '✓' : '✗'} ${s.name}  [exit ${r.status}]`);
  if (!passed) {
    if (missing.length) console.log(`    missing: ${missing.join(', ')}`);
    if (unexpected.length) console.log(`    unexpected: ${unexpected.join(', ')}`);
    console.log('    --- stdout ---');
    console.log(r.stdout.split('\n').map((l) => '    ' + l).join('\n'));
    if (r.stderr) {
      console.log('    --- stderr ---');
      console.log(r.stderr.split('\n').map((l) => '    ' + l).join('\n'));
    }
  }
  console.log('');
}

console.log('─'.repeat(60));
console.log(`${allPassed ? 'ALL SCENARIOS PASSED' : 'FAILURES DETECTED'} — ${results.filter((r) => r.passed).length}/${results.length} scenarios passed`);
process.exit(allPassed ? 0 : 1);
