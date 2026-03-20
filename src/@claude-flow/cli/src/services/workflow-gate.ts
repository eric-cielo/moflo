/**
 * Workflow Gate Service
 * Enforces TaskCreate + memory-first patterns before agent spawning
 * and file exploration. Tracks context bracket by interaction count.
 *
 * Ported from Motailz .claude/scripts/workflow-gate.mjs into MoFlo core.
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
import { loadMofloConfig } from '../config/moflo-config.js';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowState {
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

const DEFAULT_STATE: WorkflowState = {
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
  /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\b/i,
  /\b(commit|push|pull|merge|rebase|cherry-pick)\b/,
  /\b(rename|move|delete|remove)\b/,
  /^(show|read|open|cat|look at|check)\s/,
  /^(run|execute|start|stop|kill|restart)\s/,
  /\bpublish\b/, /\bversion\b/, /\bnpm\b/,
  /^let'?s\s+(commit|push|publish|deploy|ship|merge)/i,
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

export class WorkflowGateService {
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

  readState(): WorkflowState {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        return JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
      }
    } catch {
      // Reset on corruption
    }
    return { ...DEFAULT_STATE };
  }

  writeState(state: WorkflowState): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
    } catch {
      // Non-fatal
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
   * Requires both TaskCreate and memory search.
   */
  checkBeforeAgent(): GateResult {
    if (!this.config.task_create_first && !this.config.memory_first) {
      return { allowed: true };
    }

    const state = this.readState();

    if (this.config.task_create_first && !state.tasksCreated) {
      return {
        allowed: false,
        message: 'BLOCKED: Call TaskCreate before spawning agents.',
      };
    }

    if (this.config.memory_first && !state.memorySearched) {
      return {
        allowed: false,
        message: 'BLOCKED: Search memory (mcp__claude-flow__memory_search) before spawning agents.',
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
      message = 'BLOCKED: Search memory before exploring files. Use mcp__claude-flow__memory_search with namespace "code-map", "patterns", "knowledge", or "guidance".';
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
      message = 'BLOCKED: Search memory before reading guidance files. Use mcp__claude-flow__memory_search with namespace "guidance".';
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
   * Reset all workflow state (new session).
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
 * Process a workflow gate command from CLI args.
 * Used by hooks.mjs dispatcher.
 */
export function processGateCommand(command: string, env: Record<string, string | undefined> = process.env): void {
  const gate = new WorkflowGateService();

  switch (command) {
    case 'check-before-agent': {
      const result = gate.checkBeforeAgent();
      if (!result.allowed) {
        if (result.message) console.log(result.message);
        process.exit(1);
      }
      process.exit(0);
    }

    case 'check-before-scan': {
      const result = gate.checkBeforeScan(env.TOOL_INPUT_pattern, env.TOOL_INPUT_path);
      if (!result.allowed) {
        if (result.message) console.log(result.message);
        process.exit(1);
      }
      process.exit(0);
    }

    case 'check-before-read': {
      const result = gate.checkBeforeRead(env.TOOL_INPUT_file_path);
      if (!result.allowed) {
        if (result.message) console.log(result.message);
        process.exit(1);
      }
      process.exit(0);
    }

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

    case 'check-dangerous-command': {
      const cmd = (env.TOOL_INPUT_command || '').toLowerCase();
      const dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];
      for (const pattern of dangerous) {
        if (cmd.includes(pattern)) {
          console.log(`[BLOCKED] Dangerous command detected: ${pattern}`);
          process.exit(2);
        }
      }
      process.exit(0);
    }

    case 'session-reset':
      gate.sessionReset();
      process.exit(0);

    default:
      process.exit(0);
  }
}
