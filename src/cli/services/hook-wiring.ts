/**
 * Shared hook wiring repair logic.
 *
 * Used by `doctor --fix`, `mergeSettingsForUpgrade()`, and
 * `session-start-launcher.mjs` so that all three paths stay DRY.
 *
 * IMPORTANT: This module must remain self-contained with ZERO imports
 * from other moflo modules. It is dynamically imported at runtime by
 * session-start-launcher.mjs in consumer projects, where transitive
 * dependencies (project-root.js, etc.) may not resolve.
 */

interface HookEntry {
  type: string;
  command: string;
  timeout: number;
}

interface HookEntryMapping {
  event: string;
  matcher: string;
  hook: HookEntry;
}

/**
 * Required hook matchers that must exist in settings.json for gate enforcement.
 * This is the single source of truth — doctor-checks-deep re-exports it.
 */
export const REQUIRED_HOOK_WIRING: ReadonlyArray<{ event: string; pattern: string }> = [
  { event: 'PreToolUse', pattern: 'check-before-scan' },
  { event: 'PreToolUse', pattern: 'check-before-read' },
  { event: 'PreToolUse', pattern: 'check-dangerous-command' },
  { event: 'PreToolUse', pattern: 'check-before-pr' },
  // Story #1274 (Epic #1269) — verify-before-done gate on `gh pr create`. Wired
  // for every consumer so opting in via `gates: verify_before_done: true` takes
  // effect without a re-init; inert (breaks immediately) while the toggle is off.
  { event: 'PreToolUse', pattern: 'check-before-done' },
  // #931 — TaskCreate REMINDER + namespace hint emit only at Agent spawn now,
  // not on every prompt. Saves ~90 tokens × every prompt × every consumer.
  { event: 'PreToolUse', pattern: 'check-before-agent' },
  { event: 'PostToolUse', pattern: 'record-task-created' },
  { event: 'PostToolUse', pattern: 'record-memory-searched' },
  { event: 'PostToolUse', pattern: 'check-task-transition' },
  { event: 'PostToolUse', pattern: 'record-learnings-stored' },
  { event: 'PostToolUse', pattern: 'check-bash-memory' },
  { event: 'PostToolUse', pattern: 'record-test-run' },
  { event: 'PostToolUse', pattern: 'record-skill-run' },
  // Story #1274 — record the native /verify skill run so check-before-done is satisfied.
  { event: 'PostToolUse', pattern: 'record-verify-run' },
  { event: 'PostToolUse', pattern: 'reset-edit-gates' },
  // First UserPromptSubmit hook (prompt-hook.mjs internally calls
  // `gate.cjs prompt-reminder`). Substring check tolerates either the
  // shipped helper-script command or an inlined gate call.
  { event: 'UserPromptSubmit', pattern: 'prompt-hook.mjs' },
  // Second (defensive) UserPromptSubmit hook — state reset only. Replaced
  // the duplicate `prompt-reminder` wiring that was emitting the TaskCreate
  // REMINDER twice per prompt (#931).
  { event: 'UserPromptSubmit', pattern: 'prompt-state-reset' },
  // #1185 — passive session-continuity capture on the Stop hook. Self-heals
  // into existing consumers on upgrade so the feature reaches everyone, not
  // just fresh `flo init`. Capture is default-on (silent); injection is
  // relevance-gated at session-start.
  { event: 'Stop', pattern: 'session-continuity.mjs' },
  // #1198 — auto-meditate capture (default-ON; opt out via
  // auto_meditate.enabled: false). `meditate-detect` (UserPromptSubmit) injects the
  // answer-first directive on a strong signal; `meditate-scrape` (Stop) harvests
  // <meditate-capture> tags into the ledger. Both share meditate-capture.mjs, so
  // the unique subcommand token (not the shared filename) is the presence
  // discriminator — same convention as gate-hook subcommands like record-test-run.
  { event: 'UserPromptSubmit', pattern: 'meditate-detect' },
  { event: 'Stop', pattern: 'meditate-scrape' },
];

