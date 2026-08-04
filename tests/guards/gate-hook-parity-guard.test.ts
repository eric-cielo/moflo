/**
 * Guard: the three copies of the gate bridge must be one file (#1322).
 *
 * `.claude/helpers/gate-hook.mjs` in a consumer project has **two** writers:
 * `flo init` writes `generateGateHookScript()`'s output, and the session-start
 * launcher syncs `bin/gate-hook.mjs` over the top. When those disagree, a
 * consumer runs one bridge after init and a different one after the next
 * session start — a difference that is invisible locally and reproduces only
 * in a freshly-inited project.
 *
 * It had drifted exactly that way: the generated copy never received #1332's
 * structured-input forwarding and still shelled out through `execSync` string
 * concatenation where `bin/` uses `execFileSync` with an argv array. Nothing
 * caught it because no test compared them.
 *
 * If this goes red, copy `bin/gate-hook.mjs` across wholesale — do not
 * hand-merge, and do not relax the comparison.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateGateHookScript } from '../../src/cli/init/helpers-generator.js';

const REPO_ROOT = resolve(__dirname, '../..');
const BIN_BRIDGE = resolve(REPO_ROOT, 'bin/gate-hook.mjs');
const DOGFOOD_BRIDGE = resolve(REPO_ROOT, '.claude/helpers/gate-hook.mjs');

/** Line endings are normalised: git may check these out as CRLF on Windows. */
function read(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

describe('gate-hook.mjs parity', () => {
  it('the generator emits byte-for-byte what bin/ ships', () => {
    expect(generateGateHookScript().replace(/\r\n/g, '\n')).toBe(read(BIN_BRIDGE));
  });

  it('the dogfood copy matches bin/ (the launcher syncs it — a diff means it is stale)', () => {
    expect(read(DOGFOOD_BRIDGE)).toBe(read(BIN_BRIDGE));
  });

  it('forwards tool_response, without ever claiming an exit status (#1322)', () => {
    // Claude Code's payload has no exit code. A `TOOL_RESPONSE_exitCode` here
    // would be a fabricated field — the exact class of invention #1349/#1354
    // removed elsewhere. Pinned so a future edit cannot reintroduce the claim.
    const bridge = read(BIN_BRIDGE);
    expect(bridge).toContain('TOOL_RESPONSE_stdout');
    expect(bridge).toContain('TOOL_RESPONSE_interrupted');
    expect(bridge).not.toMatch(/exitCode|exit_code|exitStatus/);
  });
});
