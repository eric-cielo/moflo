/**
 * Spell Credentials CLI
 *
 * `moflo spell credentials list/set/unset/clear/passphrase` — manage the
 * encrypted credential store the spell runner uses for unattended casts.
 *
 * Story #925 (epic #880).
 */

import { existsSync } from 'node:fs';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm, input } from '../prompt.js';
import {
  CredentialStore,
  CredentialStoreError,
  MIN_PASSPHRASE_LENGTH,
  resolveCredentialFilePath,
  resolvePassphrase,
  type CredentialMeta,
} from '../spells/credentials/index.js';

/**
 * Build a CredentialStore using the runner's passphrase resolution.
 * Returns null when no passphrase is available — caller surfaces the actionable error.
 */
function openStore(): CredentialStore | null {
  const filePath = resolveCredentialFilePath();
  const passphrase = resolvePassphrase();
  if (!passphrase) return null;
  try {
    return new CredentialStore({ filePath, passphrase });
  } catch (err) {
    output.printError(`Could not open credential store: ${(err as Error).message}`);
    return null;
  }
}

function noStoreError(): CommandResult {
  output.printError('Credential store is locked.');
  output.writeln('');
  output.writeln('  Set MOFLO_CREDENTIALS_PASSPHRASE in your environment, or run:');
  output.writeln('    flo spell credentials passphrase');
  output.writeln('');
  output.writeln('  to initialise a per-machine encryption key.');
  return { success: false, exitCode: 1 };
}

const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List stored credential names (never values)',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const store = openStore();
    if (!store) return noStoreError();

    const meta = await store.list();
    if (ctx.flags.format === 'json') {
      output.printJson(meta);
      return { success: true, data: meta };
    }

    if (meta.length === 0) {
      output.printInfo('No credentials stored. Use `flo spell credentials set <name>` to add one.');
      return { success: true };
    }

    output.writeln();
    output.writeln(output.bold('Stored credentials'));
    output.writeln();
    output.printTable({
      columns: [
        { key: 'name', header: 'Name', width: 28 },
        { key: 'description', header: 'Description', width: 35, format: (v: unknown) => v ? String(v) : '-' },
        { key: 'updatedAt', header: 'Updated', width: 22, format: (v: unknown) => v ? new Date(String(v)).toLocaleString() : '-' },
      ],
      data: meta as unknown as Record<string, unknown>[],
    });
    output.writeln();
    output.printInfo(`${meta.length} credential${meta.length === 1 ? '' : 's'}`);
    return { success: true, data: meta };
  },
};

const setCommand: Command = {
  name: 'set',
  description: 'Store a credential (prompts for the value with hidden input)',
  options: [
    { name: 'description', short: 'd', description: 'Optional description', type: 'string' },
  ],
  examples: [
    { command: 'moflo spell credentials set GRAPH_ACCESS_TOKEN', description: 'Store the Graph token' },
    { command: 'moflo spell credentials set SLACK_WEBHOOK_URL --description "OAP target"', description: 'With a description' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const name = ctx.args[0];
    if (!name) {
      output.printError('Credential name is required (e.g. `flo spell credentials set TOKEN`)');
      return { success: false, exitCode: 1 };
    }
    const store = openStore();
    if (!store) return noStoreError();

    if (!ctx.interactive) {
      output.printError('`set` requires an interactive TTY (the value is entered with hidden input).');
      return { success: false, exitCode: 1 };
    }

    const value = await input({ message: `Value for ${name}:`, mask: true });
    if (!value) {
      output.printError('No value entered — credential not stored.');
      return { success: false, exitCode: 1 };
    }

    const description = ctx.flags.description as string | undefined;
    await store.store(name, value, description);
    output.printSuccess(`Stored credential ${output.highlight(name)}.`);
    return { success: true };
  },
};

const unsetCommand: Command = {
  name: 'unset',
  aliases: ['delete', 'rm'],
  description: 'Remove a single credential',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const name = ctx.args[0];
    if (!name) {
      output.printError('Credential name is required (e.g. `flo spell credentials unset TOKEN`)');
      return { success: false, exitCode: 1 };
    }
    const store = openStore();
    if (!store) return noStoreError();

    const removed = await store.delete(name);
    if (!removed) {
      output.printError(`Credential ${output.highlight(name)} not found.`);
      return { success: false, exitCode: 1 };
    }
    output.printSuccess(`Removed credential ${output.highlight(name)}.`);
    return { success: true };
  },
};

