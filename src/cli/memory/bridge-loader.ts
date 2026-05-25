/**
 * Lazy AgentDB v3 bridge loader (ADR-053).
 *
 * Extracted from `memory-initializer.ts` (#1203 decomposition) so the
 * HNSW, embedding, entry-CRUD, and init modules share ONE process-wide
 * bridge singleton instead of each holding their own. Behaviour is
 * identical to the pre-split inline `getBridge()`: first call attempts the
 * dynamic import; a failure caches `null` so subsequent calls short-circuit.
 *
 * @module memory/bridge-loader
 */

// ADR-053: Lazy import of AgentDB v3 bridge.
// `undefined` = not yet attempted; `null` = attempted and failed (cached).
let _bridge: typeof import('./memory-bridge.js') | null | undefined;

/**
 * Return the lazily-loaded memory-bridge module, or `null` if it (or its
 * native deps) can't be loaded. Result is memoized — a failed load caches
 * `null` so we don't retry the import on every call.
 */
export async function getBridge(): Promise<typeof import('./memory-bridge.js') | null> {
  if (_bridge === null) return null;
  if (_bridge) return _bridge;
  try {
    _bridge = await import('./memory-bridge.js');
    return _bridge;
  } catch {
    _bridge = null;
    return null;
  }
}

/**
 * True once the bridge module has been successfully loaded. Lets callers
 * (e.g. `getHNSWStatus`) report AgentDB-v3 availability without forcing a
 * load. Mirrors the pre-split `_bridge && _bridge !== null` check.
 */
export function isBridgeLoaded(): boolean {
  return !!_bridge;
}
