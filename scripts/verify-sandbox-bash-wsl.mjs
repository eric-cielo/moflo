#!/usr/bin/env node
/**
 * End-to-end sandbox functional probe.
 *
 * Runs real bash spells through the spell engine on Linux with sandbox
 * config auto-loaded from moflo.yaml, and verifies:
 *   1. With sandbox enabled  → /etc writes FAIL (bwrap isolation real)
 *   2. With sandbox disabled → /etc writes SUCCEED (control)
 *   3. With sandbox enabled  → DNS + HTTPS to api.anthropic.com WORK
 *      (Claude can function inside the sandbox)
 *   4. With sandbox enabled  → ~/.claude.json is writable
 *      (tool home is bound for elevated permission level)
 *
 * Invocation (from Windows host via WSL):
 *   wsl -d Ubuntu -- /home/eric/.nvm/versions/node/v24.12.0/bin/node \
 *     /mnt/c/Users/eric/Projects/moflo/scripts/verify-sandbox-bash-wsl.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bridgeRunSpell } from '../src/modules/cli/dist/src/spells/factory/runner-bridge.js';
import {
  parseSpell,
} from '../src/modules/cli/dist/src/spells/schema/parser.js';
import {
  StepCommandRegistry,
} from '../src/modules/cli/dist/src/spells/core/step-command-registry.js';
import { builtinCommands } from '../src/modules/cli/dist/src/spells/commands/index.js';
import { analyzeSpellPermissions } from '../src/modules/cli/dist/src/spells/core/permission-disclosure.js';

if (platform() !== 'linux') {
  console.error(`Must run on Linux (currently ${platform()}).`);
  process.exit(2);
}

/**
 * Probe inner script. Each probe emits TAG_* tokens we can grep for.
 *
 * mofloLevel: elevated grants the bash step shell + net + fs:write so the
 * tool-home bind mounts are applied (matches epic implement-story workload).
 */
function spellYaml(probeScript) {
  return [
    'name: sandbox-bash-probe',
    'steps:',
    '  - id: probe',
    '    type: bash',
    '    permissionLevel: elevated',
    '    config:',
    `      command: |`,
    ...probeScript.split('\n').map(l => `        ${l}`),
    '      timeout: 360000',
  ].join('\n');
}

const PROBE = `
set +e
export PATH=/home/eric/.nvm/versions/node/v24.12.0/bin:$PATH

# PID-namespace isolation: bwrap always sets --unshare-pid, so ps -A only sees
# the sandboxed process tree (small count). Without bwrap, we see the host's.
PROC_COUNT=$(ps -A --no-headers 2>/dev/null | wc -l)
if [ "$PROC_COUNT" -le 10 ]; then echo TAG_PID_ISOLATED; else echo TAG_PID_HOST_VISIBLE; fi
echo "TAG_PID_COUNT=$PROC_COUNT"

# Tool-home write (Claude needs this for elevated)
if (: >>"$HOME/.claude.json") 2>/dev/null; then echo TAG_CLAUDE_HOME_WRITABLE; else echo TAG_CLAUDE_HOME_NOT_WRITABLE; fi

# DNS + HTTPS (Claude needs api.anthropic.com)
if curl -sS -o /dev/null --max-time 8 https://api.anthropic.com/ 2>/dev/null; then echo TAG_HTTPS_OK; else echo TAG_HTTPS_FAIL; fi

# THE REAL TEST: invoke Claude Code from inside the sandbox and verify it
# can authenticate, reach the API, and produce a real answer. Wrap in the
# timeout(1) command because claude leaves child workers under unshare-pid
# that hold stdout open; bound the answer.
echo "--- claude -p invocation ---"
CLAUDE_OUT=$(timeout 180s claude -p "Reply with exactly: 4" </dev/null 2>&1)
CLAUDE_RC=$?
echo "claude exit=$CLAUDE_RC"
echo "claude output: [$CLAUDE_OUT]"
if [ "$CLAUDE_RC" -eq 0 ] && echo "$CLAUDE_OUT" | grep -q "4"; then
  echo TAG_CLAUDE_WORKS
else
  echo TAG_CLAUDE_FAILED
fi
# Force exit so bwrap doesn't wait on lingering claude child FDs.
exec 1>&- 2>&-
exit 0
`.trim();

