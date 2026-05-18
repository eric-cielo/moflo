/**
 * Settings.json hook-block drift detection (#881).
 *
 * Hashes the consumer's `.claude/settings.json` `hooks` block and the
 * reference hook block that `generateHooksConfig()` would produce for the
 * current moflo version.  When the hashes differ, the session-start launcher
 * surfaces the diff (or, in `regenerate` mode, adds purely-additive missing
 * hooks).  This is the broader complement to the per-bug `repairHookWiring`
 * and `rewriteIncorrectHookWiring` rules — it catches drift in any direction,
 * including future hook events we haven't shipped yet.
 *
 * IMPORTANT: This module must remain self-contained with ZERO imports from
 * other moflo modules (mirrors the constraint on `services/hook-wiring.ts`).
 * It is dynamically imported at runtime by `bin/session-start-launcher.mjs`
 * in consumer projects, where transitive dependencies may not resolve.
 *
 * The reference hook block is duplicated from `init/settings-generator.ts`
 * on purpose — the launcher cannot pull in `init/types.js` at runtime, and a
 * unit test (`hook-block-hash.test.ts`) asserts the two stay in sync.
 */
import { createHash } from 'crypto';

export interface HookEntry {
  type: string;
  command: string;
  timeout: number;
}

export interface HookBlock {
  matcher?: string;
  hooks: HookEntry[];
}

export type HooksTree = Record<string, HookBlock[]>;

export const DRIFT_MODES = ['warn', 'regenerate', 'off'] as const;
export type DriftMode = typeof DRIFT_MODES[number];

export interface HookDriftEntry {
  event: string;
  matcher: string;
  command: string;
}

export interface HookDriftReport {
  /** Stable hash of the consumer's normalised hook block. */
  consumerHash: string;
  /** Stable hash of the reference hook block for this moflo version. */
  referenceHash: string;
  /** True when the hashes differ. */
  drifted: boolean;
  /** Hook entries present in reference but missing from consumer. */
  missing: HookDriftEntry[];
  /** Hook entries present in consumer but absent from reference (likely user customisations). */
  extra: HookDriftEntry[];
}

