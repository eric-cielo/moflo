#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) { /* reset on corruption */ }
  return { tasksCreated: false, taskCount: 0, memorySearched: false, memoryRequired: true, learningsStored: false, interactionCount: 0, sessionStart: null, lastBlockedAt: null };
}

function writeState(s) {
  try {
    var dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { /* non-fatal */ }
}

// Load moflo.yaml gate config (defaults: all enabled)
function loadGateConfig() {
  var defaults = { memory_first: true, task_create_first: true, context_tracking: true };
  try {
    var yamlPath = path.join(PROJECT_DIR, 'moflo.yaml');
    if (fs.existsSync(yamlPath)) {
      var content = fs.readFileSync(yamlPath, 'utf-8');
      if (/memory_first:\s*false/i.test(content)) defaults.memory_first = false;
      if (/task_create_first:\s*false/i.test(content)) defaults.task_create_first = false;
      if (/context_tracking:\s*false/i.test(content)) defaults.context_tracking = false;
    }
  } catch (e) { /* use defaults */ }
  return defaults;
}

var config = loadGateConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules'];
var DANGEROUS = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];
var DIRECTIVE_RE = /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\b/i;
var TASK_RE = /\b(fix|bug|error|implement|add|create|build|write|refactor|debug|test|feature|issue|security|optimi)\b/i;

switch (command) {
  case 'check-before-agent': {
    // Advisory only — agent spawning is never blocked.
    // Memory-first enforcement happens at the scan/read gate layer.
    // SubagentStart hook injects guidance directive into subagent context.
    var s = readState();
    if (config.task_create_first && !s.tasksCreated) {
      process.stdout.write('REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.\n');
    }
    if (config.memory_first && s.memoryRequired && !s.memorySearched) {
      process.stdout.write('REMINDER: Search memory (mcp__moflo__memory_search) before spawning agents.\n');
    }
    break;
  }
  case 'check-before-scan': {
    if (!config.memory_first) break;
    var s = readState();
    if (s.memorySearched || !s.memoryRequired) break;
    var target = (process.env.TOOL_INPUT_pattern || '') + ' ' + (process.env.TOOL_INPUT_path || '');
    if (EXEMPT.some(function(p) { return target.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search.\n');
    process.exit(2);
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (s.memorySearched || !s.memoryRequired) break;
    var fp = process.env.TOOL_INPUT_file_path || '';
    var isGuidance = fp.indexOf('.claude/guidance/') >= 0 || fp.indexOf('.claude\\guidance\\') >= 0;
    if (!isGuidance && EXEMPT.some(function(p) { return fp.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before reading files. Use mcp__moflo__memory_search.\n');
    process.exit(2);
  }
  case 'record-task-created': {
    var s = readState();
    s.tasksCreated = true;
    s.taskCount = (s.taskCount || 0) + 1;
    writeState(s);
    break;
  }
  case 'record-memory-searched': {
    var s = readState();
    s.memorySearched = true;
    writeState(s);
    break;
  }
  case 'check-bash-memory': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (/semantic-search|memory search|memory retrieve|memory-search/.test(cmd)) {
      var s = readState();
      s.memorySearched = true;
      writeState(s);
    }
    break;
  }
  case 'check-task-transition': {
    // Memory gate resets on new user prompts (prompt-reminder), not on task
    // transitions. Within a single prompt (e.g., /flo workflow), memory stays
    // searched so Read/Grep aren't blocked mid-execution.
    break;
  }
  case 'record-learnings-stored': {
    var s = readState();
    s.learningsStored = true;
    writeState(s);
    break;
  }
  case 'check-before-pr': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (/gh\s+pr\s+create/.test(cmd)) {
      var s = readState();
      // Trivial sessions (≤3 interactions) skip the learnings gate —
      // version bumps, typo fixes, etc. have nothing worth storing.
      var trivial = (s.interactionCount || 0) <= 3;
      if (!s.learningsStored && !trivial) {
        process.stderr.write('BLOCKED: Store learnings before creating a PR. Use mcp__moflo__memory_store to record what was learned.\n');
        process.exit(2);
      }
    }
    break;
  }
  case 'check-dangerous-command': {
    var cmd = (process.env.TOOL_INPUT_command || '').toLowerCase();
    for (var i = 0; i < DANGEROUS.length; i++) {
      if (cmd.indexOf(DANGEROUS[i]) >= 0) {
        console.log('[BLOCKED] Dangerous command: ' + DANGEROUS[i]);
        process.exit(2);
      }
    }
    break;
  }
  case 'prompt-reminder': {
    var s = readState();
    s.memorySearched = false;
    // learningsStored is session-scoped — once stored, it stays true until session reset.
    // Resetting per-prompt caused false blocks when PR creation was on a later prompt.
    var prompt = process.env.CLAUDE_USER_PROMPT || '';
    var DIRECTIVE_MAX_LEN = 20;
    var escaped = /^@@\s*/.test(prompt);
    s.memoryRequired = !escaped && prompt.length >= 4 && (TASK_RE.test(prompt) || prompt.length > DIRECTIVE_MAX_LEN);
    s.interactionCount = (s.interactionCount || 0) + 1;
    writeState(s);
    if (!s.tasksCreated) console.log('REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.');
    if (config.context_tracking) {
      var ic = s.interactionCount;
      if (ic > 30) console.log('Context: CRITICAL. Commit, store learnings, suggest new session.');
      else if (ic > 20) console.log('Context: DEPLETED. Checkpoint progress. Recommend /compact or fresh session.');
      else if (ic > 10) console.log('Context: MODERATE. Re-state goal before architectural decisions. Use agents for >300 LOC.');
    }
    break;
  }
  case 'compact-guidance': {
    console.log('Pre-Compact: Check CLAUDE.md for rules. Use memory search to recover context after compact.');
    break;
  }
  case 'session-reset': {
    writeState({ tasksCreated: false, taskCount: 0, memorySearched: false, memoryRequired: true, learningsStored: false, interactionCount: 0, sessionStart: new Date().toISOString(), lastBlockedAt: null });
    break;
  }
  default:
    break;
}
