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
  { event: 'PostToolUse', pattern: 'record-task-created' },
  { event: 'PostToolUse', pattern: 'record-memory-searched' },
  { event: 'PostToolUse', pattern: 'check-task-transition' },
  { event: 'PostToolUse', pattern: 'record-learnings-stored' },
  { event: 'PostToolUse', pattern: 'check-bash-memory' },
  { event: 'PostToolUse', pattern: 'record-test-run' },
  { event: 'PostToolUse', pattern: 'record-skill-run' },
  { event: 'PostToolUse', pattern: 'reset-edit-gates' },
  { event: 'UserPromptSubmit', pattern: 'prompt-reminder' },
];

/**
 * Map gate pattern → hook entry to add when missing from settings.json.
 * Gate commands use node with $CLAUDE_PROJECT_DIR helpers for portability.
 */
export const HOOK_ENTRY_MAP: Record<string, HookEntryMapping> = {
  'check-before-scan':       { event: 'PreToolUse',       matcher: '^(Glob|Grep)$',              hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-scan', timeout: 3000 } },
  'check-before-read':       { event: 'PreToolUse',       matcher: '^Read$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read', timeout: 3000 } },
  'check-dangerous-command':  { event: 'PreToolUse',       matcher: '^Bash$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-dangerous-command', timeout: 2000 } },
  'check-before-pr':          { event: 'PreToolUse',       matcher: '^Bash$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-pr', timeout: 2000 } },
  'record-task-created':      { event: 'PostToolUse',      matcher: '^TaskCreate$',               hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-task-created', timeout: 2000 } },
  // record-memory-searched MUST go through gate-hook.mjs (not gate.cjs directly)
  // — the wrapper forwards Claude Code's session_id as HOOK_SESSION_ID, which
  // markMemorySearched needs to stamp the per-actor map (#879).
  'record-memory-searched':   { event: 'PostToolUse',      matcher: 'mcp__moflo__memory_',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-memory-searched', timeout: 3000 } },
  'check-task-transition':    { event: 'PostToolUse',      matcher: '^TaskUpdate$',               hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-task-transition', timeout: 2000 } },
  'record-learnings-stored':  { event: 'PostToolUse',      matcher: '^mcp__moflo__memory_store$', hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-learnings-stored', timeout: 2000 } },
  'check-bash-memory':        { event: 'PostToolUse',      matcher: '^Bash$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-bash-memory', timeout: 2000 } },
  'record-test-run':          { event: 'PostToolUse',      matcher: '^Bash$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-test-run', timeout: 2000 } },
  'record-skill-run':         { event: 'PostToolUse',      matcher: '^Skill$',                    hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" record-skill-run', timeout: 2000 } },
  'reset-edit-gates':         { event: 'PostToolUse',      matcher: '^(Write|Edit|MultiEdit)$',   hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" reset-edit-gates', timeout: 2000 } },
  'prompt-reminder':          { event: 'UserPromptSubmit', matcher: '',                           hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" prompt-reminder', timeout: 3000 } },
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

  return { settings, rewrites };
}