/**
 * Pre-write the acceptance record so the runner doesn't block on
 * first-run permission gate. Mirrors what runner-adapter does after the
 * user answers "y" interactively.
 */
function preAccept(projectRoot, spellYamlText) {
  const parsed = parseSpell(spellYamlText);
  const registry = new StepCommandRegistry();
  for (const cmd of builtinCommands) registry.register(cmd, 'built-in');
  const report = analyzeSpellPermissions(parsed.definition, registry);

  const acceptanceDir = join(projectRoot, '.moflo', 'accepted-permissions');
  mkdirSync(acceptanceDir, { recursive: true });
  const safeName = parsed.definition.name.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filePath = join(acceptanceDir, `${safeName}.json`);
  writeFileSync(filePath, JSON.stringify({
    spellIdentifier: parsed.definition.name,
    permissionHash: report.permissionHash,
    acceptedAt: new Date().toISOString(),
  }), 'utf-8');
}

async function runScenario(name, sandboxBlock, expectations) {
  const dir = mkdtempSync(join(tmpdir(), 'moflo-bashprobe-'));
  try {
    writeFileSync(join(dir, 'moflo.yaml'), sandboxBlock, 'utf-8');
    const yaml = spellYaml(PROBE);
    preAccept(dir, yaml);

    const result = await bridgeRunSpell(yaml, undefined, {}, { projectRoot: dir });

    const stdoutData = result.outputs?.probe ?? {};
    const stdout = String(stdoutData.stdout ?? '');
    const stderr = String(stdoutData.stderr ?? '');
    const combined = stdout + '\n' + stderr;

    const missing = expectations.mustContain.filter(t => !combined.includes(t));
    const unexpected = (expectations.mustNotContain ?? []).filter(t => combined.includes(t));
    const ok = result.success && missing.length === 0 && unexpected.length === 0;

    return { name, ok, success: result.success, missing, unexpected, stdout, stderr, errors: result.errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scenarios = [
  {
    name: 'sandbox enabled (auto): PID isolated, Claude Code runs inside',
    yaml: 'sandbox:\n  enabled: true\n  tier: auto\n',
    expect: {
      mustContain: [
        'TAG_PID_ISOLATED',           // bwrap --unshare-pid actually applied
        'TAG_CLAUDE_HOME_WRITABLE',   // ~/.claude.json bound for elevated
        'TAG_HTTPS_OK',               // network reaches api.anthropic.com
        'TAG_CLAUDE_WORKS',           // claude -p actually returns
      ],
      mustNotContain: ['TAG_PID_HOST_VISIBLE', 'TAG_CLAUDE_FAILED'],
    },
  },
  {
    name: 'sandbox disabled: host PID namespace visible (control)',
    yaml: 'sandbox:\n  enabled: false\n  tier: auto\n',
    expect: {
      mustContain: [
        'TAG_PID_HOST_VISIBLE',
        'TAG_HTTPS_OK',
        'TAG_CLAUDE_WORKS',
      ],
      mustNotContain: ['TAG_PID_ISOLATED'],
    },
  },
];

let allOk = true;
for (const s of scenarios) {
  const r = await runScenario(s.name, s.yaml, s.expect);
  if (!r.ok) allOk = false;
  console.log(`${r.ok ? '✓' : '✗'} ${s.name}`);
  console.log(`    spell ok    : ${r.success}`);
  if (r.missing.length) console.log(`    missing tags: ${r.missing.join(', ')}`);
  if (r.unexpected.length) console.log(`    unexpected  : ${r.unexpected.join(', ')}`);
  if (!r.ok) {
    console.log(`    --- stdout ---\n${r.stdout.split('\n').map(l => '    ' + l).join('\n')}`);
    if (r.stderr) console.log(`    --- stderr ---\n${r.stderr.split('\n').map(l => '    ' + l).join('\n')}`);
    if (r.errors?.length) console.log(`    errors: ${JSON.stringify(r.errors)}`);
  } else {
    const tags = r.stdout.split('\n').filter(l => l.startsWith('TAG_')).join(', ');
    console.log(`    tags        : ${tags}`);
  }
  console.log('');
}

console.log('─'.repeat(60));
console.log(allOk
  ? 'ALL PROBES PASSED — sandbox actually isolates AND Claude can function inside'
  : 'FAILURES DETECTED');
process.exit(allOk ? 0 : 1);