export interface RegenerationResult {
  /** The (mutated) settings tree for convenience. */
  settings: Record<string, unknown>;
  /** Number of missing hook entries that were added back. */
  added: number;
  /** Number of extra hook entries that were removed (additive: always 0). */
  removed: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Reference hook block — kept in sync with init/settings-generator.ts
// ────────────────────────────────────────────────────────────────────────────

const HELPERS_PREFIX = '$CLAUDE_PROJECT_DIR/.claude/helpers';
const SCRIPTS_PREFIX = '$CLAUDE_PROJECT_DIR/.claude/scripts';

/** Build a `node "<helper> <subcommand>"` hook entry. */
const helperHook = (helper: string, sub: string, timeout: number): HookEntry => ({
  type: 'command',
  command: `node "${HELPERS_PREFIX}/${helper}"${sub ? ` ${sub}` : ''}`,
  timeout,
});

/** Build a `node "<scripts/file>"` hook entry (no subcommand). */
const scriptHook = (file: string, timeout: number): HookEntry => ({
  type: 'command',
  command: `node "${SCRIPTS_PREFIX}/${file}"`,
  timeout,
});

const gateHook = (sub: string, timeout: number) => helperHook('gate-hook.mjs', sub, timeout);
const gateCjs = (sub: string, timeout: number) => helperHook('gate.cjs', sub, timeout);
const handler = (sub: string, timeout: number) => helperHook('hook-handler.cjs', sub, timeout);
const autoMemory = (sub: string, timeout: number) => helperHook('auto-memory-hook.mjs', sub, timeout);

/**
 * Build the reference hook block — the canonical block `generateHooksConfig()`
 * produces with all hook flags enabled (the default for `flo init`).
 *
 * If you change `generateHooksConfig()` in `init/settings-generator.ts`, also
 * change this function — and the unit test `getReferenceHookBlock matches
 * generateHooksConfig` will fail until the two agree.
 */
export function getReferenceHookBlock(): HooksTree {
  return {
    PreToolUse: [
      { matcher: '^(Write|Edit|MultiEdit)$', hooks: [handler('post-edit', 5000)] },
      { matcher: '^(Glob|Grep)$',             hooks: [gateHook('check-before-scan', 3000)] },
      { matcher: '^Read$',                    hooks: [gateHook('check-before-read', 3000)] },
      {
        // #1171 — widened to cover `PowerShell` tool; without this PS-tool
        // calls bypass the dangerous/pr/memory gates on Windows.
        matcher: '^(Bash|PowerShell)$',
        hooks: [
          gateHook('check-dangerous-command', 2000),
          gateHook('check-before-pr', 2000),
          // #1132 — moved from PostToolUse so process.exit(2) actually blocks.
          gateHook('check-bash-memory', 2000),
        ],
      },
      // #931 — TaskCreate REMINDER + namespace hint advisory at Agent-spawn time.
      // Routed via gate-hook.mjs so HOOK_SESSION_ID is forwarded for per-actor
      // single-shot emission of the namespace hint.
      { matcher: '^Agent$',                   hooks: [gateHook('check-before-agent', 2000)] },
    ],
    PostToolUse: [
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [handler('post-edit', 5000), gateHook('reset-edit-gates', 2000)],
      },
      { matcher: '^Agent$',                       hooks: [handler('post-task', 5000)] },
      { matcher: '^TaskCreate$',                  hooks: [gateCjs('record-task-created', 2000)] },
      {
        // #1132 — check-bash-memory moved to PreToolUse (above).
        // #1171 — widened to cover `PowerShell` tool.
        matcher: '^(Bash|PowerShell)$',
        hooks: [gateHook('record-test-run', 2000)],
      },
      { matcher: '^Skill$',                       hooks: [gateHook('record-skill-run', 2000)] },
      { matcher: '^mcp__moflo__memory_(search|retrieve|list|stats|store)$', hooks: [gateHook('record-memory-searched', 3000)] },
      { matcher: '^TaskUpdate$',                  hooks: [gateCjs('check-task-transition', 2000)] },
      { matcher: '^mcp__moflo__memory_store$',    hooks: [gateCjs('record-learnings-stored', 2000)] },
      // #952 — wired so /fl -s/--swarm and /fl -h/--hive runs satisfy the
      // check-before-agent gate after the protected MCP init has been called.
      { matcher: '^mcp__moflo__swarm_init$',      hooks: [gateCjs('record-swarm-init', 2000)] },
      { matcher: '^mcp__moflo__hive-mind_init$',  hooks: [gateCjs('record-hive-init', 2000)] },
    ],
    UserPromptSubmit: [
      { hooks: [helperHook('prompt-hook.mjs', '', 3000)] },
      // #931 — Defensive safety-net hook. State reset only, no emission.
      { hooks: [gateHook('prompt-state-reset', 3000)] },
    ],
    SubagentStart: [
      { hooks: [helperHook('subagent-start.cjs', '', 2000)] },
    ],
    SessionStart: [
      {
        hooks: [scriptHook('session-start-launcher.mjs', 5000), autoMemory('import', 8000)],
      },
    ],
    Stop: [
      { hooks: [handler('session-end', 5000), autoMemory('sync', 10000)] },
    ],
    PreCompact: [
      { hooks: [gateCjs('compact-guidance', 3000)] },
    ],
    Notification: [
      { hooks: [handler('notification', 3000)] },
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Normalisation + hashing
// ────────────────────────────────────────────────────────────────────────────

function normaliseHookEntry(raw: unknown): HookEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== 'string') return null;
  return {
    type: typeof r.type === 'string' ? r.type : 'command',
    command: r.command.replace(/\s+/g, ' ').trim(),
    timeout: typeof r.timeout === 'number' && isFinite(r.timeout) ? r.timeout : 0,
  };
}

function normaliseHookBlock(raw: unknown): HookBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const hooksIn = Array.isArray(r.hooks) ? r.hooks : [];
  const hooks = hooksIn.map(normaliseHookEntry).filter((h): h is HookEntry => h !== null);
  if (hooks.length === 0) return null;
  hooks.sort((a, b) => a.command.localeCompare(b.command));
  const out: HookBlock = { hooks };
  if (typeof r.matcher === 'string' && r.matcher.length > 0) out.matcher = r.matcher;
  return out;
}

