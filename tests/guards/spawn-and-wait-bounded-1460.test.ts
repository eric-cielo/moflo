/**
 * Guard: the Spawn-and-Wait pattern must stay bounded (#1460).
 *
 * `moflo-claude-swarm-cohesion.md` used to tell an orchestrator to stop making
 * tool calls after a fan-out and wait for completion notifications, while its
 * Don't column closed off every check that could reveal the notifications were
 * never coming — polling status, reading task output, and asking the operator.
 * A wait whose failure mode is silence is indistinguishable from a wait that is
 * still working, so a dead fan-out read as patience.
 *
 * The cost was measured, not hypothetical: three Opus agents in a consumer
 * project, budgeted at ~450k tokens, returned nothing at all, and the stall
 * surfaced only because the operator noticed the counters still climbing.
 *
 * The fix is prose, so nothing else pins it. A future editor "simplifying" the
 * table back to four tidy rows would silently restore the unbounded wait — this
 * guard is what makes that a red test instead of a re-run of the incident.
 *
 * The anti-polling intent is deliberately pinned alongside the deadline: the
 * repair must not swing into "poll continuously", which is the failure mode the
 * original table existed to prevent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const DOC = resolve(
  REPO_ROOT,
  '.claude/guidance/shipped/moflo-claude-swarm-cohesion.md',
);

// Rule #1: normalise CRLF so a Windows checkout matches a POSIX one.
const text = readFileSync(DOC, 'utf-8').replace(/\r\n/g, '\n');

/**
 * The body of an H3 section, up to the next heading of any level or the
 * horizontal rule that closes it.
 *
 * Splits on the heading rather than slicing by offset — an index-based slice
 * has to account for the `### ` prefix as well as the title, and getting that
 * arithmetic wrong silently leaks the tail of the heading into the body
 * instead of failing. Mirrors the helper in
 * `agent-persona-mcp-examples-1330.test.ts`, which reads H3 sections the same
 * way; it is a closure over that file's own text, so the approach is shared
 * here rather than the function.
 *
 * Returns '' when the heading is absent so a missing section fails the
 * individual assertions rather than aborting collection for the whole file —
 * a partial regression then names the invariant it broke.
 */
function section(heading: string): string {
  const after = text.split(`### ${heading}`)[1] ?? '';
  return after.split(/\n(?:#{1,4}\s|---)/)[0];
}

describe('Spawn-and-Wait pattern stays bounded', () => {
  const spawnWait = section('Spawn-and-Wait Pattern');

  it('is still present under Critical Execution Rules', () => {
    expect(spawnWait, `missing "### Spawn-and-Wait Pattern" in ${DOC}`).not.toBe('');
  });

  it('states an expected time-to-first-notification', () => {
    expect(spawnWait).toMatch(/time-to-first-notification/i);
  });

  it('permits exactly one liveness check after the announced window', () => {
    expect(spawnWait).toMatch(/liveness check/i);
    expect(spawnWait).toMatch(/\*\*one\*\* liveness check/i);
    // The check has to name a call the orchestrator can actually make.
    // `TaskOutput` cannot pin it — that string also appears in the banned
    // "Repeatedly call `TaskOutput`" row, so it would survive deleting the
    // liveness row outright. `ListAgents` appears only in the allowance.
    expect(spawnWait).toMatch(/ListAgents/);
  });

  it('keeps the ban on continuous polling', () => {
    expect(spawnWait).toMatch(/Continuously poll/i);
    expect(spawnWait).toMatch(/Repeatedly call `TaskOutput`/);
  });

  it('distinguishes polling from a liveness check', () => {
    expect(spawnWait).toMatch(/are you done yet\?/i);
    expect(spawnWait).toMatch(/are you alive at all\?/i);
  });

  it('forbids a fan-out that ends in silence', () => {
    expect(spawnWait).toMatch(/in silence/i);
    expect(spawnWait).toMatch(/every fan-out\s+must end in a report/i);
  });

  it('no longer states notification as an unconditional guarantee', () => {
    expect(spawnWait).not.toMatch(/Wait for agent results to arrive \(you'll be notified\)/);
  });
});

describe('Fan-out spawns are warned off the Agent `name` parameter', () => {
  const nameRule = section('Never Pass `name:` to a Fan-Out Spawn');

  it('has a discoverable heading of its own', () => {
    expect(nameRule, `missing "### Never Pass \`name:\` to a Fan-Out Spawn" in ${DOC}`).not.toBe('');
  });

  it('directs fan-outs to label with description instead', () => {
    expect(nameRule).toMatch(/`description`/);
    expect(nameRule).toMatch(/leave the `Agent` tool's `name` unset/i);
  });

  it('explains that `name` registers an addressable teammate', () => {
    expect(nameRule).toMatch(/SendMessage/);
    expect(nameRule).toMatch(/teammate/i);
  });

  it('records the observed failure so the rule is not mistaken for style', () => {
    expect(nameRule).toMatch(/never executed its `prompt`/i);
  });
});

describe('the edited doc still satisfies the shipped-guidance contract', () => {
  it('cites no issue or PR numbers', () => {
    // shipped/moflo-guidance-rules.md rule #10 — the number resolves against
    // the consumer's tracker, not moflo's.
    expect(text).not.toMatch(/#\d{2,}/);
  });

  it('cross-references the top-level mirror, never the shipped/ path', () => {
    // internal/guidance-rules.md §2 — `shipped/` is not a directory that
    // exists in a consumer project.
    expect(text).not.toMatch(/\.claude\/guidance\/shipped\//);
  });

  it('stays under the 500-line guidance cap', () => {
    expect(text.split('\n').length).toBeLessThan(500);
  });

  it('keeps its See Also section', () => {
    expect(text).toMatch(/\n## See Also\n/);
  });
});