/**
 * Map gate pattern → hook entry to add when missing from settings.json.
 * Gate commands use node with $CLAUDE_PROJECT_DIR helpers for portability.
 */
export const HOOK_ENTRY_MAP: Record<string, HookEntryMapping> = {
  'check-before-scan':       { event: 'PreToolUse',       matcher: '^(Glob|Grep)$',              hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-scan', timeout: 3000 } },
  'check-before-read':       { event: 'PreToolUse',       matcher: '^Read$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 } },
  // #1171 — matchers widened to cover `PowerShell` tool; the gate logic was
  // always shell-agnostic but the matcher was Bash-anchored, leaving a bypass.
  'check-dangerous-command':  { event: 'PreToolUse',       matcher: '^(Bash|PowerShell)$',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-dangerous-command', timeout: 2000 } },
  'check-before-pr':          { event: 'PreToolUse',       matcher: '^(Bash|PowerShell)$',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-pr', timeout: 2000 } },
  // Story #1274 — verify-before-done. Same matcher as check-before-pr (both gate `gh pr create`).
  'check-before-done':        { event: 'PreToolUse',       matcher: '^(Bash|PowerShell)$',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-done', timeout: 2000 } },
  'record-task-created':      { event: 'PostToolUse',      matcher: '^TaskCreate$',               hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-task-created', timeout: 2000 } },
  // record-memory-searched MUST go through gate-hook.mjs (not gate.cjs directly)
  // — the wrapper forwards Claude Code's session_id as HOOK_SESSION_ID, which
  // markMemorySearched needs to stamp the per-actor map (#879).
  // Matcher MUST be a fully-anchored regex: Claude Code anchors hook matchers
  // (`^...$` semantics), so a bare `mcp__moflo__memory_` never fires for any
  // tool name (#929 regression — the hook silently no-ops, leaving every
  // memory_search uncounted by the gate).
  'record-memory-searched':   { event: 'PostToolUse',      matcher: '^mcp__moflo__memory_(search|retrieve|list|stats|store)$', hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-memory-searched', timeout: 3000 } },
  'check-task-transition':    { event: 'PostToolUse',      matcher: '^TaskUpdate$',               hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-task-transition', timeout: 2000 } },
  'record-learnings-stored':  { event: 'PostToolUse',      matcher: '^mcp__moflo__memory_store$', hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-learnings-stored', timeout: 2000 } },
  // #1171 — widened to ^(Bash|PowerShell)$ so PS reads / PS-invoked tests credit
  // the same gates as Bash. Name kept as `check-bash-memory` for backwards compat.
  'check-bash-memory':        { event: 'PostToolUse',      matcher: '^(Bash|PowerShell)$',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-bash-memory', timeout: 2000 } },
  'record-test-run':          { event: 'PostToolUse',      matcher: '^(Bash|PowerShell)$',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-test-run', timeout: 2000 } },
  'record-skill-run':         { event: 'PostToolUse',      matcher: '^Skill$',                    hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-skill-run', timeout: 2000 } },
  // Story #1274 — record the native /verify skill run (same ^Skill$ matcher as record-skill-run).
  'record-verify-run':        { event: 'PostToolUse',      matcher: '^Skill$',                    hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-verify-run', timeout: 2000 } },
  'reset-edit-gates':         { event: 'PostToolUse',      matcher: '^(Write|Edit|MultiEdit)$',   hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" reset-edit-gates', timeout: 2000 } },
  // #931 — Agent-time advisory; never blocks. Pulled the TaskCreate REMINDER
  // and namespace hint out of prompt-reminder so they fire only when Claude is
  // actually about to spawn an Agent. Routed via gate-hook.mjs so Claude Code's
  // session_id is forwarded as HOOK_SESSION_ID — the namespace hint emission
  // is per-actor single-shot (mirror of #879's record-memory-searched fix).
  'check-before-agent':       { event: 'PreToolUse',       matcher: '^Agent$',                    hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-agent', timeout: 2000 } },
  // Re-add the prompt-hook.mjs wiring as its own bare UserPromptSubmit block
  // when missing. Empty matcher = bare block, like settings-generator emits.
  'prompt-hook.mjs':          { event: 'UserPromptSubmit', matcher: '',                           hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/prompt-hook.mjs"', timeout: 3000 } },
  // Defensive safety-net — runs gate.cjs `prompt-state-reset` if prompt-hook.mjs
  // throws before completing the per-prompt state reset. State-only, no emission.
  'prompt-state-reset':       { event: 'UserPromptSubmit', matcher: '',                           hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" prompt-state-reset', timeout: 3000 } },
  // #1185 — passive session-continuity capture (Stop hook). Bare block (no
  // matcher), like the UserPromptSubmit entries; Claude Code fires every Stop
  // block, so a separate block alongside session-end/sync is fine.
  'session-continuity.mjs':   { event: 'Stop',             matcher: '',                           hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/session-continuity.mjs" capture', timeout: 5000 } },
  // #1198 — auto-meditate capture. Default-ON (the script no-ops only when
  // auto_meditate.enabled is false). Bare blocks (no matcher), like the other
  // UserPromptSubmit/Stop entries.
  'meditate-detect':          { event: 'UserPromptSubmit', matcher: '',                           hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/meditate-capture.mjs" meditate-detect', timeout: 3000 } },
  'meditate-scrape':          { event: 'Stop',             matcher: '',                           hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/meditate-capture.mjs" meditate-scrape', timeout: 5000 } },
};

export interface RepairResult {
  /** The patched settings object (mutated in place and returned for convenience) */
  settings: Record<string, unknown>;
  /** List of gate pattern names that were added */
  repaired: string[];
}

/**
 * Inspect a parsed settings.json object for missing required hook wirings
 * and patch them in.  Pure logic — no file I/O.
 *
 * @returns The (potentially mutated) settings and a list of repaired pattern names.
 */
export function repairHookWiring(settings: Record<string, unknown>): RepairResult {
  const raw = JSON.stringify(settings);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  const missingPatterns = REQUIRED_HOOK_WIRING.filter(h => !raw.includes(h.pattern));
  if (missingPatterns.length === 0) return { settings, repaired: [] };

  const repaired: string[] = [];

  for (const { pattern } of missingPatterns) {
    const entry = HOOK_ENTRY_MAP[pattern];
    if (!entry) continue;

    const eventArray = (hooks[entry.event] ?? []) as Array<Record<string, unknown>>;

    // If the matcher already has an entry, append the hook; otherwise add a new matcher block
    const existing = eventArray.find(
      (block) => block.matcher === entry.matcher,
    ) as Record<string, unknown> | undefined;

    if (existing) {
      const blockHooks = (existing.hooks ?? []) as unknown[];
      blockHooks.push(entry.hook);
      existing.hooks = blockHooks;
    } else {
      const newBlock: Record<string, unknown> = { hooks: [entry.hook] };
      if (entry.matcher) newBlock.matcher = entry.matcher;
      eventArray.push(newBlock);
    }

    hooks[entry.event] = eventArray;
    repaired.push(pattern);
  }

  settings.hooks = hooks;
  return { settings, repaired };
}

// ────────────────────────────────────────────────────────────────────────────
// Rewrite rules — fix existing-but-wrong hook commands.
//
// `repairHookWiring` only ADDS missing wirings; it can't fix wirings that
// exist but were generated by an older moflo with the wrong helper script.
// The session-start launcher applies these rewrites on every start so existing
// consumers auto-heal without re-running `flo init`. Each rewrite is a literal
// string substitution within hook command lines — idempotent by design (a
// command already at `to` won't match `from`). Cross-platform: commands always
// use forward slashes and `$CLAUDE_PROJECT_DIR`, which Claude Code expands on
// every OS.
// ────────────────────────────────────────────────────────────────────────────

export interface HookRewriteRule {
  /** Diagnostic name surfaced when the rewrite fires */
  name: string;
  /** Substring to search for in `hook.command` */
  from: string;
  /** Replacement command */
  to: string;
}

export const HOOK_REWRITE_RULES: ReadonlyArray<HookRewriteRule> = [
  // Issue #879 — record-memory-searched MUST use gate-hook.mjs so Claude Code's
  // session_id is forwarded as HOOK_SESSION_ID. Without it, the per-actor map
  // stays empty and the gate blocks every Read forever within a turn.
  {
    name: '#879: record-memory-searched → gate-hook.mjs',
    from: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-memory-searched',
    to:   'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-memory-searched',
  },
  // Symmetry hardening — same fix shape for check-bash-memory. The shipped
  // settings.json already wires this through gate-hook.mjs in current versions,
  // but a stale consumer settings.json may have it wrong.
  {
    name: '#879: check-bash-memory → gate-hook.mjs',
    from: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-bash-memory',
    to:   'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-bash-memory',
  },
  // Issue #931 — the second UserPromptSubmit hook used to invoke
  // gate-hook.mjs `prompt-reminder`, which (a) duplicated the first hook's
  // emission of `REMINDER: Use TaskCreate...` per prompt and (b) double-
  // incremented `interactionCount`. The first hook (prompt-hook.mjs) still
  // calls gate.cjs `prompt-reminder` internally for the full reset + Context
  // warnings; the safety-net hook now runs `prompt-state-reset` instead —
  // idempotent state reset, no emission, no increment.
  {
    name: '#931: dedupe UserPromptSubmit prompt-reminder → prompt-state-reset',
    from: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" prompt-reminder',
    to:   'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" prompt-state-reset',
  },
  // Issue #931 — `check-before-agent` was first wired through gate.cjs
  // directly (no stdin parsing). Without HOOK_SESSION_ID the namespace hint's
  // per-actor tracking falls back to a single `_legacy_` bucket, so a
  // subagent spawning its own agent would silently miss the hint after the
  // parent already consumed it. Route through gate-hook.mjs (the same wrapper
  // that fixed #879) so each session_id gets its own single-shot.
  {
    name: '#931: route check-before-agent → gate-hook.mjs (forwards HOOK_SESSION_ID)',
    from: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-before-agent',
    to:   'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-agent',
  },
  // Auto-meditate rebrand — the auto-reflect capture script + subcommands were
  // renamed (reflect-capture.mjs → meditate-capture.mjs; reflect-detect/scrape →
  // meditate-detect/scrape). Existing consumers self-heal here: the stale hook
  // command is rewritten in place on session-start, so no dead hook is left
  // pointing at the pruned reflect-capture.mjs. Idempotent (a command already at
  // `to` won't match `from`).
  {
    name: 'auto-meditate rebrand: reflect-capture detect → meditate-capture detect',
    from: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/reflect-capture.mjs" reflect-detect',
    to:   'node "$CLAUDE_PROJECT_DIR/.claude/scripts/meditate-capture.mjs" meditate-detect',
  },
  {
    name: 'auto-meditate rebrand: reflect-capture scrape → meditate-capture scrape',
    from: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/reflect-capture.mjs" reflect-scrape',
    to:   'node "$CLAUDE_PROJECT_DIR/.claude/scripts/meditate-capture.mjs" meditate-scrape',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Matcher rewrite rules — fix existing-but-wrong block-level `matcher` strings.
//
// HOOK_REWRITE_RULES rewrites hook command substrings; this rewrites the
// outer block matcher itself. Each rule fires only when a block has the exact
// `from` matcher AND contains a hook command matching `cmdContains` — that
// guard prevents an accidental rewrite of an unrelated user-customised block
// that happens to share the matcher string.
// ────────────────────────────────────────────────────────────────────────────

export interface MatcherRewriteRule {
  /** Diagnostic name surfaced when the rewrite fires */
  name: string;
  /** Exact matcher string to find on `block.matcher` */
  from: string;
  /** Replacement matcher string */
  to: string;
  /** Hook command must contain this substring for the rewrite to fire — guards
   *  against rewriting an unrelated user-customised block. */
  cmdContains: string;
}

export const MATCHER_REWRITE_RULES: ReadonlyArray<MatcherRewriteRule> = [
  // Issue #929 — Claude Code anchors hook matchers (`^…$` semantics), so a
  // bare `mcp__moflo__memory_` never matches any real MCP tool name and the
  // record-memory-searched stamp silently no-ops on every memory_search.
  // The fix is anchored alternation. Existing consumers that upgrade through
  // this version self-heal here without needing `flo doctor --fix`.
  {
    name: '#929: anchor record-memory-searched matcher',
    from: 'mcp__moflo__memory_',
    to: '^mcp__moflo__memory_(search|retrieve|list|stats|store)$',
    cmdContains: 'record-memory-searched',
  },
  // Issue #1171 — widen Bash-only matchers to cover the dedicated `PowerShell`
  // tool Claude Code exposes on Windows. The gate logic itself was already
  // shell-agnostic (gate.cjs READ_LIKE_BASH_RE matched `Get-Content`/`Select-String`/etc.)
  // but a Bash-anchored matcher meant PS-tool calls never reached the gate.
  // One rewrite per gate command keeps the `cmdContains` guard precise, so an
  // unrelated user-customised `^Bash$` block doesn't get widened.
  {
    name: '#1171: widen check-dangerous-command matcher to PowerShell',
    from: '^Bash$',
    to: '^(Bash|PowerShell)$',
    cmdContains: 'check-dangerous-command',
  },
  {
    name: '#1171: widen check-before-pr matcher to PowerShell',
    from: '^Bash$',
    to: '^(Bash|PowerShell)$',
    cmdContains: 'check-before-pr',
  },
  {
    name: '#1171: widen check-bash-memory matcher to PowerShell',
    from: '^Bash$',
    to: '^(Bash|PowerShell)$',
    cmdContains: 'check-bash-memory',
  },
  {
    name: '#1171: widen record-test-run matcher to PowerShell',
    from: '^Bash$',
    to: '^(Bash|PowerShell)$',
    cmdContains: 'record-test-run',
  },
];

export interface RewriteResult {
  /** The (mutated) settings */
  settings: Record<string, unknown>;
  /** Rule names that fired, with command counts */
  rewrites: Array<{ name: string; count: number }>;
}

/**
 * Apply HOOK_REWRITE_RULES to every hook command in `settings.hooks.*`.
 * Idempotent: a hook already at the `to` form won't match `from`.
 *
 * @returns The (potentially mutated) settings and a list of rewrites that fired.
 */
export function rewriteIncorrectHookWiring(
  settings: Record<string, unknown>,
): RewriteResult {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const rewrites: Array<{ name: string; count: number }> = [];

  for (const rule of HOOK_REWRITE_RULES) {
    let count = 0;
    for (const eventName of Object.keys(hooks)) {
      const eventArray = hooks[eventName];
      if (!Array.isArray(eventArray)) continue;
      for (const block of eventArray as Array<Record<string, unknown>>) {
        const blockHooks = block.hooks;
        if (!Array.isArray(blockHooks)) continue;
        for (const h of blockHooks as Array<Record<string, unknown>>) {
          if (typeof h.command === 'string' && h.command.includes(rule.from)) {
            h.command = (h.command as string).split(rule.from).join(rule.to);
            count++;
          }
        }
      }
    }
    if (count > 0) rewrites.push({ name: rule.name, count });
  }

  for (const rule of MATCHER_REWRITE_RULES) {
    let count = 0;
    for (const eventName of Object.keys(hooks)) {
      const eventArray = hooks[eventName];
      if (!Array.isArray(eventArray)) continue;
      for (const block of eventArray as Array<Record<string, unknown>>) {
        if (block.matcher !== rule.from) continue;
        const blockHooks = block.hooks;
        if (!Array.isArray(blockHooks)) continue;
        const hasMatchingCmd = (blockHooks as Array<Record<string, unknown>>).some(
          (h) => typeof h.command === 'string' && h.command.includes(rule.cmdContains),
        );
        if (!hasMatchingCmd) continue;
        block.matcher = rule.to;
        count++;
      }
    }
    if (count > 0) rewrites.push({ name: rule.name, count });
  }

  return { settings, rewrites };
}
