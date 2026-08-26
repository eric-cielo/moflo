/**
 * Guard: no CLI option may be declared with a `no-` prefixed name (#1474).
 *
 * The parser treats `--no-<x>` as boolean negation — it writes
 * `flags[camelCase(x)] = false` and never produces a `noX` key (see
 * `CommandParser.parseFlag`, the `arg.startsWith('--no-')` branch). So an option
 * *declared* `no-judge` is unreachable: typing `--no-judge` sets `judge`, the
 * handler reads `noJudge`, gets `undefined`, and the flag is a silent no-op.
 *
 * Nothing else catches this. There is no type error — `ParsedFlags` is an index
 * signature — and reviewing the declaration cannot catch it either, because the
 * declaration looks equally correct under both spellings. Eight options shipped
 * this way before the guard existed, six of them user-facing no-ops
 * (`--no-dashboard`, `--no-embeddings` ×2, `--no-movector`, `--no-color`,
 * `--no-autostart`), and one carried a comment asserting the opposite behaviour.
 *
 * The fix is never to rename the reader. Declare the POSITIVE name with
 * `default: true` and read `flags.<x> !== false`; the `--no-<x>` spelling users
 * already type keeps working, because negation is what the parser was doing all
 * along.
 *
 * Walks the REAL registered command tree rather than grepping source, so an
 * option built programmatically is covered too — and asserts the parser
 * behaviour directly, so the guard fails if the reasoning above ever stops
 * being true.
 */

import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getCommandNames, getCommandAsync } from '../../src/cli/commands/index.js';
import { CommandParser } from '../../src/cli/parser.js';
import type { Command } from '../../src/cli/types.js';

async function collectOptionNames(): Promise<Array<{ path: string; name: string }>> {
  const found: Array<{ path: string; name: string }> = [];
  const seen = new Set<string>();

  const walk = (cmd: Command, ancestors: string[]): void => {
    const segments = [...ancestors, cmd.name];
    const key = segments.join(' ');
    if (seen.has(key)) return;
    seen.add(key);

    for (const opt of cmd.options ?? []) found.push({ path: key, name: opt.name });
    for (const sub of cmd.subcommands ?? []) walk(sub, segments);
  };

  for (const name of getCommandNames()) {
    const cmd = await getCommandAsync(name);
    if (cmd) walk(cmd, []);
  }

  return found;
}

describe('negative option names (#1474)', () => {
  it('no registered command declares an option named no-*', async () => {
    const offenders = (await collectOptionNames())
      .filter((opt) => opt.name.startsWith('no-'))
      .map((opt) => `${opt.path} --${opt.name}`);

    expect(
      offenders,
      'Declare the positive name with default: true and read `flags.<x> !== false`. '
      + '`--no-<x>` keeps working — the parser already negates it.',
    ).toEqual([]);
  });

  it('no global option is declared no-* either', () => {
    // Globals live on the parser, not in the command tree, so the walk above
    // cannot see them — and the global `no-color` was one of the original eight.
    const parser = new CommandParser();
    const globals = (parser as unknown as { globalOptions: Array<{ name: string }> }).globalOptions;

    expect(globals.filter((opt) => opt.name.startsWith('no-')).map((opt) => opt.name)).toEqual([]);
  });

  it('--no-<x> really does set <x> to false, which is why the rule holds', () => {
    const parser = new CommandParser();
    parser.registerCommand({
      name: 'guard-demo',
      description: 'fixture',
      options: [{ name: 'judge', type: 'boolean', default: true }],
      action: async () => ({ success: true }),
    } as Command);

    const negated = parser.parse(['guard-demo', '--no-judge']).flags;
    const bare = parser.parse(['guard-demo']).flags;

    expect(negated.judge).toBe(false);
    // The key an option named `no-judge` would have needed. It never appears,
    // which is the whole defect.
    expect(negated.noJudge).toBeUndefined();

    // And the second half of why the positive spelling needs care: a
    // command-level `default` is NOT applied unless the option shadows a global
    // (see CommandParser.applyDefaults), so an unset flag is `undefined`, not
    // its declared default. Readers must therefore test `!== false` / `=== false`
    // rather than trust the default to have materialised — a bare truthiness
    // check on `flags.judge` would read as "off" for the user who passed nothing.
    expect(bare.judge).toBeUndefined();
    expect(bare.judge !== false).toBe(true);
  });
});

/** Every `.ts` under `src/cli`, excluding tests. */
function cliSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      cliSourceFiles(full, out);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('nothing reads a flag key the parser cannot produce (#1474)', () => {
  it('no source reads flags.no<Something>', () => {
    // This is the half that actually broke. With the rule above in force, an
    // option can never be named `no-x`, so the parser can never emit a `noX`
    // key — `--no-x` writes `x`. Any `flags.noSomething` read is therefore
    // reading a key that is always `undefined`, which is precisely the silent
    // no-op this issue is about. Renaming the DECLARATION alone would not have
    // fixed anything: the parser negates `--no-x` into `x` either way.
    //
    // `noColor` is the shape to watch for — it read as a real setting for years.
    const offenders: string[] = [];
    for (const file of cliSourceFiles(join(__dirname, '..', '..', 'src', 'cli'))) {
      const source = readFileSync(file, 'utf-8');
      source.split(/\r?\n/).forEach((line, index) => {
        // `flags.noX` / `ctx.flags.noX` — a capital after `no` so `nodes`,
        // `noop`, `normalize` and friends are not matched.
        if (/\bflags\.no[A-Z]\w*/.test(line)) {
          offenders.push(`${file.replace(/.*src\/cli\//, 'src/cli/')}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      'Read the positive key instead: `flags.<x> === false` for "was it disabled", '
      + '`flags.<x> !== false` for "is it enabled".',
    ).toEqual([]);
  });
});
