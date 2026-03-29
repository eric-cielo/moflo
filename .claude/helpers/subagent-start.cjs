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
      'MANDATORY FIRST ACTION: Your very first tool call MUST be mcp__moflo__memory_search (any query, any namespace). ' +
      'The memory-first gate WILL BLOCK all Glob, Grep, and Read calls until you do this. ' +
      'After memory search, follow `.claude/guidance/shipped/moflo-subagents.md` protocol.',
  },
};

process.stdout.write(JSON.stringify(output));
process.exit(0);
