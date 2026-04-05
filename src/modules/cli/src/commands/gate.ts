/**
 * MoFlo Gate Command
 * Workflow gate enforcement for Claude Code hooks.
 *
 * Called by .claude/settings.json hooks to enforce:
 * - Memory-first pattern (search before Glob/Grep/Read)
 * - TaskCreate-first pattern (create tasks before Agent tool)
 * - Context bracket tracking (FRESH/MODERATE/DEPLETED/CRITICAL)
 *
 * Usage from hooks:
 *   npx flo gate check-before-scan
 *   npx flo gate check-before-read
 *   npx flo gate check-before-agent
 *   npx flo gate record-task-created
 *   npx flo gate record-memory-searched
 *   npx flo gate check-bash-memory
 *   npx flo gate prompt-reminder
 *   npx flo gate session-reset
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { processGateCommand } from '../services/workflow-gate.js';

const gateCommand: Command = {
  name: 'gate',
  description: 'Workflow gate enforcement for Claude Code hooks',
  options: [],
  examples: [
    { command: 'npx flo gate check-before-scan', description: 'Check memory-first before Glob/Grep' },
    { command: 'npx flo gate check-before-agent', description: 'Check TaskCreate before Agent tool' },
    { command: 'npx flo gate prompt-reminder', description: 'Reset per-prompt state, show context bracket' },
    { command: 'npx flo gate session-reset', description: 'Reset all workflow state' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const subcommand = ctx.args?.[0];

    if (!subcommand) {
      console.log('Usage: npx flo gate <command>');
      console.log('');
      console.log('Commands:');
      console.log('  check-before-scan      Check memory searched before Glob/Grep');
      console.log('  check-before-read      Check memory searched before reading guidance');
      console.log('  check-before-agent     Check TaskCreate + memory before Agent tool');
      console.log('  record-task-created    Record TaskCreate usage');
      console.log('  record-memory-searched Record memory search');
      console.log('  check-bash-memory      Detect memory search in Bash commands');
      console.log('  prompt-reminder        Reset memory gate, show context bracket');
      console.log('  session-reset          Reset all workflow state');
      return { success: true };
    }

    // Delegate to the WorkflowGateService
    // processGateCommand calls process.exit() directly for hook compatibility
    processGateCommand(subcommand);

    return { success: true };
  },
};

export default gateCommand;
