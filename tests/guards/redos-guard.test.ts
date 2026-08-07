/**
 * ReDoS regression guard for the four regexes fixed in #1418.
 *
 * Each of these backtracked exponentially — measured, not assumed, at roughly
 * 4x per two characters of input. The assertion is a wall-clock budget on an
 * input two orders of magnitude larger than the one that used to take seconds:
 * a reintroduced ambiguous quantifier fails here by timing out, not by being
 * spotted in review.
 *
 * The budget is deliberately loose (250ms for n=1000) rather than tight. These
 * run on shared CI runners; the failure being guarded against is 2^n, which
 * blows any budget by many orders of magnitude, so a slack threshold costs
 * nothing in detection and buys immunity from runner noise.
 */

import { describe, it, expect } from 'vitest';
import { parseSkillCategories } from '../../bin/lib/skill-categories.mjs';
import { checkDestructivePatterns } from '../../src/cli/spells/commands/destructive-pattern-checker.js';
import { extractImports } from '../../src/cli/movector/graph-analyzer.js';

/** Wall-clock milliseconds for a single call. */
function elapsed(fn: () => unknown): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const BUDGET_MS = 250;

describe('#1418 — ReDoS regression budgets', () => {
  it('parseSkillCategories: a skills block with no categories key stays linear', () => {
    // The original hang: `(?:[ \t]+[^\r\n]*\r?\n)*?` had to try every way of
    // splitting each indented line before concluding there is no `categories:`.
    // A consumer's own moflo.yaml with ~30 lines under `skills:` hung Claude
    // Code at session start.
    const yaml = 'skills:\n' + '  key: value with several words\n'.repeat(1000);
    expect(elapsed(() => parseSkillCategories(yaml))).toBeLessThan(BUDGET_MS);
  });

  it('parseSkillCategories: an unterminated flow list stays linear', () => {
    const yaml = 'skills:\n  categories: [' + 'core, '.repeat(1000);
    expect(elapsed(() => parseSkillCategories(yaml))).toBeLessThan(BUDGET_MS);
  });

  it('parseSkillCategories: MANY unterminated flow lists stay linear', () => {
    // The rewrite's own near-miss. Looking the flow list up by re-slicing the
    // remainder of the file (`lines.slice(j).join('\n')`) on every candidate
    // line is O(n^2) — a smaller version of the blowup this rewrite exists to
    // close. Forward accumulation with a bounded lookahead makes it linear;
    // measured at a clean 2x per doubling of n.
    const yaml = 'skills:\n' + '  categories: [\n'.repeat(4000);
    expect(elapsed(() => parseSkillCategories(yaml))).toBeLessThan(BUDGET_MS);
  });

  it('checkDestructivePatterns: repeated rm flags with no target stay linear', () => {
    // `\w*[rfRF]\w*` inside a `*` group: every flag could be split many ways.
    // A hung safety gate is a safety gate that is not enforcing.
    const command = 'rm ' + '-ff\t'.repeat(1000);
    expect(elapsed(() => checkDestructivePatterns(command))).toBeLessThan(BUDGET_MS);
  });

  it('extractImports: a pathological import clause stays linear', () => {
    // `\s*,?\s*` made the separator optional, so the outer `*` could split a run
    // of word characters many ways. Runs over consumer source during indexing.
    const content = 'import ' + '* as a '.repeat(1000) + ';';
    expect(elapsed(() => extractImports(content, 'x.ts'))).toBeLessThan(BUDGET_MS);
  });

  it('extractImports: many identifiers with no from clause stay linear', () => {
    const content = 'import ' + 'aaaa '.repeat(1000) + ';';
    expect(elapsed(() => extractImports(content, 'x.ts'))).toBeLessThan(BUDGET_MS);
  });
});

describe('#1418 — behaviour preserved by the rewrites', () => {
  it('checkDestructivePatterns still blocks every dangerous rm form', () => {
    for (const command of [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf /etc',
      'rm -fr /usr ',
      'rm -rf C:\\',
      'rm -Rf /home',
      'rm -r -f /',
      'rm -rf /*',
      'sudo rm -rf /',
    ]) {
      expect(checkDestructivePatterns(command), command).not.toBeNull();
    }
  });

  it('checkDestructivePatterns still allows legitimate deletes', () => {
    for (const command of [
      'rm -rf ./build/',
      'rm -rf /home/user/project/dist',
      'rm file.txt',
    ]) {
      expect(checkDestructivePatterns(command), command).toBeNull();
    }
  });

  it('extractImports still resolves every ES import form', () => {
    const cases: Array<[string, string[]]> = [
      [`import foo from 'a';`, ['a']],
      [`import { a, b } from "b";`, ['b']],
      [`import * as ns from 'c';`, ['c']],
      [`import foo, { a } from 'd';`, ['d']],
      [`import foo, * as ns from 'e';`, ['e']],
      [`import { a as z, b } from 'f';`, ['f']],
      [`import {a}from'g';`, ['g']],
      // Type-only imports are the dominant form in this codebase. The old regex
      // absorbed the `type` modifier through its optional separator; the
      // rewrite has to name it explicitly or every one of these edges is lost.
      [`import type { T } from 'h';`, ['h']],
      [`import type Foo from 'i';`, ['i']],
      [`import type * as N from 'j';`, ['j']],
    ];
    for (const [source, expected] of cases) {
      const paths = extractImports(source, 'x.ts')
        .filter((i) => i.type === 'import')
        .map((i) => i.path);
      expect(paths, source).toEqual(expected);
    }
  });
});
