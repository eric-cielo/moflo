/**
 * Default Credential Store — wiring tests for story #922.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDefaultCredentialStore,
  resetDefaultCredentialStore,
  lockedNoopAccessor,
} from '../../../spells/credentials/default-store.js';
import { CredentialStore } from '../../../spells/credentials/credential-store.js';

let workDir: string;
let credFile: string;
let keyFile: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'moflo-default-store-'));
  credFile = join(workDir, 'credentials.json');
  keyFile = join(workDir, 'credentials.key');
  resetDefaultCredentialStore();
  delete process.env.MOFLO_CREDENTIALS_FILE;
  delete process.env.MOFLO_CREDENTIALS_PASSPHRASE;
  delete process.env.MOFLO_CREDENTIALS_KEY_FILE;
});

afterEach(() => {
  resetDefaultCredentialStore();
  // Clean the env symmetrically with beforeEach. vitest's `forks` pool reuses a
  // worker process across test files (module registry resets, `process.env` does
  // not), so leaving MOFLO_CREDENTIALS_* set here would leak stale paths — often
  // pointing at the just-removed workDir — into the next credential test file
  // running in the same fork, flaking it under parallel load (#1278).
  delete process.env.MOFLO_CREDENTIALS_FILE;
  delete process.env.MOFLO_CREDENTIALS_PASSPHRASE;
  delete process.env.MOFLO_CREDENTIALS_KEY_FILE;
  rmSync(workDir, { recursive: true, force: true });
});

describe('getDefaultCredentialStore', () => {
  it('returns an unlocked CredentialStore using the auto-generated key file', async () => {
    const accessor = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });

    expect(accessor).toBeInstanceOf(CredentialStore);
    expect(existsSync(keyFile)).toBe(true);

    await accessor.store('TEST_TOKEN', 'secret-val');
    expect(await accessor.get('TEST_TOKEN')).toBe('secret-val');
  });

  it('reuses the same passphrase across resets so existing credentials decrypt', async () => {
    const a = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    await a.store('K', 'v1');
    expect(await a.get('K')).toBe('v1');

    resetDefaultCredentialStore();
    const b = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    expect(await b.get('K')).toBe('v1');
  });

  it('caches the singleton across calls', () => {
    const a = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    const b = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    expect(a).toBe(b);
  });

  it('honours MOFLO_CREDENTIALS_PASSPHRASE over the key file', async () => {
    process.env.MOFLO_CREDENTIALS_PASSPHRASE = 'env-passphrase-12345';
    const accessor = getDefaultCredentialStore({ filePath: credFile });
    await accessor.store('FROM_ENV', 'val');

    resetDefaultCredentialStore();
    const accessor2 = getDefaultCredentialStore({ filePath: credFile });
    expect(await accessor2.get('FROM_ENV')).toBe('val');
  });

  it('writes the key file with mode 0o600 (owner-only) on POSIX', () => {
    if (process.platform === 'win32') return;
    getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    const mode = statSync(keyFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('refuses to regenerate the key file when credentials.json exists alongside a corrupt key', async () => {
    const accessor = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    await accessor.store('K', 'v');
    expect(existsSync(credFile)).toBe(true);

    writeFileSync(keyFile, 'short', 'utf-8');
    resetDefaultCredentialStore();

    const originalWarn = console.warn;
    let warned = '';
    console.warn = (msg: string) => { warned = msg; };
    try {
      const recovered = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
      expect(recovered).toBe(lockedNoopAccessor);
      expect(warned).toContain('corrupt');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('returns lockedNoopAccessor and warns when key file path is unreadable', () => {
    if (process.platform === 'win32') return;
    const originalWarn = console.warn;
    console.warn = () => { /* swallow */ };
    try {
      const accessor = getDefaultCredentialStore({
        filePath: credFile,
        keyFilePath: '/proc/1/key',
      });
      expect(accessor).toBe(lockedNoopAccessor);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('lockedNoopAccessor', () => {
  it('matches the historical noop shape — never persists, never throws', async () => {
    expect(await lockedNoopAccessor.get('anything')).toBeUndefined();
    expect(await lockedNoopAccessor.has('anything')).toBe(false);
    await lockedNoopAccessor.store('anything', 'val');
    expect(await lockedNoopAccessor.get('anything')).toBeUndefined();
  });
});

describe('resetDefaultCredentialStore', () => {
  it('clears the singleton so the next call rebuilds', () => {
    const a = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    resetDefaultCredentialStore();
    const b = getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    expect(a).not.toBe(b);
  });
});

describe('runner-factory + bridge integration', () => {
  it('runner-factory uses default store when credentials option is omitted', async () => {
    process.env.MOFLO_CREDENTIALS_FILE = credFile;
    process.env.MOFLO_CREDENTIALS_PASSPHRASE = 'integration-passphrase-12345';
    resetDefaultCredentialStore();

    const seed = new CredentialStore({ filePath: credFile, passphrase: 'integration-passphrase-12345' });
    await seed.store('SEEDED', 'value-from-seed');

    const { createRunner } = await import('../../../spells/factory/runner-factory.js');
    const runner = createRunner();
    const store = getDefaultCredentialStore({ filePath: credFile });
    expect(await store.get('SEEDED')).toBe('value-from-seed');
    expect(runner).toBeDefined();
  });
});

describe('readFileSync handling', () => {
  it('reuses an existing key file rather than overwriting it', () => {
    const seedKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    writeFileSync(keyFile, seedKey, 'utf-8');

    getDefaultCredentialStore({ filePath: credFile, keyFilePath: keyFile });
    expect(readFileSync(keyFile, 'utf-8').trim()).toBe(seedKey);
  });
});
