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
  'record-memory-searched':   { event: 'PostToolUse',      matcher: 'mcp__moflo__memory_',        hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-memory-searched', timeout: 3000 } },
  'check-task-transition':    { event: 'PostToolUse',      matcher: '^TaskUpdate$',               hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-task-transition', timeout: 2000 } },
  'record-learnings-stored':  { event: 'PostToolUse',      matcher: '^mcp__moflo__memory_store$', hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-learnings-stored', timeout: 2000 } },
  'check-bash-memory':        { event: 'PostToolUse',      matcher: '^Bash$',                     hook: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-bash-memory', timeout: 2000 } },
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