/**
 * Produce a stable, sorted view of a hook tree suitable for hashing or diffing.
 * Drops unknown keys, coerces missing fields to defaults, and sorts events,
 * matchers, and commands so semantically-equal trees compare equal.
 */
export function normaliseHooks(raw: unknown): HooksTree {
  if (!raw || typeof raw !== 'object') return {};
  const events = raw as Record<string, unknown>;
  const out: HooksTree = {};
  const eventNames = Object.keys(events).sort();
  for (const event of eventNames) {
    const arr = events[event];
    if (!Array.isArray(arr)) continue;
    const blocks = arr
      .map(normaliseHookBlock)
      .filter((b): b is HookBlock => b !== null);
    if (blocks.length === 0) continue;
    blocks.sort((a, b) => {
      const am = a.matcher ?? '';
      const bm = b.matcher ?? '';
      if (am !== bm) return am.localeCompare(bm);
      return (a.hooks[0]?.command ?? '').localeCompare(b.hooks[0]?.command ?? '');
    });
    out[event] = blocks;
  }
  return out;
}

function hashNormalised(tree: HooksTree): string {
  return createHash('sha256').update(JSON.stringify(tree)).digest('hex').slice(0, 16);
}

/**
 * Hash a hook tree.  Stable across runs (deterministic normalisation), and
 * insensitive to key order, whitespace inside commands, or matcher block
 * grouping.  Returns a 16-char hex prefix of sha256 — long enough to make
 * collisions a non-concern for the small space of valid hook trees while
 * staying readable in launcher output.
 */
export function computeHookBlockHash(raw: unknown): string {
  return hashNormalised(normaliseHooks(raw));
}

// ────────────────────────────────────────────────────────────────────────────
// Diff
// ────────────────────────────────────────────────────────────────────────────

function entryKey(event: string, matcher: string, command: string): string {
  return `${event} ${matcher} ${command}`;
}

function flatten(tree: HooksTree): Map<string, HookDriftEntry> {
  const out = new Map<string, HookDriftEntry>();
  for (const event of Object.keys(tree)) {
    for (const block of tree[event]) {
      const matcher = block.matcher ?? '';
      for (const hook of block.hooks) {
        const entry: HookDriftEntry = { event, matcher, command: hook.command };
        out.set(entryKey(event, matcher, hook.command), entry);
      }
    }
  }
  return out;
}

interface ReferenceCache {
  tree: HooksTree;
  normalised: HooksTree;
  hash: string;
  flat: Map<string, HookDriftEntry>;
}

let cachedReference: ReferenceCache | null = null;
function getCachedReference(): ReferenceCache {
  if (!cachedReference) {
    const tree = getReferenceHookBlock();
    const normalised = normaliseHooks(tree);
    cachedReference = { tree, normalised, hash: hashNormalised(normalised), flat: flatten(normalised) };
  }
  return cachedReference;
}

/**
 * Compare a consumer hook block against the reference and report what's
 * missing / extra.  Pass an explicit `referenceHooks` to test against a
 * frozen reference (used by tests); omit it to use the current moflo
 * reference from `getReferenceHookBlock()` (memoised — built once per process).
 */
