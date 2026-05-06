/**
 * Credentials barrel — public surface of the credential subsystem.
 */

export {
  CredentialStore,
  CredentialStoreError,
  MIN_PASSPHRASE_LENGTH,
  type CredentialMeta,
  type CredentialStoreOptions,
  type CredentialStoreErrorCode,
} from './credential-store.js';

export {
  getDefaultCredentialStore,
  resetDefaultCredentialStore,
  resolveCredentialFilePath,
  resolveKeyFilePath,
  resolvePassphrase,
  lockedNoopAccessor,
  DEFAULT_CREDENTIALS_FILE,
  DEFAULT_CREDENTIALS_KEY_FILE,
  type DefaultCredentialStoreOptions,
} from './default-store.js';
