#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');

var PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) { /* reset on corruption */ }
  return { tasksCreated: false, taskCount: 0, memorySearched: false, memoryRequired: true, interactionCount: 0, sessionStart: null, lastBlockedAt: null };
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

var DANGEROUS = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];
var DIRECTIVE_RE = /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\b/i;
var TASK_RE = /\b(fix|bug|error|implement|add|create|build|write|refactor|debug|test|feature|issue|security|optimi)\b/i;

// Deny a tool call cleanly via structured JSON (no "hook error" noise).
// Exit 0 + permissionDecision:"deny" is the Claude Code way to block a tool.
function blockTool(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

// Determine if a Grep/Glob target is a mechanical/administrative search
// that should bypass the memory-first gate. The idea: if memory/guidance
// wouldn't improve the search outcome, don't block it.
//
// Strategy: path is the strongest signal. When a path clearly points to
// tooling/deps/tests, allow it. When it points to source/docs/scripts,
// block it (require memory). Pattern-based rules only kick in when there's
// no path or when the path is neutral.
function isMechanicalSearch() {
  var searchPath = (process.env.TOOL_INPUT_path || '').replace(/\\/g, '/').toLowerCase();
  var pattern = (process.env.TOOL_INPUT_pattern || '').toLowerCase();
  var filePath = (process.env.TOOL_INPUT_file_path || '').replace(/\\/g, '/').toLowerCase();
  var anyPath = searchPath || filePath;

  // --- PATH-BASED RULES (strongest signal, checked first) ---

  if (anyPath) {
    // Always mechanical: dependencies, tooling internals, CI, test dirs
    var mechanicalPaths = [
      'node_modules/', '.claude/', '.claude-flow/', '.swarm/', '.github/',
      'tests/', 'test/', 'config/', 'examples/',
    ];
    for (var i = 0; i < mechanicalPaths.length; i++) {
      if (anyPath.indexOf(mechanicalPaths[i]) >= 0) return true;
    }

    // Targeting a specific config/meta file by path extension
    if (/\.(json|yaml|yml|toml|lock|env|cjs|mjs)$/i.test(anyPath)) return true;

    // If path points to source, docs, or scripts — these are knowledge-rich.
    // Do NOT fall through to pattern-based exemptions; the path is authoritative.
    // (Still allow test-file glob patterns even within source dirs.)
    var knowledgePaths = [
      'src/', 'back-office/', 'front-office/', 'docs/', 'scripts/', 'lib/',
    ];
    var inKnowledgePath = false;
    for (var k = 0; k < knowledgePaths.length; k++) {
      if (anyPath.indexOf(knowledgePaths[k]) >= 0) { inKnowledgePath = true; break; }
    }
    if (inKnowledgePath) {
      // Exception: searching for test/spec files within source is structural
      if (/\*\*?[/\\]?\*?\.(test|spec)\.(ts|js|tsx|jsx)\b/i.test(pattern)) return true;
      // Everything else in a knowledge path requires memory
      return false;
    }
  }

  // --- PATTERN-BASED RULES (no path, or path is neutral) ---

  // Glob patterns looking for config/build/tooling files by extension
  if (/\*\*?[/\\]?\*?\.(json|yaml|yml|toml|lock|env|config|cjs|mjs)\b/i.test(pattern)) return true;

  // Glob patterns for specific config filenames (eslintrc, Dockerfile, etc.)
  if (/\*\*?[/\\]?\*?\.?(eslint|prettier|babel|stylelint|editor|git|docker|nginx|jest|vitest|vite|webpack|rollup|esbuild|tsconfig|browserslist)/i.test(pattern)) return true;

  // Glob patterns for lock files and test files (structural lookups)
  if (/\*\*?[/\\]?\*?[\w-]*[-.]lock\b/i.test(pattern)) return true;
  if (/\*\*?[/\\]?\*?\.(test|spec)\.(ts|js|tsx|jsx)\b/i.test(pattern)) return true;

  // Config/tooling name searches (bare names without a path).
  // Only exempt if ALL tokens in a pipe-separated pattern are config names.
  // "webpack|vite" = exempt. "webpack|merchant" = NOT exempt.
  var CONFIG_NAME = /^\.?(eslint|prettier|babel|stylelint|editor|gitignore|gitattributes|dockerignore|dockerfile|docker-compose|nginx|jest|vitest|vite|webpack|rollup|esbuild|tsconfig|changelog|license|makefile|procfile|browserslist|commitlint|husky|lint-staged)\b/i;
  var tokens = pattern.split(/[|,\s]+/).filter(function(t) { return t.length > 0; });
  if (tokens.length > 0 && tokens.every(function(t) { return CONFIG_NAME.test(t.trim()); })) return true;

  // Known tooling/meta file names as substrings (but avoid false matches like "process.env")
  var toolingNames = [
    'claude.md', 'memory.md', 'workflow-state', '.mcp.json',
    'package.json', 'package-lock', 'daemon.lock', 'moflo.yaml',
  ];
  var target = pattern + ' ' + anyPath;
  for (var j = 0; j < toolingNames.length; j++) {
    if (target.indexOf(toolingNames[j]) >= 0) return true;
  }

  // Env file lookups (but NOT "process.env" which is source code searching)
  if (/^\.env\b/.test(pattern) || /\*\*?[/\\]?\.env/.test(pattern)) return true;

  // Git/process/system-level pattern searches
  if (/^(git\b|pid|daemon|lock|wmic|tasklist|powershell|ps\s)/i.test(pattern)) return true;

  // CI/CD folder exploration
  if (/\.github/i.test(pattern)) return true;

  return false;
}

switch (command) {
  case 'check-before-agent': {
    var s = readState();
    if (config.task_create_first && !s.tasksCreated) {
      blockTool('Call TaskCreate before spawning agents. Task tool is blocked until then.');
    }
    if (config.memory_first && !s.memorySearched) {
      blockTool('Search memory before spawning agents. Use mcp__moflo__memory_search first.');
    }
    break;
  }
  case 'check-before-scan': {
    if (!config.memory_first) break;
    var s = readState();
    if (s.memorySearched || !s.memoryRequired) break;
    if (isMechanicalSearch()) break;
    s.lastBlockedAt = new Date().toISOString();
    writeState(s);
    blockTool('Search memory before exploring files. Use mcp__moflo__memory_search with namespace "code-map", "patterns", "knowledge", or "guidance".');
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (s.memorySearched || !s.memoryRequired) break;
    var fp = (process.env.TOOL_INPUT_file_path || '').replace(/\\/g, '/');
    // Block reads of guidance files (that's exactly what memory indexes)
    if (fp.indexOf('.claude/guidance/') < 0) break;
    s.lastBlockedAt = new Date().toISOString();
    writeState(s);
    blockTool('Search memory before reading guidance files. Use mcp__moflo__memory_search with namespace "guidance".');
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
    var prompt = process.env.CLAUDE_USER_PROMPT || '';
    s.memoryRequired = prompt.length >= 4 && !DIRECTIVE_RE.test(prompt) && (TASK_RE.test(prompt) || prompt.length > 80);
    s.interactionCount = (s.interactionCount || 0) + 1;
    writeState(s);
    if (!s.tasksCreated) console.log('REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.');
    if (config.context_tracking) {
      var ic = s.interactionCount;
      if (ic > 30) console.log('Context: CRITICAL. Commit, store learnings, suggest new session.');
      else if (ic > 20) console.log('Context: DEPLETED. Checkpoint progress. Recommend /compact or fresh session.');
      else if (ic > 10) console.log('Context: MODERATE. Re-state goal before architectural decisions.');
    }
    break;
  }
  case 'compact-guidance': {
    console.log('Pre-Compact: Check CLAUDE.md for rules. Use memory search to recover context after compact.');
    break;
  }
  case 'session-reset': {
    writeState({ tasksCreated: false, taskCount: 0, memorySearched: false, memoryRequired: true, interactionCount: 0, sessionStart: new Date().toISOString(), lastBlockedAt: null });
    break;
  }
  default:
    break;
}
