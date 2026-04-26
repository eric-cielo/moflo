/**
 * Spell Gate Service
 * Enforces TaskCreate + memory-first patterns before agent spawning
 * and file exploration. Tracks context bracket by interaction count.
 *
 * Ported from Motailz .claude/scripts/spell-gate.mjs into MoFlo core.
 *
 * Gate types:
 *   check-before-agent     — blocks Agent tool if no TaskCreate or no memory search
 *   check-before-scan      — blocks Glob/Grep if no memory search (deduplicated)
 *   check-before-read      — blocks Read on .claude/guidance/ if no memory search
 *   record-task-created     — records TaskCreate usage
 *   check-bash-memory       — detects memory search in Bash commands
 *   record-memory-searched  — records MCP memory search
 *   prompt-reminder         — resets memory gate, increments interaction count
 *   session-reset           — resets all state
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from './atomic-file-write.js';
import { loadMofloConfig } from '../config/moflo-config.js';

// ============================================================================
// Types
// ============================================================================

export interface GateState {
  tasksCreated: boolean;
  taskCount: number;
  memorySearched: boolean;
  memoryRequired: boolean;
  interactionCount: number;
  sessionStart: string | null;
  lastBlockedAt: string | null;
}

export type ContextBracket = 'FRESH' | 'MODERATE' | 'DEPLETED' | 'CRITICAL';

export interface GateResult {
  allowed: boolean;
  message?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_STATE: GateState = {
  tasksCreated: false,
  taskCount: 0,
  memorySearched: false,
  memoryRequired: true,
  interactionCount: 0,
  sessionStart: null,
  lastBlockedAt: null,
};

/**
 * Patterns that indicate the prompt is a task requiring memory context.
 * These are checked case-insensitively against the user's prompt.
 */
const TASK_PATTERNS = [
  /\bfix\b/, /\bbug\b/, /\berror\b/, /\bfailing\b/, /\bbroken\b/, /\bcrash/,
  /\bimplement\b/, /\badd\b/, /\bcreate\b/, /\bbuild\b/, /\bwrite\b/,
  /\brefactor\b/, /\bmigrat/, /\bupgrade\b/, /\bupdate\b/,
  /\bdebug\b/, /\binvestigat/, /\bdiagnos/, /\btroubleshoot/,
  /\bwhy\s+(is|does|did|are|was|isn't|doesn't|won't)/, /\bhow\s+(do|does|did|can|should)/,
  /\btest\b/, /\bspec\b/,
  /\bfeature\b/, /\bstory\b/, /\bticket\b/, /\bissue\b/,
  /\bintegrat/, /\bconnect\b/, /\bsetup\b/, /\bconfigur/,
  /\boptimiz/, /\bperformance\b/, /\bslow\b/,
  /\bsecurity\b/, /\bvulnerab/, /\bauth\b/,
  /^\/flo\b/, /^\/fl\b/, /^\/cl\b/,  // Skill invocations always require memory
];

/**
 * Patterns that indicate the prompt is a simple directive (no memory needed).
 * Checked first — if matched, memory gate is skipped regardless of task patterns.
 */
const DIRECTIVE_PATTERNS = [
  // Confirmations and short answers
  /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect|thanks|thank you|got it|sounds good|go ahead|do it|lgtm)\b/i,
  // Git and package management
  /\b(commit|push|pull|merge|rebase|cherry-pick)\b/,
  /\bpublish\b/, /\bversion\b/, /\bnpm\b/, /\byarn\b/, /\bpnpm\b/,
  // File management directives
  /\b(rename|move|delete|remove)\b/,
  /^(show|read|open|cat|look at|check)\s/,
  /^(run|execute|start|stop|kill|restart)\s/,
  /^let'?s\s+(commit|push|publish|deploy|ship|merge)/i,
  // Short follow-ups that reference the current conversation (not new tasks)
  // These are anchored to start-of-string to avoid matching mid-sentence task words
  /^(do the same|same for|same thing)\b/i,
  /^(also|too|and also)\s+(for|with|on)\b/i,
  /^(what about|how about)\s+(the\s+)?(other|rest|same)\b/i,
];

