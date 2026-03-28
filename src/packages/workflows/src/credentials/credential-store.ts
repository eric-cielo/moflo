/**
 * Encrypted Credential Store
 *
 * Provides at-rest encryption for workflow secrets using AES-256-GCM
 * with PBKDF2 key derivation. Implements the CredentialAccessor interface
 * so workflows can reference secrets by name via {credentials.NAME}.
 *
 * Story #106: Encrypted Credential Storage
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialAccessor } from '../types/step-command.types.js';

// ============================================================================
// Types
// ============================================================================

export interface CredentialMeta {
  readonly name: string;
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialStoreOptions {
  /** Path to the encrypted credentials file. */
  readonly filePath: string;
  /** Passphrase for key derivation. If omitted, store operates in locked mode. */
  readonly passphrase?: string;
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  ciphertext: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoreData {
  salt: string;
  credentials: Record<string, EncryptedEntry>;
}

// ============================================================================
// Constants
// ============================================================================

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';

// ============================================================================
// Encryption Helpers
// ============================================================================

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_DIGEST);
}

function encrypt(plaintext: string, key: Buffer): { iv: string; tag: string; ciphertext: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

function decrypt(entry: { iv: string; tag: string; ciphertext: string }, key: Buffer): string {
  const iv = Buffer.from(entry.iv, 'hex');
  const tag = Buffer.from(entry.tag, 'hex');
  const ciphertext = Buffer.from(entry.ciphertext, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

// ============================================================================
// Credential Store
// ============================================================================

export class CredentialStore implements CredentialAccessor {
  private readonly filePath: string;
  private derivedKey: Buffer | null = null;
  private data: StoreData | null = null;

  constructor(options: CredentialStoreOptions) {
    this.filePath = options.filePath;
    if (options.passphrase) {
      this.unlock(options.passphrase);
    }
  }

  /**
   * Unlock the store with a passphrase.
   * Derives the encryption key and loads existing data.
   */
  unlock(passphrase: string): void {
    if (passphrase.length < 8) {
      throw new CredentialStoreError('Passphrase must be at least 8 characters');
    }
    this.data = this.readFile();
    const salt = Buffer.from(this.data.salt, 'hex');
    this.derivedKey = deriveKey(passphrase, salt);
  }

  /**
   * Lock the store, clearing the derived key from memory.
   */
  lock(): void {
    if (this.derivedKey) {
      this.derivedKey.fill(0);
    }
    this.derivedKey = null;
    this.data = null;
  }

  /**
   * Store an encrypted credential.
   */
  async store(name: string, value: string, description?: string): Promise<void> {
    this.ensureUnlocked();
    const now = new Date().toISOString();
    const encrypted = encrypt(value, this.derivedKey!);

    const existing = this.data!.credentials[name];
    this.data!.credentials[name] = {
      ...encrypted,
      description: description ?? existing?.description,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.writeFile(this.data!);
  }

  /**
   * Retrieve a decrypted credential value.
   * Implements CredentialAccessor.get().
   */
  async get(name: string): Promise<string | undefined> {
    this.ensureUnlocked();
    const entry = this.data!.credentials[name];
    if (!entry) return undefined;

    try {
      return decrypt(entry, this.derivedKey!);
    } catch {
      throw new CredentialStoreError(
        `Failed to decrypt credential "${name}". Wrong passphrase?`,
        'DECRYPTION_FAILED',
      );
    }
  }

  /**
   * Check if a credential exists.
   * Implements CredentialAccessor.has().
   */
  async has(name: string): Promise<boolean> {
    this.ensureUnlocked();
    return name in this.data!.credentials;
  }

  /**
   * Delete a credential.
   */
  async delete(name: string): Promise<boolean> {
    this.ensureUnlocked();
    if (!(name in this.data!.credentials)) return false;
    delete this.data!.credentials[name];
    this.writeFile(this.data!);
    return true;
  }

  /**
   * List credential metadata (names + descriptions, never values).
   */
  async list(): Promise<readonly CredentialMeta[]> {
    this.ensureUnlocked();
    return Object.entries(this.data!.credentials).map(([name, entry]) => ({
      name,
      description: entry.description,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
  }

  /**
   * Collect all decrypted values for output redaction.
   * Used by the runner to build credential patterns.
   */
  async allValues(): Promise<readonly string[]> {
    this.ensureUnlocked();
    const values: string[] = [];
    for (const entry of Object.values(this.data!.credentials)) {
      try {
        values.push(decrypt(entry, this.derivedKey!));
      } catch {
        // Skip entries that can't be decrypted
      }
    }
    return values;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private ensureUnlocked(): void {
    if (!this.derivedKey || !this.data) {
      throw new CredentialStoreError(
        'Credential store is locked. Call unlock(passphrase) first.',
        'STORE_LOCKED',
      );
    }
  }

  private readFile(): StoreData {
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content) as StoreData;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          salt: randomBytes(SALT_BYTES).toString('hex'),
          credentials: {},
        };
      }
      throw new CredentialStoreError(
        `Failed to read credential store at ${this.filePath}`,
        'READ_FAILED',
      );
    }
  }

  private writeFile(data: StoreData): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }
}

// ============================================================================
// Error
// ============================================================================

export type CredentialStoreErrorCode = 'DECRYPTION_FAILED' | 'STORE_LOCKED' | 'READ_FAILED';

export class CredentialStoreError extends Error {
  constructor(
    message: string,
    public readonly code: CredentialStoreErrorCode,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}
