/**
 * Default Credential Store
 *
 * Singleton `CredentialAccessor` wired into the runner factory, MCP bridge,
 * and daemon executor so spells persist secrets between casts.
 *
 * Passphrase resolution: `MOFLO_CREDENTIALS_PASSPHRASE` env var, else an
 * auto-generated `~/.moflo/credentials.key` (32 random bytes hex, mode
 * 0o600) created on first need. The auto-key gives zero-config at-rest
 * encryption — the threat model matches `~/.aws/credentials`: filesystem
 * read by an attacker compromises the store either way.
 *
 * Failures degrade to `lockedNoopAccessor` (returns undefined / no-op
 * persists) so the spell engine never crashes on a missing or unreadable
 * credentials path.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CredentialStore, MIN_PASSPHRASE_LENGTH } from './credential-store.js';
import { mofloHomeDir } from '../../services/moflo-paths.js';
import type { CredentialAccessor } from '../types/step-command.types.js';

const KEY_BYTES = 32;
/** 64 hex chars from `KEY_BYTES`; floor of 16 catches truncation/corruption. */
const KEY_FILE_MIN_HEX_LENGTH = 16;

export const DEFAULT_CREDENTIALS_FILE = join(mofloHomeDir(), 'credentials.json');
export const DEFAULT_CREDENTIALS_KEY_FILE = join(mofloHomeDir(), 'credentials.key');

let cached: CredentialAccessor | null = null;

export interface DefaultCredentialStoreOptions {
  /** Override the credentials JSON path (else `MOFLO_CREDENTIALS_FILE` env or `~/.moflo/credentials.json`). */
  readonly filePath?: string;
  /** Override the auto-key file path (else `MOFLO_CREDENTIALS_KEY_FILE` env or `~/.moflo/credentials.key`). */
  readonly keyFilePath?: string;
  /** Override the passphrase (else `MOFLO_CREDENTIALS_PASSPHRASE` or generated key file). */
  readonly passphrase?: string;
}

/**
 * Resolve the singleton default credential store. Returns an unlocked
 * `CredentialStore` when a passphrase is available, otherwise a locked
 * no-op accessor. Never throws.
 */
export function getDefaultCredentialStore(
  options: DefaultCredentialStoreOptions = {},
): CredentialAccessor {
  if (cached) return cached;

  const filePath = resolveCredentialFilePath(options.filePath);
  const passphrase = resolvePassphrase(options.passphrase, options.keyFilePath);

  let accessor: CredentialAccessor;
  if (passphrase) {
    try {
      accessor = new CredentialStore({ filePath, passphrase });
    } catch (err) {
      console.warn(`[moflo:credentials] store unavailable: ${(err as Error).message}`);
      accessor = lockedNoopAccessor;
    }
  } else {
    accessor = lockedNoopAccessor;
  }

  cached = accessor;
  return accessor;
}

/** Reset the cached singleton — used by tests and CLI subcommands. */
export function resetDefaultCredentialStore(): void {
  cached = null;
}

/** Resolve the credentials JSON path (override → env → default). */
export function resolveCredentialFilePath(explicit?: string): string {
  return explicit ?? process.env.MOFLO_CREDENTIALS_FILE ?? DEFAULT_CREDENTIALS_FILE;
}

/** Resolve the key file path (override → env → default). */
export function resolveKeyFilePath(explicit?: string): string {
  return explicit ?? process.env.MOFLO_CREDENTIALS_KEY_FILE ?? DEFAULT_CREDENTIALS_KEY_FILE;
}

/**
 * Resolve a passphrase from explicit override, `MOFLO_CREDENTIALS_PASSPHRASE`,
 * or the auto-generated key file. Returns `undefined` when no path yields a
 * usable value (locked-store mode).
 */
export function resolvePassphrase(
  explicit?: string,
  keyFilePathOverride?: string,
): string | undefined {
  if (explicit) return explicit;
  const envPass = process.env.MOFLO_CREDENTIALS_PASSPHRASE;
  if (envPass && envPass.length >= MIN_PASSPHRASE_LENGTH) return envPass;
  return resolveKeyFilePassphrase(keyFilePathOverride);
}

function resolveKeyFilePassphrase(override: string | undefined): string | undefined {
  const keyPath = resolveKeyFilePath(override);

  try {
    let content: string | null = null;
    try {
      content = readFileSync(keyPath, 'utf-8').trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (content !== null) {
      if (content.length >= KEY_FILE_MIN_HEX_LENGTH) return content;
      // Refuse to regenerate over a corrupt key when credentials exist —
      // a fresh key would silently invalidate every stored secret.
      const credPath = join(dirname(keyPath), 'credentials.json');
      try {
        readFileSync(credPath);
        console.warn(`[moflo:credentials] key file at ${keyPath} is corrupt; refusing to regenerate while ${credPath} exists`);
        return undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    mkdirSync(dirname(keyPath), { recursive: true });
    const generated = randomBytes(KEY_BYTES).toString('hex');
    writeFileSync(keyPath, generated, { encoding: 'utf-8', mode: 0o600 });
    // chmod after write in case the create mode was masked by umask.
    try { chmodSync(keyPath, 0o600); } catch { /* best-effort on Windows */ }
    return generated;
  } catch (err) {
    console.warn(`[moflo:credentials] could not read/create key file: ${(err as Error).message}`);
    return undefined;
  }
}

export const lockedNoopAccessor: CredentialAccessor = {
  async get() { return undefined; },
  async has() { return false; },
  async store() { /* no-op */ },
  async delete() { return false; },
};