export function computeHookBlockDrift(
  consumerHooks: unknown,
  referenceHooks?: unknown,
): HookDriftReport {
  const consumerNormalised = normaliseHooks(consumerHooks);
  const consumerHash = hashNormalised(consumerNormalised);
  const consumerFlat = flatten(consumerNormalised);

  let referenceHash: string;
  let referenceFlat: Map<string, HookDriftEntry>;
  if (referenceHooks === undefined) {
    const ref = getCachedReference();
    referenceHash = ref.hash;
    referenceFlat = ref.flat;
  } else {
    const refNormalised = normaliseHooks(referenceHooks);
    referenceHash = hashNormalised(refNormalised);
    referenceFlat = flatten(refNormalised);
  }

  const missing: HookDriftEntry[] = [];
  for (const [k, v] of referenceFlat) {
    if (!consumerFlat.has(k)) missing.push(v);
  }
  const extra: HookDriftEntry[] = [];
  for (const [k, v] of consumerFlat) {
    if (!referenceFlat.has(k)) extra.push(v);
  }

  return {
    consumerHash,
    referenceHash,
    drifted: consumerHash !== referenceHash,
    missing,
    extra,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Settings.json helpers — shared between launcher + doctor
// ────────────────────────────────────────────────────────────────────────────

/**
 * True when the user has set `claudeFlow.hooks.locked: true` in their
 * settings.json — a sentinel that suppresses drift surfacing entirely.
 */
export function isHookBlockLocked(settings: unknown): boolean {
  const root = settings as Record<string, unknown> | null | undefined;
  const cf = root?.claudeFlow as Record<string, unknown> | undefined;
  const hooks = cf?.hooks as Record<string, unknown> | undefined;
  return hooks?.locked === true;
}

/**
 * Additively repair drift: for every entry in `report.missing`, locate the
 * corresponding hook in the reference block and graft it into the consumer's
 * settings.  Only safe when `report.extra.length === 0` — otherwise the
 * caller should fall back to `warn` mode to avoid clobbering customisations.
 *
 * Mutates `settings` in place; caller is responsible for writing the file.
 */
export function applyAdditiveRegeneration(
  settings: Record<string, unknown>,
  report: HookDriftReport,
): RegenerationResult {
  if (report.missing.length === 0) return { settings, added: 0, removed: 0 };
  const ref = getCachedReference().tree;
  const hooks = (settings.hooks ?? {}) as Record<string, HookBlock[]>;
  let added = 0;

  for (const miss of report.missing) {
    const arr = Array.isArray(hooks[miss.event]) ? hooks[miss.event] : [];
    let block = arr.find(b => (b?.matcher ?? '') === miss.matcher);
    if (!block) {
      block = { hooks: [] };
      if (miss.matcher) block.matcher = miss.matcher;
      arr.push(block);
    }
    if (!Array.isArray(block.hooks)) block.hooks = [];

    const refArr = ref[miss.event] ?? [];
    const refBlock = refArr.find(b => (b?.matcher ?? '') === miss.matcher);
    const refHook = refBlock?.hooks.find(h => h.command === miss.command);
    if (refHook && !block.hooks.some(h => h?.command === miss.command)) {
      block.hooks.push(refHook);
      added++;
    }
    hooks[miss.event] = arr;
  }

  if (added > 0) settings.hooks = hooks;
  return { settings, added, removed: 0 };
}

/**
 * Set of helper-script basenames that moflo ships under `.claude/helpers/` and
 * `.claude/scripts/`. Built once from `getReferenceHookBlock()` so it always
 * tracks whatever the current reference block actually emits. Used by the
 * wholesale-regen path to tell "stale moflo entry from a removed reference
 * shape" (drop) apart from "consumer customisation we never owned" (preserve).
 */
let MOFLO_HELPER_BASENAMES_CACHE: Set<string> | null = null;
function getMofloHelperBasenames(): Set<string> {
  if (MOFLO_HELPER_BASENAMES_CACHE) return MOFLO_HELPER_BASENAMES_CACHE;
  const out = new Set<string>();
  const tree = getReferenceHookBlock();
  for (const event of Object.keys(tree)) {
    for (const block of tree[event]) {
      for (const hook of block.hooks) {
        const m = hook.command.match(/\.claude\/(?:helpers|scripts)\/([\w.\-]+)/);
        if (m) out.add(m[1]);
      }
    }
  }
  MOFLO_HELPER_BASENAMES_CACHE = out;
  return out;
}

/** True when a hook command references a moflo-shipped helper basename. */
function isMofloOwnedHookEntry(command: string): boolean {
  const m = command.match(/\.claude\/(?:helpers|scripts)\/([\w.\-]+)/);
  return m ? getMofloHelperBasenames().has(m[1]) : false;
}

/**
 * Wholesale regeneration: replace `settings.hooks` with the canonical reference
 * block, then graft consumer customisations back in. Drops stale moflo entries
 * (e.g. the `gate.cjs session-reset` SessionStart hook removed in #842) AND
 * adds missing entries — the additive variant only does the latter.
 *
 * #1180 — `report.extra` carries both stale moflo entries AND consumer-owned
 * customisations (e.g. waxstak's `project-analysis-gate.cjs`). The wholesale
 * path used to drop both; it now distinguishes them via the helper-basename
 * discriminator: any extra command referencing a moflo-shipped helper under
 * `.claude/helpers/` or `.claude/scripts/` is stale moflo and gets dropped;
 * anything else is consumer-owned and gets grafted back into the fresh tree
 * under the same `(event, matcher)`, with its original `HookEntry`
 * (type/timeout) snapshotted before the replace.
 *
 * The caller MUST check `isHookBlockLocked(settings)` first; if locked, the
 * user has opted out and this function should not be called. Non-hooks fields
 * on `settings` (permissions, env, claudeFlow.*, etc.) are preserved.
 *
 * Mutates `settings` in place; caller is responsible for writing the file.
 */
export function applyWholesaleRegeneration(
  settings: Record<string, unknown>,
  report: HookDriftReport,
): RegenerationResult {
  if (!report.drifted) return { settings, added: 0, removed: 0 };

  // Snapshot full `HookEntry` objects for consumer customisations BEFORE we
  // overwrite settings.hooks — the drift report carries command strings only,
  // not timeout/type. Walk the consumer's existing tree, match against each
  // non-moflo `extra` on (event, matcher, command).
  const customisations: Array<{ event: string; matcher: string; hook: HookEntry }> = [];
  const consumerHooks = (settings.hooks ?? {}) as Record<string, HookBlock[]>;
  for (const extra of report.extra) {
    if (isMofloOwnedHookEntry(extra.command)) continue;
    const evtArr = consumerHooks[extra.event];
    if (!Array.isArray(evtArr)) continue;
    for (const block of evtArr) {
      if ((block?.matcher ?? '') !== extra.matcher) continue;
      const found = Array.isArray(block.hooks)
        ? block.hooks.find((h: HookEntry | undefined) => h?.command === extra.command)
        : undefined;
      if (found) {
        customisations.push({ event: extra.event, matcher: extra.matcher, hook: found });
        break;
      }
    }
  }

  // Clone the cached reference so a later mutation of settings.hooks (by the
  // launcher's settings.json migrations, doctor --fix, etc.) cannot corrupt
  // the cached tree shared across `computeHookBlockDrift` calls in this process.
  const fresh = structuredClone(getCachedReference().tree);

  // Graft customisations into the fresh tree, slotting them under the same
  // matcher block (created if absent).
  for (const { event, matcher, hook } of customisations) {
    let arr = fresh[event];
    if (!Array.isArray(arr)) {
      arr = [];
      fresh[event] = arr;
    }
    let block = arr.find(b => (b?.matcher ?? '') === matcher);
    if (!block) {
      block = { hooks: [] };
      if (matcher) block.matcher = matcher;
      arr.push(block);
    }
    if (!Array.isArray(block.hooks)) block.hooks = [];
    if (!block.hooks.some((h: HookEntry) => h?.command === hook.command)) {
      block.hooks.push(hook);
    }
  }

  settings.hooks = fresh;
  const removed = report.extra.length - customisations.length;
  return { settings, added: report.missing.length, removed };
}

/**
 * Format a drift report for human-readable output (multi-line, no colour).
 * Used by `flo doctor` and the session-start launcher's stdout summary.
 */
export function formatDriftReport(report: HookDriftReport): string {
  if (!report.drifted) {
    return `hook block matches reference (${report.consumerHash})`;
  }
  const lines: string[] = [];
  lines.push(
    `hook block drift detected (consumer ${report.consumerHash} vs reference ${report.referenceHash})`,
  );
  if (report.missing.length > 0) {
    lines.push(`  ${report.missing.length} missing:`);
    for (const m of report.missing) {
      const m2 = m.matcher ? ` ${m.matcher}` : '';
      lines.push(`    - ${m.event}${m2}: ${m.command}`);
    }
  }
  if (report.extra.length > 0) {
    lines.push(`  ${report.extra.length} extra (likely customisations):`);
    for (const e of report.extra) {
      const m2 = e.matcher ? ` ${e.matcher}` : '';
      lines.push(`    + ${e.event}${m2}: ${e.command}`);
    }
  }
  return lines.join('\n');
}