const BRACKET_MESSAGES: Record<Exclude<ContextBracket, 'FRESH'>, string> = {
  MODERATE: 'Context: MODERATE. Re-state goal before architectural decisions. Use agents for >300 LOC.',
  DEPLETED: 'Context: DEPLETED. Checkpoint progress. Recommend /compact or fresh session.',
  CRITICAL: 'Context: CRITICAL. Stop accepting complex tasks. Commit, store learnings, suggest new session.',
};

/** Paths exempt from memory-first gate (they ARE the memory system) */
const EXEMPT_PATTERNS = [
  '.claude/',
  '.claude\\',
  'CLAUDE.md',
  'MEMORY.md',
  'workflow-state',
  'node_modules',
];

// ============================================================================
// Service
// ============================================================================

export class GateService {
  private stateFilePath: string;
  private config: { memory_first: boolean; task_create_first: boolean; context_tracking: boolean };

  constructor(projectRoot: string = process.cwd()) {
    this.stateFilePath = path.resolve(projectRoot, '.claude/workflow-state.json');
    const mofloConfig = loadMofloConfig(projectRoot);
    this.config = mofloConfig.gates;
  }

  // --------------------------------------------------------------------------
  // State management
  // --------------------------------------------------------------------------

  readState(): GateState {
    try {
      return JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
    } catch {
      // ENOENT or JSON corruption — return defaults
      return { ...DEFAULT_STATE };
    }
  }

