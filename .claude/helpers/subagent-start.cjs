#!/usr/bin/env node
/**
 * SubagentStart Hook — injects a directive into every subagent's context
 * telling it to read the subagent protocol guidance before doing any work.
 *
 * Output format: JSON with additionalContext (Claude Code hook protocol).
 * Exit 0 = allow (SubagentStart cannot block).
 */
'use strict';

const output = {
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext:
      'IMPORTANT: Before doing any work, read `.claude/guidance/shipped/moflo-subagents.md` and follow its protocol. ' +
      'You MUST search memory (mcp__moflo__memory_search) before using Glob, Grep, or Read tools.',
  },
};

process.stdout.write(JSON.stringify(output));
process.exit(0);
