/**
 * Canonical unique-ID minting.
 *
 * ## Why this module exists
 *
 * Story #801 fixed `agent_spawn` after base-36 slicing of `Math.random()` was
 * *observably* colliding under burst spawns — the comment recording that still
 * sits in `mcp-tools/agent-tools.ts`. The fix was applied there and at a handful
 * of neighbours and stopped; ~38 other sites kept minting IDs the same way, and
 * four separate `generateId` helpers accumulated around them (three live and
 * identically named, in `memory/controllers/_shared.ts`, `memory/bridge-core.ts`
 * and `memory/persistent-sona.ts`, plus an unused `shared/security/secure-random.ts`).
 * This module is the one they all now route through (#1423).
 *
 * A base-36 slice of `Math.random()` carries roughly 31 bits of entropy before
 * slicing and far less after — two entities minted in the same
 * millisecond can share an identity, which for a swarm or agent ID means two
 * distinct actors silently occupying one slot.
 *
 * ## Severity
 *
 * This is a **correctness** fix, not a security one. These IDs are not secrets,
 * capabilities, or session tokens; nothing here depends on unpredictability. The
 * property being restored is uniqueness. (`Math.random()` remains entirely
 * correct for neural weight init, epsilon-greedy exploration, HNSW level
 * selection, and jitter — none of those are touched.)
 */

import { randomBytes } from 'node:crypto';

/** Default CSPRNG entropy per ID: 6 bytes = 48 bits = 12 hex characters. */
const DEFAULT_ENTROPY_BYTES = 6;

export interface IdOptions {
  /**
   * Segment separator. Defaults to `-`; pass `_` for the call sites that
   * already emit snake-cased IDs. Existing formats are preserved deliberately —
   * some of these IDs are persisted to `.moflo/moflo.db`, and changing their
   * shape would churn consumer state for no benefit (Rule #2).
   */
  separator?: string;
  /** Bytes of entropy, hex-encoded (2 characters each). Defaults to 6. */
  bytes?: number;
  /** Encode the timestamp in base36 rather than base10. */
  base36Time?: boolean;
}

/**
 * Mint a unique ID of the form `<prefix><sep><timestamp><sep><random-hex>`.
 *
 * The timestamp segment is retained from the patterns this replaces: it keeps
 * IDs roughly sortable by creation time and is useful when reading them in logs.
 * Uniqueness rests on the random segment alone.
 */
export function generateId(prefix: string, options: IdOptions = {}): string {
  const {
    separator = '-',
    bytes = DEFAULT_ENTROPY_BYTES,
    base36Time = false,
  } = options;
  const timestamp = base36Time ? Date.now().toString(36) : String(Date.now());
  return `${prefix}${separator}${timestamp}${separator}${randomBytes(bytes).toString('hex')}`;
}

/**
 * A bare random segment, for the ID shapes that are not
 * `prefix + timestamp + random` — a temp-file suffix, a probe stamp, an ID whose
 * middle segment is a loop index rather than a clock reading.
 *
 * Prefer {@link generateId} when the shape does fit; this exists so the odd ones
 * out do not have to keep reaching for `Math.random()`.
 */
export function randomSuffix(bytes: number = DEFAULT_ENTROPY_BYTES): string {
  return randomBytes(bytes).toString('hex');
}