  writeState(state: GateState): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      // Atomic write — concurrent gate hooks fire as separate node processes
      // and used to produce torn JSON when they raced on naked writeFileSync
      // (#629/#635). atomicWriteFileSync uses a process-unique temp path +
      // rename so the destination always reflects exactly one writer's data.
      atomicWriteFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal — last-writer-wins semantics; some updates may be lost
      // under contention but the file is never corrupted.
    }
  }

  // --------------------------------------------------------------------------
  // Context bracket
  // --------------------------------------------------------------------------

  getContextBracket(interactionCount: number): ContextBracket {
    if (interactionCount <= 10) return 'FRESH';
    if (interactionCount <= 20) return 'MODERATE';
    if (interactionCount <= 30) return 'DEPLETED';
    return 'CRITICAL';
  }

  // --------------------------------------------------------------------------
  // Gate checks
  // --------------------------------------------------------------------------

  /**
   * Check if Agent tool spawn is allowed.
   * Always advisory (never blocks). Memory-first enforcement happens at the
   * work layer — check-before-scan and check-before-read gates block the
   * agent's actual file access if memory hasn't been searched yet.
   * Blocking spawning itself causes cascading failures in nested agents.
   */
  checkBeforeAgent(): GateResult {
    if (!this.config.task_create_first && !this.config.memory_first) {
      return { allowed: true };
    }

    const state = this.readState();

    if (this.config.task_create_first && !state.tasksCreated) {
      return {
        allowed: true,
        message: 'REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.',
      };
    }

    if (this.config.memory_first && !state.memorySearched && state.memoryRequired) {
      return {
        allowed: true,
        message: 'REMINDER: Search memory (mcp__moflo__memory_search) before spawning agents.',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if Glob/Grep is allowed.
   * Blocks if memory is required AND not yet searched.
   * Warns (but allows) if memory is not required.
   */
  checkBeforeScan(pattern?: string, searchPath?: string): GateResult {
    if (!this.config.memory_first) {
      return { allowed: true };
    }

    const state = this.readState();

    if (state.memorySearched) {
      return { allowed: true };
    }

    // Exempt system paths
    const target = `${pattern || ''} ${searchPath || ''}`;
    if (EXEMPT_PATTERNS.some(p => target.includes(p))) {
      return { allowed: true };
    }

    // If memory is not required for this prompt, warn but allow
    if (!state.memoryRequired) {
      return { allowed: true };
    }

    // Memory IS required — block with deduplicated message
    const now = Date.now();
    const lastBlocked = state.lastBlockedAt ? new Date(state.lastBlockedAt).getTime() : 0;
    let message: string | undefined;

    if (now - lastBlocked > 2000) {
      state.lastBlockedAt = new Date(now).toISOString();
      this.writeState(state);
      message = 'BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search with namespace "code-map", "patterns", "knowledge", or "guidance".';
    }

    return { allowed: false, message };
  }

  /**
   * Check if Read on guidance files is allowed.
   * Only gates reads targeting .claude/guidance/ files.
   */
  checkBeforeRead(filePath?: string): GateResult {
    if (!this.config.memory_first) {
      return { allowed: true };
    }

    const state = this.readState();

    if (state.memorySearched) {
      return { allowed: true };
    }

    // Only gate guidance file reads
    if (!filePath?.includes('.claude/guidance/') && !filePath?.includes('.claude\\guidance\\')) {
      return { allowed: true };
    }

    // If memory is not required for this prompt, allow guidance reads
    if (!state.memoryRequired) {
      return { allowed: true };
    }

    // Deduplicate
    const now = Date.now();
    const lastBlocked = state.lastBlockedAt ? new Date(state.lastBlockedAt).getTime() : 0;
    let message: string | undefined;

    if (now - lastBlocked > 2000) {
      state.lastBlockedAt = new Date(now).toISOString();
      this.writeState(state);
      message = 'BLOCKED: Search memory before reading guidance files. Use mcp__moflo__memory_search with namespace "guidance".';
    }

    return { allowed: false, message };
  }

  // --------------------------------------------------------------------------
  // State recorders
  // --------------------------------------------------------------------------

  recordTaskCreated(): void {
    const state = this.readState();
    state.tasksCreated = true;
    state.taskCount = (state.taskCount || 0) + 1;
    this.writeState(state);
  }

  recordMemorySearched(): void {
    const state = this.readState();
    state.memorySearched = true;
    this.writeState(state);
  }

  /**
   * Check if a bash command contains a memory search.
   * If so, auto-record memory as searched.
   */
  checkBashMemory(command: string): void {
    if (/semantic-search|memory search|memory retrieve|memory-search/.test(command)) {
      this.recordMemorySearched();
    }
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  /**
   * Classify whether a user prompt requires memory search.
   * Directives (commit, rename, yes/no) don't need memory.
   * Tasks (fix, implement, debug, /flo) do.
   * Ambiguous prompts default to requiring memory.
   */
  classifyPrompt(prompt: string): boolean {
    const trimmed = prompt.trim();

    // Empty or very short prompts (single word confirmations) — no memory needed
    if (trimmed.length < 4) return false;

    // Check directive patterns first — these never need memory
    for (const pattern of DIRECTIVE_PATTERNS) {
      if (pattern.test(trimmed)) return false;
    }

    // Check task patterns — these always need memory
    for (const pattern of TASK_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }

    // Ambiguous: if the prompt is long (likely a task description), require memory
    // Short ambiguous prompts (follow-ups) don't need it
    return trimmed.length > 80;
  }

  /**
   * Called on each new user prompt.
   * Classifies prompt, resets memory gate, increments interaction count,
   * returns context bracket.
   */
  promptReminder(userPrompt?: string): { reminder?: string; bracket?: string } {
    const state = this.readState();
    state.memorySearched = false;
    state.memoryRequired = userPrompt ? this.classifyPrompt(userPrompt) : true;
    state.interactionCount = (state.interactionCount || 0) + 1;
    this.writeState(state);

    const result: { reminder?: string; bracket?: string } = {};

    if (!state.tasksCreated) {
      result.reminder = 'REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.';
    }

    if (this.config.context_tracking) {
      const bracket = this.getContextBracket(state.interactionCount);
      if (bracket !== 'FRESH') {
        result.bracket = BRACKET_MESSAGES[bracket];
      }
    }

    return result;
  }

  /**
   * Reset all spell state (new session).
   */
  sessionReset(): void {
    this.writeState({
      ...DEFAULT_STATE,
      sessionStart: new Date().toISOString(),
    });
  }
}

// ============================================================================
// CLI entry point (for backward compatibility with hooks)
// ============================================================================

/**
 * Process a spell gate command from CLI args.
 * Used by hooks.mjs dispatcher.
 */
export function processGateCommand(command: string, env: Record<string, string | undefined> = process.env): void {
  // Gate commands (check-before-*) are STRICT — errors propagate, exit 2 blocks.
  // Non-gate commands (record-*, prompt-reminder, etc.) are FAULT-TOLERANT —
  // they catch errors and exit 0 so classification failures never surface as
  // "hook error" to the user while gates remain fully enforced.

  // --- STRICT GATE COMMANDS (must block on failure) ---
  if (command.startsWith('check-before-') || command === 'check-dangerous-command') {
    const gate = new GateService();

    switch (command) {
      case 'check-before-agent': {
        const result = gate.checkBeforeAgent();
        // Advisory only — never exit 2 (block). Agent spawning should not be
        // gated because subagents share gate state and cascade failures.
        // Memory-first is enforced at the scan/read layer instead.
        // Write to stdout (not stderr) — stderr triggers "hook error" display in Claude Code UI.
        if (result.message) process.stdout.write(result.message + '\n');
        process.exit(0);
      }

      case 'check-before-scan': {
        const result = gate.checkBeforeScan(env.TOOL_INPUT_pattern, env.TOOL_INPUT_path);
        if (!result.allowed) {
          if (result.message) process.stderr.write(result.message + '\n');
          process.exit(2);
        }
        process.exit(0);
      }

      case 'check-before-read': {
        const result = gate.checkBeforeRead(env.TOOL_INPUT_file_path);
        if (!result.allowed) {
          if (result.message) process.stderr.write(result.message + '\n');
          process.exit(2);
        }
        process.exit(0);
      }

      case 'check-dangerous-command': {
        const cmd = (env.TOOL_INPUT_command || '').toLowerCase();
        const dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];
        for (const pattern of dangerous) {
          if (cmd.includes(pattern)) {
            process.stderr.write(`[BLOCKED] Dangerous command detected: ${pattern}\n`);
            process.exit(2);
          }
        }
        process.exit(0);
      }

      default:
        process.exit(0);
    }
  }

  // --- FAULT-TOLERANT COMMANDS (never surface errors to user) ---
  try {
    const gate = new GateService();

    switch (command) {
      case 'record-task-created':
        gate.recordTaskCreated();
        process.exit(0);

      case 'check-bash-memory':
        gate.checkBashMemory(env.TOOL_INPUT_command || '');
        process.exit(0);

      case 'record-memory-searched':
        gate.recordMemorySearched();
        process.exit(0);

      case 'prompt-reminder': {
        const userPrompt = env.CLAUDE_USER_PROMPT || '';
        const { reminder, bracket } = gate.promptReminder(userPrompt);
        if (reminder) console.log(reminder);
        if (bracket) console.log(bracket);
        process.exit(0);
      }

      case 'compact-guidance': {
        console.log('Pre-Compact Guidance:');
        console.log('IMPORTANT: Before compacting, preserve key context:');
        console.log('   - Check CLAUDE.md for project rules and architecture');
        console.log('   - Memory namespaces: guidance, code-map, patterns, knowledge');
        console.log('   - Use memory search to recover context after compact');
        console.log('   - Batch all operations in single messages (GOLDEN RULE)');
        process.exit(0);
      }

      case 'session-reset':
        gate.sessionReset();
        process.exit(0);

      default:
        process.exit(0);
    }
  } catch (err) {
    // Non-gate commands must never crash — log for debugging but exit clean
    process.stderr.write(`[gate:${command}] ${(err as Error).message ?? err}\n`);
    process.exit(0);
  }
}
