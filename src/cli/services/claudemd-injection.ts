/**
 * CLAUDE.md injection drift detection + replacement (#1142).
 *
 * Detects when a consumer's `<root>/CLAUDE.md` carries a MoFlo-injected block
 * whose content has drifted from what the current generator produces. Catches
 * the case where a consumer upgrades moflo (so guidance files refresh) but the
 * CLAUDE.md injection — only rewritten by explicit `flo init` / `flo-setup` —
 * stays frozen at the prior version's content, sometimes pointing at paths
 * that no longer exist (e.g. `.claude/guidance/shipped/...` before the
 * flat-layout cleanup).
 *
 * IMPORTANT: This module must remain self-contained with ZERO imports from
 * other moflo modules (mirrors the constraint on `services/hook-block-hash.ts`
 * and `services/hook-wiring.ts`). It is dynamically imported at runtime by
 * `bin/session-start-launcher.mjs` in consumer projects, where transitive
 * dependencies may not resolve.
 *
 * The MoFlo block markers are duplicated from `init/claudemd-generator.ts` on
 * purpose — the launcher cannot pull in TS dist of init/types.js at runtime,
 * and a unit test asserts the two stay in sync.
 */

// ────────────────────────────────────────────────────────────────────────────
// Marker constants — kept in sync with init/claudemd-generator.ts
// ────────────────────────────────────────────────────────────────────────────

export const MARKER_START = '<!-- MOFLO:INJECTED:START -->';
export const MARKER_END = '<!-- MOFLO:INJECTED:END -->';

// Legacy markers from earlier moflo versions — detected on drift checks so we
// can offer to replace the legacy block with the current marker pair.
export const LEGACY_MARKER_STARTS = [
  '<!-- MOFLO:START -->',
  '<!-- MOFLO:SUBAGENT-PROTOCOL:START -->',
] as const;
export const LEGACY_MARKER_ENDS = [
  '<!-- MOFLO:END -->',
  '<!-- MOFLO:SUBAGENT-PROTOCOL:END -->',
] as const;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type InjectionDriftState =
  | 'no-file'        // CLAUDE.md does not exist
  | 'no-marker'      // CLAUDE.md exists, no MoFlo marker pair found
  | 'legacy-marker'  // legacy MoFlo marker pair found (predates MOFLO:INJECTED:START)
  | 'in-sync'        // current marker pair, block content matches the canonical block
  | 'drifted';       // current marker pair, block content differs from canonical

export interface InjectionDriftReport {
  state: InjectionDriftState;
  /** Index of matched legacy-marker pair in LEGACY_MARKER_STARTS, when state === 'legacy-marker'. */
  legacyMarkerIndex?: number;
}

export interface InjectionReplacementResult {
  /** Updated CLAUDE.md contents (or null when state === 'no-file' and no canonical insertion is requested). */
  contents: string | null;
  /** True when `contents` differs from the input. */
  changed: boolean;
  /** Final drift state after applying replacement (always 'in-sync' on success). */
  state: InjectionDriftState;
}

