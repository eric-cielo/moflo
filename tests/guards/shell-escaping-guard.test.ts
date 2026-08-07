/**
 * Shell-argument quoting regression guard (#1419).
 *
 * The Windows branch is asserted against a reference implementation of the
 * MSVCRT argv parser rather than against an expected output string. Comparing
 * quoted forms only proves the escaper did what it was written to do; running
 * the result back through the parser proves it does what it is *for*.
 *
 * Rule #1: `escapeShellArgWindows` is exported precisely so this runs on Linux
 * and macOS too. Guarding the Windows path behind `IS_WINDOWS` and testing only
 * `escapeShellArg` is how the defect survived — including in the smoke harness
 * built to catch cross-platform divergence.
 */

import { describe, it, expect } from 'vitest';
import {
  escapeShellArgWindows,
  escapeShellArgPosix,
} from '../../src/cli/shared/utils/platform.js';
import { escapeShellArg as fromSpells } from '../../src/cli/spells/core/shell.js';
import { escapeShellArg as fromPlatform } from '../../src/cli/shared/utils/platform.js';
import { globToRegExp } from '../../src/cli/guidance/retriever.js';

/**
 * Reference MSVCRT command-line-to-argv parser, per Microsoft's documented
 * rules: backslashes are literal except in a run immediately preceding a `"`,
 * where each pair yields one backslash and an odd one escapes the quote.
 */
function parseMsvcrt(commandLine: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  let i = 0;

  while (i < commandLine.length) {
    const ch = commandLine[i];

    if (ch === '\\') {
      let slashes = 0;
      while (commandLine[i] === '\\') { slashes++; i++; }
      if (commandLine[i] === '"') {
        current += '\\'.repeat(slashes >> 1);
        if (slashes % 2) { current += '"'; i++; } else { inQuotes = !inQuotes; i++; }
      } else {
        current += '\\'.repeat(slashes);
      }
      started = true;
      continue;
    }

    if (ch === '"') { inQuotes = !inQuotes; i++; started = true; continue; }

    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (started) { argv.push(current); current = ''; started = false; }
      i++;
      continue;
    }

    current += ch;
    started = true;
    i++;
  }

  if (started) argv.push(current);
  return argv;
}

/** Arguments whose shapes a Windows dev box and CI runner produce constantly. */
const ARGS = [
  'C:\\Users\\x\\',                 // the reported bug: trailing backslash
  'C:\\Program Files\\App\\',       // …with a space, so quoting is mandatory
  '\\\\server\\share\\',            // UNC path, also trailing
  'a"b',                            // embedded quote
  'a\\"b',                          // backslash then quote
  'a\\',                            // bare trailing backslash
  'plain',
  'with space',
  '',
  'multiple   spaces  and\ttabs',
];

describe('#1419 — Windows argument quoting survives an MSVCRT round trip', () => {
  for (const arg of ARGS) {
    it(`round-trips ${JSON.stringify(arg)} without swallowing the next argument`, () => {
      const line = `${escapeShellArgWindows(arg)} NEXT`;
      expect(parseMsvcrt(line)).toEqual([arg, 'NEXT']);
    });
  }

  it('the pre-fix escape is genuinely broken on the trailing-backslash cases', () => {
    // Pins the defect itself: `"${arg.replace(/"/g, '\\"')}"` escapes quotes but
    // not backslashes, so the final `\` escapes the closing quote and the
    // quoted region runs on. If this ever starts passing, the reference parser
    // has drifted and the tests above are no longer proving anything.
    const broken = (arg: string) => `"${arg.replace(/"/g, '\\"')}"`;
    const parsed = parseMsvcrt(`${broken('C:\\Users\\x\\')} NEXT`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toContain('NEXT');
  });
});

describe('#1419 — POSIX argument quoting', () => {
  for (const arg of ARGS.concat(["it's", "a'\\''b", '$(whoami)', '`id`', 'a$b'])) {
    it(`single-quotes ${JSON.stringify(arg)} totally`, () => {
      // Inside single quotes sh treats every character literally, so the
      // round trip is just the '\'' idiom reversed.
      const quoted = escapeShellArgPosix(arg);
      expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
      const unquoted = quoted
        .slice(1, -1)
        .split("'\\''")
        .join("'");
      expect(unquoted).toBe(arg);
    });
  }
});

describe('#1419 — one implementation, not two', () => {
  it('spells/core/shell.ts re-exports the canonical escaper rather than copying it', () => {
    // Both modules defined a near-identical escapeShellArg, and only one of the
    // two copies would ever have been fixed.
    expect(fromSpells).toBe(fromPlatform);
  });
});

describe('#1419 — glob compilation escapes regex metacharacters', () => {
  it('treats a literal dot as a dot, not as "any character"', () => {
    // The live case. Guidance repo scopes carry `.md` constantly, and an
    // unescaped `.` made the glob quietly over-match rather than fail loudly.
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docsXaXmd')).toBe(false);
    expect(globToRegExp('*.md').test('aXmd')).toBe(false);
  });

  it('matches metacharacters literally instead of throwing or over-matching', () => {
    for (const [glob, input] of [
      ['a+b.md', 'a+b.md'],
      ['a(b).md', 'a(b).md'],
      ['a[x].md', 'a[x].md'],
      ['a{b}.md', 'a{b}.md'],
      ['a|b.md', 'a|b.md'],
      ['a^b$.md', 'a^b$.md'],
      ['a?b.md', 'a?b.md'],
    ] as const) {
      expect(() => globToRegExp(glob), glob).not.toThrow();
      expect(globToRegExp(glob).test(input), glob).toBe(true);
    }
    // `+` as a quantifier would have matched a repeated character.
    expect(globToRegExp('a+b.md').test('aaab.md')).toBe(false);
  });

  it('still expands * and ** with their distinct meanings', () => {
    expect(globToRegExp('*').test('file.ts')).toBe(true);
    expect(globToRegExp('*').test('dir/file.ts')).toBe(false);
    expect(globToRegExp('**').test('dir/file.ts')).toBe(true);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.md').test('docs/guide.md')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});