const clearCommand: Command = {
  name: 'clear',
  description: 'Remove all stored credentials',
  options: [
    { name: 'force', short: 'f', description: 'Skip confirmation', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const store = openStore();
    if (!store) return noStoreError();

    const meta = await store.list();
    if (meta.length === 0) {
      output.printInfo('No credentials to clear.');
      return { success: true };
    }

    if (!(ctx.flags.force as boolean)) {
      if (!ctx.interactive) {
        output.printError('Refusing to clear without --force in non-interactive mode.');
        return { success: false, exitCode: 1 };
      }
      const ok = await confirm({
        message: `Delete all ${meta.length} stored credential${meta.length === 1 ? '' : 's'}?`,
        default: false,
      });
      if (!ok) {
        output.printInfo('Cancelled.');
        return { success: true };
      }
    }

    const removed = await store.clear();
    output.printSuccess(`Removed ${removed} credential${removed === 1 ? '' : 's'}.`);
    return { success: true };
  },
};

const passphraseCommand: Command = {
  name: 'passphrase',
  aliases: ['init', 'rotate'],
  description: 'Initialise the credential store passphrase, or rotate an existing one',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    if (!ctx.interactive) {
      output.printError('`passphrase` requires an interactive TTY.');
      return { success: false, exitCode: 1 };
    }
    const filePath = resolveCredentialFilePath();
    const exists = existsSync(filePath);
    const minHint = `(min ${MIN_PASSPHRASE_LENGTH} chars)`;

    if (!exists) {
      const newPass = await input({ message: `Choose a passphrase ${minHint}:`, mask: true });
      const confirmed = await input({ message: 'Confirm passphrase:', mask: true });
      if (newPass !== confirmed) {
        output.printError('Passphrases do not match.');
        return { success: false, exitCode: 1 };
      }
      try {
        const store = new CredentialStore({ filePath, passphrase: newPass });
        // Force a salted file write so the chosen passphrase locks the store.
        await store.store('__init__', 'init');
        await store.delete('__init__');
      } catch (err) {
        if (err instanceof CredentialStoreError && err.code === 'WEAK_PASSPHRASE') {
          output.printError(err.message);
          return { success: false, exitCode: 1 };
        }
        throw err;
      }
      output.printSuccess(`Initialised credential store at ${filePath}`);
      output.printInfo('Set MOFLO_CREDENTIALS_PASSPHRASE in your environment to keep schedules running unattended.');
      return { success: true };
    }

    const oldPass = await input({ message: 'Current passphrase:', mask: true });
    const newPass = await input({ message: `New passphrase ${minHint}:`, mask: true });
    const confirmed = await input({ message: 'Confirm new passphrase:', mask: true });
    if (newPass !== confirmed) {
      output.printError('Passphrases do not match.');
      return { success: false, exitCode: 1 };
    }
    try {
      const store = new CredentialStore({ filePath, passphrase: oldPass });
      await store.rotate(oldPass, newPass);
    } catch (err) {
      if (err instanceof CredentialStoreError) {
        output.printError(err.message);
        return { success: false, exitCode: 1 };
      }
      throw err;
    }
    output.printSuccess('Passphrase rotated. Update MOFLO_CREDENTIALS_PASSPHRASE if you set it in your environment.');
    return { success: true };
  },
};

export const spellCredentialsCommand: Command = {
  name: 'credentials',
  aliases: ['creds'],
  description: 'Manage the encrypted credential store used for unattended spell casts',
  subcommands: [listCommand, setCommand, unsetCommand, clearCommand, passphraseCommand],
  options: [],
  examples: [
    { command: 'moflo spell credentials list', description: 'Show stored credential names' },
    { command: 'moflo spell credentials set GRAPH_TOKEN', description: 'Store a credential' },
    { command: 'moflo spell credentials unset GRAPH_TOKEN', description: 'Remove a credential' },
    { command: 'moflo spell credentials clear --force', description: 'Wipe all credentials' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Spell Credentials'));
    output.writeln();
    output.writeln('Usage: moflo spell credentials <subcommand>');
    output.writeln();
    output.printList([
      `${output.highlight('list')}        - List stored credential names`,
      `${output.highlight('set')}         - Store a credential (hidden input)`,
      `${output.highlight('unset')}       - Remove a single credential`,
      `${output.highlight('clear')}       - Remove all stored credentials`,
      `${output.highlight('passphrase')}  - Initialise or rotate the passphrase`,
    ]);
    return { success: true };
  },
};

// Re-exported types kept available for tests that import them via this module.
export type { CredentialMeta };
