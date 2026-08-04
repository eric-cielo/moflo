/**
 * Guard: a CLI option's declared `default` must match its declared `type`.
 *
 * `default: 'false'` on a boolean is a truthy STRING; `default: '100'` on a
 * number string-concatenates under arithmetic (`'100' + 1 === '1001'`). These
 * sat harmless for a long time only because the parser never applied
 * command-level option defaults at all — 455 of them across the CLI were dead
 * letters. The moment `applyDefaults` started honouring them, every
 * `default: 'false'` flipped its flag ON: `--force`, `--full`, `--background`,
 * `--verbose`. Loaded-gun shapes, not style nits, so they get a guard.
 *
 * Note the asymmetry that makes this invisible: the parser DOES coerce
 * user-supplied values (`--limit 10` arrives as the number 10), so only the
 * declared default escapes coercion. A wrong default is therefore silent right
 * up until it is the value in play.
 *
 * Only options that shadow a global option currently have their default
 * applied (see `CommandParser.applyDefaults`), so most are still dormant —
 * which is exactly why a regression here would go unnoticed until someone
 * widens that rule.
 *
 * Walks the REAL registered command tree rather than grepping source, so an
 * option built programmatically is covered too.
 *
 * If this goes red: write the literal, not the string — `default: false`,
 * `default: 100`.
 */

import { describe, expect, it } from 'vitest';

import { getCommandNames, getCommandAsync } from '../../src/cli/commands/index.js';
import type { Command } from '../../src/cli/types.js';

async function collectOptions(): Promise<Array<{ path: string; name: string; default: unknown; type?: string }>> {
  const found: Array<{ path: string; name: string; default: unknown; type?: string }> = [];
  const seen = new Set<string>();

  const walk = (cmd: Command, ancestors: string[]): void => {
    const segments = [...ancestors, cmd.name];
    const key = segments.join(' ');
    if (seen.has(key)) return;
    seen.add(key);

    for (const opt of cmd.options ?? []) {
      found.push({ path: key, name: opt.name, default: opt.default, type: opt.type });
    }
    for (const sub of cmd.subcommands ?? []) walk(sub, segments);
  };

  for (const name of getCommandNames()) {
    const cmd = await getCommandAsync(name);
    if (cmd) walk(cmd, []);
  }

  return found;
}

/** The JS typeof a declared `type` must produce for its default. */
const EXPECTED_TYPEOF: Record<string, string> = {
  boolean: 'boolean',
  number: 'number',
  string: 'string',
};

describe('CLI option default types', () => {
  it('no boolean option declares a string default', async () => {
    const options = await collectOptions();

    const offenders = options
      .filter(o => o.type === 'boolean' && typeof o.default === 'string')
      .map(o => `${o.path} --${o.name} (default: ${JSON.stringify(o.default)})`);

    expect(
      offenders,
      `Boolean options must use a real boolean default — a string 'false' is TRUTHY.\n` +
        `Write \`default: false\`, not \`default: 'false'\`.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no number option declares a string default', async () => {
    const options = await collectOptions();

    const offenders = options
      .filter(o => o.type === 'number' && typeof o.default === 'string')
      .map(o => `${o.path} --${o.name} (default: ${JSON.stringify(o.default)})`);

    expect(
      offenders,
      `Number options must use a real number default — a string default skips the\n` +
        `coercion the parser applies to user-supplied values, so '100' + 1 === '1001'.\n` +
        `Write \`default: 100\`, not \`default: '100'\`.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  // The general rule the two cases above are instances of, so a new `type`
  // (or a string option defaulted to a number) is caught without another case.
  it('every declared default matches its declared type', async () => {
    const options = await collectOptions();

    const offenders = options
      .filter(o => o.default !== undefined && o.type !== undefined)
      .filter(o => {
        const expected = EXPECTED_TYPEOF[o.type as string];
        // Unknown/array-ish types are out of scope for this guard.
        return expected !== undefined && typeof o.default !== expected;
      })
      .map(o => `${o.path} --${o.name}: type '${o.type}' but default is ${typeof o.default} (${JSON.stringify(o.default)})`);

    expect(
      offenders,
      `An option's default must be a literal of its declared type.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('walks a meaningful number of commands (guard is actually reaching the tree)', async () => {
    const options = await collectOptions();

    // Cheap canary: if lazy loading breaks and the walk silently sees nothing,
    // the assertion above would pass vacuously.
    expect(options.length).toBeGreaterThan(500);
  });
});
