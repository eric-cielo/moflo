#!/usr/bin/env node
/**
 * End-to-end probe: prove that moflo.yaml's sandbox config is honored
 * by the spell engine when invoked through bridgeRunSpell.
 *
 * Runs the freshly-built spells dist on Linux (WSL) and asserts the
 * runner logs "OS sandbox: bwrap (linux)" instead of the buggy
 * "disabled (denylist active)" we ship with no config.
 *
 * Invocation (from Windows):
 *   wsl -d Ubuntu -- node /mnt/c/Users/eric/Projects/moflo/scripts/verify-sandbox-wiring-wsl.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { bridgeRunSpell } from '../dist/src/cli/spells/factory/runner-bridge.js';

if (platform() !== 'linux') {
  console.error(`This probe must run on Linux (currently ${platform()}). Run via: wsl -d Ubuntu -- node ...`);
  process.exit(2);
}

const SPELL = [
  'name: sandbox-wiring-probe',
  'steps:',
  '  - id: noop',
  '    type: wait',
  '    config:',
  '      duration: 0',
].join('\n');

const logs = [];
const origLog = console.log;
console.log = (msg, ...rest) => {
  logs.push([msg, ...rest].map(String).join(' '));
  origLog(msg, ...rest);
};

async function probe(name, sandboxBlock, expectedSubstring) {
  const dir = mkdtempSync(join(tmpdir(), 'moflo-probe-'));
  try {
    writeFileSync(join(dir, 'moflo.yaml'), sandboxBlock, 'utf-8');

    logs.length = 0;
    const result = await bridgeRunSpell(SPELL, undefined, {}, { projectRoot: dir });

    const sandboxLine = logs.find(l => l.includes('OS sandbox:')) ?? '<none>';
    const ok = result.success && sandboxLine.includes(expectedSubstring);

    return { name, ok, sandboxLine, success: result.success, errors: result.errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: 'sandbox enabled + tier auto → bwrap active',
    yaml: 'sandbox:\n  enabled: true\n  tier: auto\n',
    expect: 'bwrap (linux)',
  },
  {
    name: 'sandbox enabled + tier denylist-only → disabled (denylist active)',
    yaml: 'sandbox:\n  enabled: true\n  tier: denylist-only\n',
    expect: 'disabled (denylist active)',
  },
  {
    name: 'no sandbox block → defaults (disabled)',
    yaml: 'project:\n  name: probe\n',
    expect: 'disabled (denylist active)',
  },
];

let allOk = true;
for (const c of cases) {
  const r = await probe(c.name, c.yaml, c.expect);
  if (!r.ok) allOk = false;
  origLog(`\n${r.ok ? '✓' : '✗'} ${c.name}`);
  origLog(`    sandbox log : ${r.sandboxLine}`);
  origLog(`    expected    : OS sandbox: ${c.expect}`);
  origLog(`    spell ok    : ${r.success}`);
  if (r.errors?.length) origLog(`    errors      : ${JSON.stringify(r.errors)}`);
}

origLog('\n' + '─'.repeat(60));
origLog(allOk ? 'ALL PROBES PASSED — bridge correctly wires moflo.yaml sandbox config' : 'FAILURES DETECTED');
process.exit(allOk ? 0 : 1);
