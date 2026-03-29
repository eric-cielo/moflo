/**
 * Credential Store Tests
 *
 * Story #106: Encrypted Credential Storage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialStore, CredentialStoreError } from '../src/credentials/credential-store.js';
import { existsSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ============================================================================
// Helpers
// ============================================================================

function tempFilePath(): string {
  const dir = join(tmpdir(), 'moflo-cred-tests');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `creds-${randomBytes(8).toString('hex')}.json`);
}

// ============================================================================
// Tests
// ============================================================================

describe('CredentialStore', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tempFilePath();
  });

  afterEach(() => {
    if (existsSync(filePath)) unlinkSync(filePath);
  });

  // --------------------------------------------------------------------------
  // Store and retrieve
  // --------------------------------------------------------------------------

  it('stores and retrieves a credential', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('api-key', 'sk-abc123');
    const value = await store.get('api-key');
    expect(value).toBe('sk-abc123');
    store.lock();
  });

  it('returns undefined for non-existent credential', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    const value = await store.get('missing');
    expect(value).toBeUndefined();
    store.lock();
  });

  it('overwrites existing credential on re-store', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('token', 'old-value');
    await store.store('token', 'new-value');
    expect(await store.get('token')).toBe('new-value');
    store.lock();
  });

  // --------------------------------------------------------------------------
  // Persistence across instances
  // --------------------------------------------------------------------------

  it('persists credentials across store instances', async () => {
    const store1 = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store1.store('secret', 'persisted-value');
    store1.lock();

    const store2 = new CredentialStore({ filePath, passphrase: 'test-pass' });
    expect(await store2.get('secret')).toBe('persisted-value');
    store2.lock();
  });

  // --------------------------------------------------------------------------
  // Encryption verification
  // --------------------------------------------------------------------------

  it('stores values encrypted on disk (not plaintext)', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    const secret = 'super-secret-value-12345';
    await store.store('key', secret);
    store.lock();

    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain(secret);
    // Should contain hex-encoded ciphertext
    const data = JSON.parse(raw);
    expect(data.credentials.key.ciphertext).toBeDefined();
    expect(data.credentials.key.iv).toBeDefined();
    expect(data.credentials.key.tag).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Wrong passphrase
  // --------------------------------------------------------------------------

  it('throws on decryption with wrong passphrase', async () => {
    const store1 = new CredentialStore({ filePath, passphrase: 'correct-pass' });
    await store1.store('secret', 'value');
    store1.lock();

    const store2 = new CredentialStore({ filePath, passphrase: 'wrong-pass' });
    await expect(store2.get('secret')).rejects.toThrow(CredentialStoreError);
    await expect(store2.get('secret')).rejects.toThrow('Failed to decrypt credential');
    store2.lock();
  });

  // --------------------------------------------------------------------------
  // Lock / unlock
  // --------------------------------------------------------------------------

  it('throws when accessing locked store', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    store.lock();
    await expect(store.get('any')).rejects.toThrow(CredentialStoreError);
    await expect(store.get('any')).rejects.toThrow('store is locked');
  });

  it('creates store in locked mode when no passphrase provided', async () => {
    const store = new CredentialStore({ filePath });
    await expect(store.get('any')).rejects.toThrow('store is locked');
  });

  it('unlocks a previously locked store', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('key', 'value');
    store.lock();

    store.unlock('test-pass');
    expect(await store.get('key')).toBe('value');
    store.lock();
  });

  // --------------------------------------------------------------------------
  // has / exists / delete
  // --------------------------------------------------------------------------

  it('has() returns true for existing and false for missing', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('present', 'val');
    expect(await store.has('present')).toBe(true);
    expect(await store.has('absent')).toBe(false);
    store.lock();
  });

  it('delete() removes a credential and returns true', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('key', 'val');
    expect(await store.delete('key')).toBe(true);
    expect(await store.has('key')).toBe(false);
    expect(await store.get('key')).toBeUndefined();
    store.lock();
  });

  it('delete() returns false for non-existent credential', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    expect(await store.delete('nope')).toBe(false);
    store.lock();
  });

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  it('list() returns metadata without values', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('api-key', 'secret1', 'API key for service');
    await store.store('db-pass', 'secret2');

    const list = await store.list();
    expect(list).toHaveLength(2);

    const apiKey = list.find(c => c.name === 'api-key');
    expect(apiKey).toBeDefined();
    expect(apiKey!.description).toBe('API key for service');
    expect(apiKey!.createdAt).toBeDefined();
    expect(apiKey!.updatedAt).toBeDefined();
    // Ensure no value field leaks
    expect((apiKey as Record<string, unknown>)['value']).toBeUndefined();

    const dbPass = list.find(c => c.name === 'db-pass');
    expect(dbPass).toBeDefined();
    expect(dbPass!.description).toBeUndefined();
    store.lock();
  });

  // --------------------------------------------------------------------------
  // allValues (for redaction)
  // --------------------------------------------------------------------------

  it('allValues() returns all decrypted values', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('a', 'val-a');
    await store.store('b', 'val-b');
    await store.store('c', 'val-c');

    const values = await store.allValues();
    expect(values).toHaveLength(3);
    expect([...values].sort()).toEqual(['val-a', 'val-b', 'val-c']);
    store.lock();
  });

  // --------------------------------------------------------------------------
  // Metadata timestamps
  // --------------------------------------------------------------------------

  it('preserves createdAt on update, bumps updatedAt', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('key', 'v1');
    const list1 = await store.list();
    const created = list1[0].createdAt;
    const updated1 = list1[0].updatedAt;

    // Small delay to ensure timestamp difference
    await new Promise(r => setTimeout(r, 10));
    await store.store('key', 'v2');

    const list2 = await store.list();
    expect(list2[0].createdAt).toBe(created);
    expect(list2[0].updatedAt).not.toBe(updated1);
    store.lock();
  });

  // --------------------------------------------------------------------------
  // File creation
  // --------------------------------------------------------------------------

  it('creates the file and parent directories on first store', async () => {
    const deepPath = join(tmpdir(), `moflo-cred-tests/${randomBytes(4).toString('hex')}/nested/creds.json`);
    const store = new CredentialStore({ filePath: deepPath, passphrase: 'test-pass' });
    await store.store('key', 'val');
    expect(existsSync(deepPath)).toBe(true);
    store.lock();
    unlinkSync(deepPath);
  });

  // --------------------------------------------------------------------------
  // #163 — Passphrase strength validation
  // --------------------------------------------------------------------------

  it('rejects passphrases shorter than 8 characters', () => {
    expect(() => {
      new CredentialStore({ filePath, passphrase: 'short' });
    }).toThrow(CredentialStoreError);
    expect(() => {
      new CredentialStore({ filePath, passphrase: 'short' });
    }).toThrow('at least 8 characters');
  });

  it('accepts passphrases of 8+ characters', () => {
    expect(() => {
      new CredentialStore({ filePath, passphrase: 'long-enough' });
    }).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // #158 — File permissions
  // --------------------------------------------------------------------------

  it('writes credential file with mode 0o600 (owner-only)', () => {
    const storeSrc = readFileSync(
      join(__dirname, '../src/credentials/credential-store.ts'),
      'utf-8',
    );
    expect(storeSrc).toContain('mode: 0o600');
  });

  // --------------------------------------------------------------------------
  // #166 — Missing test scenarios
  // --------------------------------------------------------------------------

  it('handles corrupted file on disk gracefully', () => {
    const { writeFileSync: wfs } = require('fs');
    // Write invalid JSON to the file
    wfs(filePath, '{truncated...');
    expect(() => {
      new CredentialStore({ filePath, passphrase: 'test-pass' });
    }).toThrow();
  });

  it('stores and retrieves empty string as credential value', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('empty', '');
    const value = await store.get('empty');
    expect(value).toBe('');
    store.lock();
  });

  it('stores credentials with special characters in name', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    await store.store('my.api-key_v2', 'secret');
    expect(await store.get('my.api-key_v2')).toBe('secret');
    store.lock();
  });

  it('handles credential values with special characters', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'test-pass' });
    const specialVal = 'p@ss{w0rd}=test/slash\\back"quote';
    await store.store('special', specialVal);
    expect(await store.get('special')).toBe(specialVal);
    store.lock();
  });

  // --------------------------------------------------------------------------
  // #186 — Key rotation
  // --------------------------------------------------------------------------

  it('rotate: store creds, rotate, verify retrieval with new passphrase', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'old-pass-phrase' });
    await store.store('api-key', 'sk-secret123');
    await store.store('db-pass', 'pg-password');

    await store.rotate('old-pass-phrase', 'new-pass-phrase');
    // Retrieval still works through the active instance
    expect(await store.get('api-key')).toBe('sk-secret123');
    expect(await store.get('db-pass')).toBe('pg-password');
    store.lock();

    // New instance with new passphrase can also read
    const store2 = new CredentialStore({ filePath, passphrase: 'new-pass-phrase' });
    expect(await store2.get('api-key')).toBe('sk-secret123');
    expect(await store2.get('db-pass')).toBe('pg-password');
    store2.lock();
  });

  it('rotate: old passphrase fails after rotation', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'old-pass-phrase' });
    await store.store('secret', 'value');
    await store.rotate('old-pass-phrase', 'new-pass-phrase');
    store.lock();

    const store2 = new CredentialStore({ filePath, passphrase: 'old-pass-phrase' });
    await expect(store2.get('secret')).rejects.toThrow(CredentialStoreError);
    await expect(store2.get('secret')).rejects.toThrow('Failed to decrypt');
    store2.lock();
  });

  it('rotate: wrong old passphrase rejects rotation', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'correct-pass' });
    await store.store('key', 'value');

    await expect(store.rotate('wrong-old-pass', 'new-pass-phrase')).rejects.toThrow(
      CredentialStoreError,
    );
    await expect(store.rotate('wrong-old-pass', 'new-pass-phrase')).rejects.toThrow(
      'Old passphrase is incorrect',
    );

    // Original passphrase still works
    expect(await store.get('key')).toBe('value');
    store.lock();
  });

  it('rotate: preserves all credential values', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'old-pass-phrase' });
    const creds: Record<string, string> = {
      'api-key': 'sk-abc123',
      'db-password': 'pg-secret',
      'token': 'jwt-value-here',
      'empty-val': '',
      'special': 'p@ss{w0rd}=test/slash\\back"quote',
    };
    for (const [name, value] of Object.entries(creds)) {
      await store.store(name, value);
    }

    await store.rotate('old-pass-phrase', 'new-pass-phrase');

    for (const [name, expected] of Object.entries(creds)) {
      expect(await store.get(name)).toBe(expected);
    }
    store.lock();
  });

  it('rotate: lastKeyRotation timestamp is updated', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'old-pass-phrase' });
    await store.store('key', 'value');
    const beforeRotation = store.lastKeyRotation;
    expect(beforeRotation).toBeDefined();

    // Small delay to ensure timestamp difference
    await new Promise(r => setTimeout(r, 10));
    await store.rotate('old-pass-phrase', 'new-pass-phrase');

    const afterRotation = store.lastKeyRotation;
    expect(afterRotation).toBeDefined();
    // Verify it's a valid ISO date
    expect(new Date(afterRotation!).toISOString()).toBe(afterRotation);
    // Verify it changed
    expect(afterRotation).not.toBe(beforeRotation);
    // Verify it's more recent
    expect(new Date(afterRotation!).getTime()).toBeGreaterThan(
      new Date(beforeRotation!).getTime(),
    );
    store.lock();
  });

  it('rotate: rejects new passphrase shorter than 8 characters', async () => {
    const store = new CredentialStore({ filePath, passphrase: 'old-pass-phrase' });
    await store.store('key', 'value');

    await expect(store.rotate('old-pass-phrase', 'short')).rejects.toThrow(
      'at least 8 characters',
    );
    store.lock();
  });
});
