#!/usr/bin/env node
/**
 * SubagentStart Hook — injects a directive into every subagent's context
 * telling it to read the subagent protocol guidance before doing any work.
 *
 * Output format: JSON with additionalContext (Claude Code hook protocol).
 * Exit 0 = allow (SubagentStart cannot block).
 *
 * Source of truth: ./subagent-bootstrap.json (sibling). The TS export at
 * `src/cli/services/subagent-bootstrap.ts` reads the same file so future
 * agent_spawn surfaces (epic #798 stories 3 + 9) inject byte-identical text.
 *
 * Inline FALLBACK keeps the hook functional if the JSON sibling is ever
 * missing — a SubagentStart that emits nothing leaves the memory-first gate
 * un-announced and silently regresses subagent behavior.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Defense-in-depth copy of the canonical directive in subagent-bootstrap.json.
// Kept as a single-line literal so the parity test in tests/bin/subagent-start.test.ts
// can verify it matches the JSON via plain substring containment.
const FALLBACK_DIRECTIVE = 'MANDATORY FIRST ACTION: Your very first tool call MUST be mcp__moflo__memory_search (any query, any namespace). The memory-first gate WILL BLOCK all Glob, Grep, and Read calls until you do this. After memory search, follow `.claude/guidance/shipped/moflo-subagents.md` protocol.';

function loadDirective() {
  const jsonPath = path.join(__dirname, 'subagent-bootstrap.json');
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`[subagent-start] read failed: ${err.message} — using inline fallback\n`);
    }
    return FALLBACK_DIRECTIVE;
  }
  try {
    const data = JSON.parse(raw);
    if (typeof data.directive === 'string' && data.directive.length > 0) {
      return data.directive;
    }
    process.stderr.write('[subagent-start] subagent-bootstrap.json missing string `directive` — using inline fallback\n');
  } catch (err) {
    process.stderr.write(`[subagent-start] subagent-bootstrap.json parse failed: ${err.message} — using inline fallback\n`);
  }
  return FALLBACK_DIRECTIVE;
}

const output = {
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext: loadDirective(),
  },
};

process.stdout.write(JSON.stringify(output));
process.exit(0);
