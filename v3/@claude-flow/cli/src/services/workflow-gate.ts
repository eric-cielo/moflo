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

// ============================================================================
// Types
// ============================================================================

export interface WorkflowState {
  tasksCreated: boolean;
  taskCount: number;
  memorySearched: boolean;
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
  interactionCount: 0,
  sessionStart: null,
  lastBlockedAt: null,
};

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

  constructor(projectRoot: string = process.cwd()) {
    this.stateFilePath = path.resolve(projectRoot, '.claude/workflow-state.json');
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
    const state = this.readState();

    if (!state.tasksCreated) {
      return {
        allowed: false,
        message: 'BLOCKED: Call TaskCreate before spawning agents.',
      };
    }

    if (!state.memorySearched) {
      return {
        allowed: false,
        message: 'BLOCKED: Search memory (mcp__claude-flow__memory_search) before spawning agents.',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if Glob/Grep is allowed.
   * Requires memory search (with exemptions for system paths).
   */
  checkBeforeScan(pattern?: string, searchPath?: string): GateResult {
    const state = this.readState();

    if (state.memorySearched) {
      return { allowed: true };
    }

    // Exempt system paths
    const target = `${pattern || ''} ${searchPath || ''}`;
    if (EXEMPT_PATTERNS.some(p => target.includes(p))) {
      return { allowed: true };
    }

    // Deduplicate: only emit message once per 2s window
    const now = Date.now();
    const lastBlocked = state.lastBlockedAt ? new Date(state.lastBlockedAt).getTime() : 0;
    let message: string | undefined;

    if (now - lastBlocked > 2000) {
      state.lastBlockedAt = new Date(now).toISOString();
      this.writeState(state);
      message = 'BLOCKED: Search memory before exploring files. Use mcp__claude-flow__memory_search with namespace "code-map", "patterns", or "guidance".';
    }

    return { allowed: false, message };
  }

  /**
   * Check if Read on guidance files is allowed.
   * Only gates reads targeting .claude/guidance/ files.
   */
  checkBeforeRead(filePath?: string): GateResult {
    const state = this.readState();

    if (state.memorySearched) {
      return { allowed: true };
    }

    // Only gate guidance file reads
    if (!filePath?.includes('.claude/guidance/') && !filePath?.includes('.claude\\guidance\\')) {
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
   * Called on each new user prompt.
   * Resets memory gate, increments interaction count, returns context bracket.
   */
  promptReminder(): { reminder?: string; bracket?: string } {
    const state = this.readState();
    state.memorySearched = false;
    state.interactionCount = (state.interactionCount || 0) + 1;
    this.writeState(state);

    const result: { reminder?: string; bracket?: string } = {};

    if (!state.tasksCreated) {
      result.reminder = 'REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.';
    }

    const bracket = this.getContextBracket(state.interactionCount);
    if (bracket !== 'FRESH') {
      result.bracket = BRACKET_MESSAGES[bracket];
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
      const { reminder, bracket } = gate.promptReminder();
      if (reminder) console.log(reminder);
      if (bracket) console.log(bracket);
      process.exit(0);
    }

    case 'session-reset':
      gate.sessionReset();
      process.exit(0);

    default:
      process.exit(0);
  }
}
