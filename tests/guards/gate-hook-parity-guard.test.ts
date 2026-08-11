/**
 * Guard: the copies of the gate bridge — and of gate.cjs itself — must be one
 * file (#1322, extended in #1326).
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

const REPO_ROOT = resolve(__dirname, '../..');
const BIN_BRIDGE = resolve(REPO_ROOT, 'bin/gate-hook.mjs');
const DOGFOOD_BRIDGE = resolve(REPO_ROOT, '.claude/helpers/gate-hook.mjs');
const BIN_GATE = resolve(REPO_ROOT, 'bin/gate.cjs');
const DOGFOOD_GATE = resolve(REPO_ROOT, '.claude/helpers/gate.cjs');

/** Line endings are normalised: git may check these out as CRLF on Windows. */
function read(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

describe('gate-hook.mjs parity', () => {
  // The generator-vs-bin assertion that used to open this block moved to
  // tests/guards/embedded-helpers-parity.test.ts (#1443), which makes the same
  // comparison for all seven generated helpers rather than this one. Restating
  // it here would assert the same equality against the same file twice.
  //
  // What remains is the half that guard cannot cover: the DOGFOOD copies. Those
  // are separate files on disk that the launcher syncs, so they can still go
  // stale independently of anything the generator does.
  it('the dogfood copy matches bin/ (the launcher syncs it — a diff means it is stale)', () => {
    expect(read(DOGFOOD_BRIDGE)).toBe(read(BIN_BRIDGE));
  });

  it('the dogfood gate.cjs matches bin/ — this is the file consumers receive (#1326)', () => {
    // Not merely a dogfood copy. `flo init` writes a consumer's
    // `.claude/helpers/gate.cjs` from the moflo package's OWN
    // `.claude/helpers/gate.cjs` — not from `bin/`, and not from
    // `generateGateScript()` (confirmed by sha1-matching an emitted file
    // against every candidate on disk). So a stale copy here ships a stale
    // gate to every freshly-inited project while `bin/` looks correct.
    expect(read(DOGFOOD_GATE)).toBe(read(BIN_GATE));
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
