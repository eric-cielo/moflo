/**
 * Spell Credentials CLI tests — story #925.
 *
 * Drives each subcommand directly via its `action(ctx)` so the assertions
 * focus on store interactions and exit codes, not on stdout formatting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, CommandContext } from '../../types.js';
import { CredentialStore } from '../../spells/credentials/credential-store.js';
import { spellCredentialsCommand } from '../../commands/spell-credentials.js';
import { spellCommand } from '../../commands/spell.js';

let workDir: string;
let credFile: string;
let keyFile: string;

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    args: [],
    flags: { _: [] },
    cwd: workDir,
    interactive: true,
    ...overrides,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'moflo-spell-creds-cli-'));
  credFile = join(workDir, 'credentials.json');
  keyFile = join(workDir, 'credentials.key');
  process.env.MOFLO_CREDENTIALS_FILE = credFile;
  process.env.MOFLO_CREDENTIALS_KEY_FILE = keyFile;
  process.env.MOFLO_CREDENTIALS_PASSPHRASE = 'cli-test-passphrase-12345';
});

afterEach(() => {
  delete process.env.MOFLO_CREDENTIALS_FILE;
  delete process.env.MOFLO_CREDENTIALS_KEY_FILE;
  delete process.env.MOFLO_CREDENTIALS_PASSPHRASE;
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function loadCommand(name: 'list' | 'set' | 'unset' | 'clear' | 'passphrase'): Command {
  const sub = spellCredentialsCommand.subcommands!.find(c => c.name === name);
  if (!sub) throw new Error(`subcommand ${name} not found`);
  return sub;
}

async function seedCred(name: string, value: string, description?: string) {
  const store = new CredentialStore({
    filePath: credFile,
    passphrase: process.env.MOFLO_CREDENTIALS_PASSPHRASE!,
  });
  await store.store(name, value, description);
}

describe('spell credentials list', () => {
  it('prints "no credentials" when the store is empty', async () => {
    const cmd = loadCommand('list');
    const result = await cmd.action!(makeCtx({ flags: { _: [], format: 'json' } }));
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual([]);
  });

  it('lists names + descriptions but never values', async () => {
    await seedCred('GRAPH_TOKEN', 'super-secret-value', 'Graph API token');
    await seedCred('SLACK_HOOK', 'webhook-url', 'OAP target');

    const cmd = loadCommand('list');
    const result = await cmd.action!(makeCtx({ flags: { _: [], format: 'json' } }));
    expect(result?.success).toBe(true);
    const data = result?.data as Array<{ name: string; description?: string }>;
    expect(data.map(d => d.name).sort()).toEqual(['GRAPH_TOKEN', 'SLACK_HOOK']);
    // Values must NEVER appear
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain('webhook-url');
  });

  it('returns locked-store error when the key file is corrupt and credentials exist', async () => {
    // First seed a credential so credentials.json exists, then corrupt the
    // key file. The resolver refuses to regenerate the key while creds exist
    // (would silently invalidate them) and returns the locked-store error.
    await seedCred('SOMETHING', 'value');
    delete process.env.MOFLO_CREDENTIALS_PASSPHRASE;
    writeFileSync(keyFile, 'short', 'utf-8');

    const originalWarn = console.warn;
    console.warn = () => { /* swallow expected warning */ };
    try {
      const cmd = loadCommand('list');
      const result = await cmd.action!(makeCtx());
      expect(result?.success).toBe(false);
      expect(result?.exitCode).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('spell credentials unset', () => {
  it('removes a stored credential', async () => {
    await seedCred('TO_DELETE', 'val');
    const cmd = loadCommand('unset');
    const result = await cmd.action!(makeCtx({ args: ['TO_DELETE'] }));
    expect(result?.success).toBe(true);

    const verify = new CredentialStore({
      filePath: credFile,
      passphrase: process.env.MOFLO_CREDENTIALS_PASSPHRASE!,
    });
    expect(await verify.has('TO_DELETE')).toBe(false);
  });

  it('returns exit 1 when credential name is missing', async () => {
    const cmd = loadCommand('unset');
    const result = await cmd.action!(makeCtx({ args: [] }));
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
  });

  it('returns exit 1 when credential does not exist', async () => {
    const cmd = loadCommand('unset');
    const result = await cmd.action!(makeCtx({ args: ['NEVER_STORED'] }));
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
  });
});

describe('spell credentials clear', () => {
  it('refuses to clear without --force in non-interactive mode', async () => {
    await seedCred('K1', 'v1');
    const cmd = loadCommand('clear');
    const result = await cmd.action!(makeCtx({ interactive: false, flags: { _: [] } }));
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);

    // Verify nothing was deleted
    const verify = new CredentialStore({
      filePath: credFile,
      passphrase: process.env.MOFLO_CREDENTIALS_PASSPHRASE!,
    });
    expect(await verify.has('K1')).toBe(true);
  });

  it('clears all credentials when --force is given', async () => {
    await seedCred('K1', 'v1');
    await seedCred('K2', 'v2');
    const cmd = loadCommand('clear');
    const result = await cmd.action!(makeCtx({ interactive: false, flags: { _: [], force: true } }));
    expect(result?.success).toBe(true);

    const verify = new CredentialStore({
      filePath: credFile,
      passphrase: process.env.MOFLO_CREDENTIALS_PASSPHRASE!,
    });
    expect(await verify.list()).toEqual([]);
  });

  it('reports "no credentials to clear" when store is empty', async () => {
    const cmd = loadCommand('clear');
    const result = await cmd.action!(makeCtx({ flags: { _: [], force: true } }));
    expect(result?.success).toBe(true);
  });
});

describe('spell credentials set', () => {
  it('refuses non-interactive runs', async () => {
    const cmd = loadCommand('set');
    const result = await cmd.action!(makeCtx({ interactive: false, args: ['NAME'] }));
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
  });

  it('returns exit 1 when name is missing', async () => {
    const cmd = loadCommand('set');
    const result = await cmd.action!(makeCtx({ args: [] }));
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
  });
});

describe('spell credentials passphrase', () => {
  it('refuses non-interactive runs', async () => {
    const cmd = loadCommand('passphrase');
    const result = await cmd.action!(makeCtx({ interactive: false }));
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
  });
});

describe('parent spell credentials command', () => {
  // Imports are hoisted to module scope (#1107) so the MCP-tool registry
  // cold-start (15 packages registered in mcp-client.ts) is paid once during
  // file setup, not inside the per-test 5s timer.

  it('lists subcommands', () => {
    expect(spellCredentialsCommand.name).toBe('credentials');
    const subnames = spellCredentialsCommand.subcommands!.map(s => s.name).sort();
    expect(subnames).toEqual(['clear', 'list', 'passphrase', 'set', 'unset']);
  });

  it('is wired under the parent spell command', () => {
    const creds = spellCommand.subcommands!.find(s => s.name === 'credentials');
    expect(creds).toBeDefined();
  });
});