// ────────────────────────────────────────────────────────────────────────────
// Block extraction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Locate the MoFlo-injected block in `claudeMdContents`.
 *
 * `start`/`end` are offsets into the **raw** `claudeMdContents` (not a
 * CRLF-normalised view), so callers can splice against the original bytes and
 * preserve line endings outside the marker block (#1281). The markers are
 * CR-free ASCII, so `indexOf` locates them at identical positions in the raw
 * and normalised views — but only the raw offsets are valid substring bounds
 * for the untouched original string.
 *
 * `block` IS CRLF-normalised, so a byte-for-byte compare against the LF
 * canonical block works even on a CRLF checkout (Windows consumers regularly
 * hit this — git autocrlf can flip the source bytes on checkout).
 *
 * Returns null when `contents` is null/undefined/empty, or when no marker
 * pair is found. `block` includes the marker strings themselves, matching
 * `MARKER_START…MARKER_END` exactly.
 */
export function extractInjectedBlock(claudeMdContents: string | null | undefined): {
  block: string;
  start: number;
  end: number;
  markerIndex: number;
} | null {
  if (!claudeMdContents) return null;

  // Try the current marker pair first, then each legacy pair. markerIndex:
  //   0  → current MARKER_START/MARKER_END
  //   1+ → LEGACY_MARKER_STARTS[markerIndex - 1] / LEGACY_MARKER_ENDS[markerIndex - 1]
  const starts: readonly string[] = [MARKER_START, ...LEGACY_MARKER_STARTS];
  const ends: readonly string[] = [MARKER_END, ...LEGACY_MARKER_ENDS];

  for (let i = 0; i < starts.length; i++) {
    // Search the RAW string: markers are CR-free, so this matches the
    // normalised view's positions, but yields offsets valid against the
    // original bytes for splicing.
    const startIdx = claudeMdContents.indexOf(starts[i]);
    if (startIdx < 0) continue;
    const endIdx = claudeMdContents.indexOf(ends[i], startIdx + starts[i].length);
    if (endIdx <= startIdx) continue;
    const endInclusive = endIdx + ends[i].length;
    return {
      // Normalise only the extracted block for drift comparison; start/end
      // remain raw-byte offsets.
      block: claudeMdContents.substring(startIdx, endInclusive).replace(/\r\n/g, '\n'),
      start: startIdx,
      end: endInclusive,
      markerIndex: i,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Drift detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Trim `canonical` to the bytes between (and including) the current MoFlo
 * markers. `generateClaudeMd()` appends a trailing newline that callers
 * commonly include in the result; the in-file block does not carry that
 * newline, so we strip trailing whitespace before comparing.
 */
function canonicalBlock(canonical: string): string {
  return canonical.replace(/\r\n/g, '\n').trimEnd();
}

/**
 * Classify a consumer's CLAUDE.md against the canonical injected block.
 *
 * `claudeMdContents` should be the result of `readFileSync(<root>/CLAUDE.md)`
 * or null/undefined when the file is absent. `canonical` is the output of
 * `generateClaudeMd({})` from `init/claudemd-generator.ts`.
 */
export function computeInjectionDrift(
  claudeMdContents: string | null | undefined,
  canonical: string,
): InjectionDriftReport {
  if (claudeMdContents === null || claudeMdContents === undefined) {
    return { state: 'no-file' };
  }
  const extracted = extractInjectedBlock(claudeMdContents);
  if (!extracted) {
    return { state: 'no-marker' };
  }
  if (extracted.markerIndex > 0) {
    return { state: 'legacy-marker', legacyMarkerIndex: extracted.markerIndex - 1 };
  }
  const currentBlock = extracted.block;
  const wantBlock = canonicalBlock(canonical);
  if (currentBlock === wantBlock) {
    return { state: 'in-sync' };
  }
  return { state: 'drifted' };
}

// ────────────────────────────────────────────────────────────────────────────
// Replacement
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply the canonical block to `claudeMdContents`, returning the new
 * contents and a `changed` flag indicating whether any bytes differ. The
 * caller writes the file (or persists in-memory state) — this function does
 * no I/O so it's safe to call from any execution context.
 *
 * Behavior by input state:
 *  - `no-file` → returns `{ contents: canonical, changed: true }` so the
 *    caller can write a fresh CLAUDE.md (e.g. `flo init` first-run).
 *  - `no-marker` → APPENDS the canonical block to the end of the existing
 *    contents (matches `bin/setup-project.mjs:updateClaudeMd` append path).
 *  - `legacy-marker` → REPLACES the legacy block in-place with the canonical block.
 *  - `in-sync` → no change.
 *  - `drifted` → REPLACES the existing block in-place with the canonical block.
 */
export function applyInjectionReplacement(
  claudeMdContents: string | null | undefined,
  canonical: string,
): InjectionReplacementResult {
  const want = canonicalBlock(canonical);

  if (claudeMdContents === null || claudeMdContents === undefined) {
    return { contents: `# Project Configuration\n\n${want}\n`, changed: true, state: 'in-sync' };
  }

  const extracted = extractInjectedBlock(claudeMdContents);
  if (!extracted) {
    // No marker — append the canonical block to the end (idempotent for
    // future runs because the appended block will then be located on
    // subsequent extractions).
    const sep = claudeMdContents.endsWith('\n') ? '\n' : '\n\n';
    const next = claudeMdContents + sep + want + '\n';
    return { contents: next, changed: true, state: 'in-sync' };
  }

  // We located a marker pair (current or legacy). If content already matches
  // the canonical block, nothing to do.
  if (extracted.markerIndex === 0 && extracted.block === want) {
    return { contents: claudeMdContents, changed: false, state: 'in-sync' };
  }

  // Splice against the ORIGINAL bytes (extracted.start/end are raw-byte
  // offsets), so line endings OUTSIDE the marker block are preserved — a CRLF
  // consumer's surrounding content keeps its CRLF (#1281). Only the canonical
  // block itself is (re)written with LF, matching what the generator emits.
  const next =
    claudeMdContents.substring(0, extracted.start) + want + claudeMdContents.substring(extracted.end);
  return { contents: next, changed: true, state: 'in-sync' };
}

// ────────────────────────────────────────────────────────────────────────────
// Human-readable status for healer + launcher output
// ────────────────────────────────────────────────────────────────────────────

/**
 * Short one-line summary describing a drift state. Used by `flo doctor` and
 * the session-start launcher when reporting status to the user.
 */
export function formatInjectionDriftStatus(report: InjectionDriftReport): string {
  switch (report.state) {
    case 'no-file':       return 'CLAUDE.md not found';
    case 'no-marker':     return 'CLAUDE.md has no moflo injection block';
    case 'legacy-marker': return 'CLAUDE.md uses a legacy moflo marker pair';
    case 'in-sync':       return 'CLAUDE.md injection block matches reference';
    case 'drifted':       return 'CLAUDE.md injection block has drifted from reference';
  }
}
