/**
 * Every `--no-<x>` flag reaches the code that reads it (#1474).
 *
 * These were all silent no-ops: each option was declared `no-<x>`, so the parser
 * — which turns `--no-<x>` into `<x> = false` — never produced the `noX` key the
 * handler read. `--no-dashboard` started a dashboard, `--no-embeddings` embedded,
 * `--no-autostart` registered a login service.
 *
 * Note what does NOT pin this: the parser negates `--no-<x>` into `<x> = false`
 * regardless of how the option is declared, so renaming a declaration changes no
 * parsed key and a test over parser output passes before and after the fix. The
 * regression is pinned by `tests/guards/negative-option-name-guard.test.ts`,
 * whose second guard forbids any `flags.no<Something>` read — with `no-*`
 * declarations banned, the parser can never emit such a key, so every one of
 * those reads is a permanent `undefined`.
 *
 * What this file adds is the positive half: that the key each handler now reads
 * carries the right value for both spellings, parsed through the REAL registered
 * command rather than a fixture. Together they cover both directions — the guard
 * stops a reader reaching for a key that cannot exist, these show the key that
 * does exist means what the handler thinks it means.
 */

import { describe, expect, it } from 'vitest';

import { CommandParser } from '../parser.js';
import { getCommandAsync } from '../commands/index.js';
import type { Command } from '../types.js';

/** Parse `argv` against the real registered `command`, returning its flags. */
async function parseFor(command: string, argv: string[]): Promise<Record<string, unknown>> {
  const parser = new CommandParser();
  const cmd = await getCommandAsync(command);
  expect(cmd, `command '${command}' is not registered`).toBeTruthy();
  parser.registerCommand(cmd as Command);
  return parser.parse([command, ...argv]).flags as unknown as Record<string, unknown>;
}

describe('--no-<x> flags take effect (#1474)', () => {
  it('flo daemon start --no-dashboard suppresses the dashboard', async () => {
    const off = await parseFor('daemon', ['start', '--no-dashboard']);
    const on = await parseFor('daemon', ['start']);

    // daemon.ts reads `ctx.flags.dashboard === false`.
    expect(off.dashboard === false).toBe(true);
    expect(on.dashboard === false).toBe(false);
  });

  it('flo memory index-guidance --no-embeddings skips embedding generation', async () => {
    const off = await parseFor('memory', ['index-guidance', '--no-embeddings']);
    const on = await parseFor('memory', ['index-guidance']);

    // memory.ts reads `ctx.flags.embeddings === false` in both index-guidance
    // and code-map.
    expect(off.embeddings === false).toBe(true);
    expect(on.embeddings === false).toBe(false);
  });

  it('flo memory code-map --no-embeddings skips embedding generation', async () => {
    const off = await parseFor('memory', ['code-map', '--no-embeddings']);

    expect(off.embeddings === false).toBe(true);
  });

  it('flo hooks coverage-route --no-movector disables the native backend', async () => {
    const off = await parseFor('hooks', ['coverage-route', '--no-movector']);
    const on = await parseFor('hooks', ['coverage-route']);

    // hooks.ts reads `ctx.flags.movector !== false`.
    expect(off.movector !== false).toBe(false);
    expect(on.movector !== false).toBe(true);
  });

  it('flo hooks statusline --no-color drops ANSI colors', async () => {
    const off = await parseFor('hooks', ['statusline', '--no-color']);
    const on = await parseFor('hooks', ['statusline']);

    // hooks.ts reads `ctx.flags.color === false`.
    expect(off.color === false).toBe(true);
    expect(on.color === false).toBe(false);
  });

  it('flo spell schedule --no-autostart skips the login-service registration', async () => {
    const off = await parseFor('spell', ['schedule', '--no-autostart']);
    const on = await parseFor('spell', ['schedule']);

    // spell-schedule.ts reads `ctx.flags.autostart === false`.
    expect(off.autostart === false).toBe(true);
    expect(on.autostart === false).toBe(false);
  });

  it('flo hive-mind spawn --no-auto-permissions stops automatic permission handling', async () => {
    const off = await parseFor('hive-mind', ['spawn', '--no-auto-permissions']);
    const on = await parseFor('hive-mind', ['spawn']);

    // hive-mind.ts reads `flags.autoPermissions === false`.
    expect(off.autoPermissions === false).toBe(true);
    expect(on.autoPermissions === false).toBe(false);
  });

  it('flo epic run --no-merge forces the single-branch strategy', async () => {
    const off = await parseFor('epic', ['run', '42', '--no-merge']);
    const on = await parseFor('epic', ['run', '42']);

    // epic.ts reads `ctx.flags.merge === false`. This one had teeth: the flag is
    // documented as an alias for --strategy single-branch, and while it was a
    // no-op an epic asked for single-branch ran auto-merge instead.
    expect(off.merge === false).toBe(true);
    expect(on.merge === false).toBe(false);
  });

  it('the global --no-update suppresses the startup update check', () => {
    const parser = new CommandParser();
    const off = parser.parse(['--no-update']).flags as unknown as Record<string, unknown>;
    const on = parser.parse([]).flags as unknown as Record<string, unknown>;

    // index.ts reads `flags.update !== false`.
    expect(off.update !== false).toBe(false);
    expect(on.update !== false).toBe(true);
  });

  it('the global --no-color disables colored output', () => {
    // Global options live on the parser, not the command tree. This one also
    // had the defect: `index.ts` read `flags.noColor`, which the parser never
    // set, so `--no-color` never disabled anything.
    const parser = new CommandParser();
    const off = parser.parse(['--no-color']).flags as unknown as Record<string, unknown>;
    const on = parser.parse([]).flags as unknown as Record<string, unknown>;

    // index.ts reads `flags.color === false`.
    expect(off.color === false).toBe(true);
    // A global's declared default IS applied, unlike a command-level one.
    expect(on.color).toBe(true);
  });
});
