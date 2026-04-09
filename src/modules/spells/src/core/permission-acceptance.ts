/**
 * Permission Acceptance Gate
 *
 * Stores user acceptance of a spell's permission profile and blocks real
 * runs when acceptance is missing or stale (permission hash changed).
 *
 * Acceptance is stored per-spell as a file in `.moflo/accepted-permissions/`.
 * The file contains the permission hash that was accepted. When the spell's
 * permission profile changes (steps added/removed, capabilities changed),
 * the hash changes and a new dry-run + acceptance is required.
 *
 * Flow:
 *   1. User creates/edits spell → dry-run shows permission report
 *   2. User accepts → hash stored via `recordAcceptance()`
 *   3. User runs spell → `checkAcceptance()` verifies hash matches
 *   4. If hash mismatch → runner blocks with ACCEPTANCE_REQUIRED error
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ============================================================================
// Acceptance Record
// ============================================================================

export interface AcceptanceRecord {
  /** The spell name or definition file path. */
  readonly spellIdentifier: string;
  /** SHA-256 hash prefix of the accepted permission profile. */
  readonly permissionHash: string;
  /** ISO timestamp of when acceptance was recorded. */
  readonly acceptedAt: string;
}

export interface AcceptanceCheckResult {
  /** Whether the spell has a valid, current acceptance. */
  readonly accepted: boolean;
  /** If not accepted, the reason why. */
  readonly reason?: 'no-acceptance' | 'hash-mismatch';
  /** The stored acceptance record, if any. */
  readonly record?: AcceptanceRecord;
}

// ============================================================================
// Storage
// ============================================================================

const ACCEPTANCE_DIR = '.moflo/accepted-permissions';

function acceptanceFilePath(projectRoot: string, spellIdentifier: string): string {
  // Sanitize the spell identifier for use as a filename
  const safeName = spellIdentifier.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(projectRoot, ACCEPTANCE_DIR, `${safeName}.json`);
}

/**
 * Record that a user has accepted a spell's permission profile.
 */
export async function recordAcceptance(
  projectRoot: string,
  spellIdentifier: string,
  permissionHash: string,
): Promise<void> {
  const filePath = acceptanceFilePath(projectRoot, spellIdentifier);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const record: AcceptanceRecord = {
    spellIdentifier,
    permissionHash,
    acceptedAt: new Date().toISOString(),
  };

  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

/**
 * Check whether a spell has a valid, current acceptance.
 */
export async function checkAcceptance(
  projectRoot: string,
  spellIdentifier: string,
  currentPermissionHash: string,
): Promise<AcceptanceCheckResult> {
  const filePath = acceptanceFilePath(projectRoot, spellIdentifier);

  if (!existsSync(filePath)) {
    return { accepted: false, reason: 'no-acceptance' };
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    const record: AcceptanceRecord = JSON.parse(content);

    if (record.permissionHash !== currentPermissionHash) {
      return { accepted: false, reason: 'hash-mismatch', record };
    }

    return { accepted: true, record };
  } catch {
    return { accepted: false, reason: 'no-acceptance' };
  }
}

/**
 * Clear acceptance for a spell (e.g., after an edit that changes permissions).
 */
export async function clearAcceptance(
  projectRoot: string,
  spellIdentifier: string,
): Promise<void> {
  const filePath = acceptanceFilePath(projectRoot, spellIdentifier);
  if (existsSync(filePath)) {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
  }
}
