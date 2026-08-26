/**
 * Structural guard: a memory-bridge mutation must never report a row count
 * taken from the length of its own input.
 *
 * This is the exact defect #1465 removed. `bridgeBatchOperation`'s `delete`
 * and `update` branches called the controller in a loop, threw the controller's
 * real result away, and returned `{ deleted: keys.length }` /
 * `{ updated: params.entries.length }` — a number that equals what the caller
 * passed in, whether or not a single row changed. Both were then wrapped as
 * `{ success: true, ... }`, so a no-op was indistinguishable from a write.
 *
 * That matters more than an ordinary wrong number. A mutation that reports
 * success while changing nothing is worse than one that is simply absent: the
 * caller has no signal to retry on, and the drift goes unnoticed. It is the
 * same failure shape as the artifact-sync bugs in #1463.
 *
 * The controllers themselves are honest — `BatchOperations.bulkDelete` brackets
 * the statement with `COUNT(*)` and returns the real difference, because sql.js
 * exposes no affected-rows API. The bug was entirely in the bridge discarding
 * that answer. So this guard watches the bridge, which is where a future loop-
 * and-count-the-inputs shortcut would reappear.
 *
 * Scope note: only *mutation* counts are matched. A read path that reports
 * `count: keys.length` after listing keys is correct — there the input array
 * IS the answer. Widening this guard to those would need an allowlist, and an
 * allowlist would outlive the reasoning behind each entry.
 *
 * If this goes RED: return the count the store reported (`result.inserted`,
 * `result.deleted`, …), not the length of the array you passed it. If the
 * underlying call cannot report rows affected, that is the thing to fix.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './_helpers/eslint-harness.js';

const BRIDGE_PATH = join(REPO_ROOT, 'src', 'cli', 'memory', 'memory-bridge.ts');

/**
 * Field names that denote "rows the store actually changed". `count` is
 * included because it is the field #1465's wrapper lied through.
 */
const MUTATION_COUNT_FIELDS = ['count', 'deleted', 'updated', 'inserted', 'affected', 'removed'];

/**
 * `<field>: <anything>.length` — an object literal reporting a mutation count
 * straight from an array's length. Covers `keys.length`,
 * `params.entries.length`, and `entries[0].items.length` alike.
 */
const INPUT_DERIVED_COUNT = new RegExp(
  String.raw`\b(${MUTATION_COUNT_FIELDS.join('|')})\s*:\s*[A-Za-z_$][\w$.\[\]]*\.length\b`,
);

describe('memory-bridge mutation counts (#1465)', () => {
  const source = readFileSync(BRIDGE_PATH, 'utf8');

  it('reports no mutation count derived from input length', () => {
    const offenders = source
      .split(/\r?\n/)
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => INPUT_DERIVED_COUNT.test(text))
      .map(({ line, text }) => `memory-bridge.ts:${line}: ${text.trim()}`);

    expect(offenders).toEqual([]);
  });

  it('matches the shape the bug actually took', () => {
    // Mutation-testing the guard: the two literal lines #1465 deleted must
    // both trip it, or the regex above is decorative.
    expect(INPUT_DERIVED_COUNT.test('result = { deleted: keys.length };')).toBe(true);
    expect(INPUT_DERIVED_COUNT.test('result = { updated: params.entries.length };')).toBe(true);
    expect(INPUT_DERIVED_COUNT.test("return { success: true, count: params.entries.length };")).toBe(true);

    // ...and a count sourced from the store's own answer must not.
    expect(INPUT_DERIVED_COUNT.test("return { count: result.inserted, result };")).toBe(false);
  });

  it('no longer routes batch delete/update to the episodes store', () => {
    // The loop-over-keys calls are gone, not merely renamed.
    expect(source).not.toMatch(/bulkDelete\(\s*'episodes'/);
    expect(source).not.toMatch(/bulkUpdate\(\s*'episodes'/);
  });
});
