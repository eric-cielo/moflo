#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

var STATE_DEFAULTS = { tasksCreated: false, taskCount: 0, memorySearched: false, memorySearchedBy: {}, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, interactionCount: 0, sessionStart: null, lastBlockedAt: null };

// Per-actor memory-search tracking (#838). The legacy `memorySearched` boolean
// is session-wide, so once the parent searches memory, every spawned subagent
// inherits the satisfied flag and the directive's "WILL BLOCK" promise becomes
// false. When gate-hook.mjs forwards Claude Code's stdin `session_id` as
// HOOK_SESSION_ID, prefer the per-session map so each subagent must search
// memory itself before its first Glob/Grep/Read. Falls back to the legacy
// boolean when no session id is present (CLI invocations, tests, older hosts).
function isMemorySearchedFor(state) {
  var sid = process.env.HOOK_SESSION_ID || '';
  if (sid) {
    var map = state.memorySearchedBy || {};
    return map[sid] === true;
  }
  return state.memorySearched === true;
}

// Stamp the legacy bool plus (when HOOK_SESSION_ID is set) the per-actor map.
// Returns true if anything actually changed — callers gate writeState() on it
// to avoid redundant fsyncs in tight bash-memory loops.
function markMemorySearched(state) {
  var sid = process.env.HOOK_SESSION_ID || '';
  var changed = false;
  if (state.memorySearched !== true) { state.memorySearched = true; changed = true; }
  if (sid) {
    if (!state.memorySearchedBy) state.memorySearchedBy = {};
    if (state.memorySearchedBy[sid] !== true) { state.memorySearchedBy[sid] = true; changed = true; }
  }
  return changed;
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Merge defaults so missing keys (e.g. added in newer versions) are filled in
      return Object.assign({}, STATE_DEFAULTS, parsed);
    }
  } catch (e) { /* reset on corruption */ }
  return Object.assign({}, STATE_DEFAULTS);
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
  var defaults = { memory_first: true, task_create_first: true, context_tracking: true, testing_gate: true, simplify_gate: true, learnings_gate: true };
  try {
    var yamlPath = path.join(PROJECT_DIR, 'moflo.yaml');
    if (fs.existsSync(yamlPath)) {
      var content = fs.readFileSync(yamlPath, 'utf-8');
      if (/memory_first:\s*false/i.test(content)) defaults.memory_first = false;
      if (/task_create_first:\s*false/i.test(content)) defaults.task_create_first = false;
      if (/context_tracking:\s*false/i.test(content)) defaults.context_tracking = false;
      if (/testing_gate:\s*false/i.test(content)) defaults.testing_gate = false;
      if (/simplify_gate:\s*false/i.test(content)) defaults.simplify_gate = false;
      if (/learnings_gate:\s*false/i.test(content)) defaults.learnings_gate = false;
    }
  } catch (e) { /* use defaults */ }
  return defaults;
}

var config = loadGateConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules', 'moflo.yaml'];
var DANGEROUS = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];
var DIRECTIVE_RE = /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\b/i;
var TASK_RE = /\b(fix|bug|error|implement|add|create|build|write|refactor|debug|test|feature|issue|security|optimi)\b/i;
// Match npm/yarn/pnpm/bun test, npx vitest|jest|..., bare runners at command-start only,
// and language-native test commands. The bare-runner arm is anchored so that
// `npm install jest`, `grep -r vitest src/`, and similar don't false-positive.
var TEST_RUNNER_RE = /(?:^|[^a-z])(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|t)(?:[:\s]|$)|\b(?:npx|pnpx)\s+(?:vitest|jest|mocha|ava|tap|jasmine|pytest)\b|(?:^|;|&&|\|\|)\s*(?:vitest|jest|pytest|mocha|jasmine|tap|ava)\s|\b(?:cargo|go|deno|dotnet|mvn)\s+test\b|\bgradle\w*\s+test\b/i;
// Edits to these don't change runtime behaviour, so they don't invalidate prior test/simplify runs.
// Lock files and .gitignore are tracked but inert; package.json/*.yaml ARE source — they reset.
var EDIT_RESET_SKIP_BOTH_RE = /\.(md|markdown|txt|rst|adoc|lock|gitignore)$|(?:^|[\\\/])(CHANGELOG(?:\.md)?|\.env\.example|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;
// Test files: invalidate the testing gate (tests are stale once test code changes)
// but NOT the simplify gate — /simplify already reviewed the production code; touching
// a test file or fixture doesn't expose new untested surface for code review (#908).
var EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE = /(?:^|[\\\/])(__tests__|__mocks__|tests?|spec|specs|cypress|e2e|fixtures?)[\\\/]|\.(test|spec)\.[mc]?[jt]sx?$|\.fixture\.[mc]?[jt]sx?$/i;

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
    if (!s.memoryRequired || isMemorySearchedFor(s)) break;
    var target = (process.env.TOOL_INPUT_pattern || '') + ' ' + (process.env.TOOL_INPUT_path || '');
    if (EXEMPT.some(function(p) { return target.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search.\n');
    process.exit(2);
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (!s.memoryRequired || isMemorySearchedFor(s)) break;
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
    if (markMemorySearched(s)) writeState(s);
    break;
  }
  case 'check-bash-memory': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (/semantic-search|memory search|memory retrieve|memory-search/.test(cmd)) {
      var s = readState();
      if (markMemorySearched(s)) writeState(s);
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
    if (!s.learningsStored) {
      s.learningsStored = true;
      writeState(s);
    }
    break;
  }
  case 'record-test-run': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (TEST_RUNNER_RE.test(cmd)) {
      var s = readState();
      if (!s.testsRun) {
        s.testsRun = true;
        writeState(s);
      }
    }
    break;
  }
  case 'record-skill-run': {
    if ((process.env.TOOL_INPUT_skill || '') === 'simplify') {
      var s = readState();
      if (!s.simplifyRun) {
        s.simplifyRun = true;
        writeState(s);
      }
    }
    break;
  }
  case 'reset-edit-gates': {
    var fp = process.env.TOOL_INPUT_file_path || '';
    // Inert files (markdown, lockfiles, CHANGELOG, .env.example): no gate reset.
    if (fp && EDIT_RESET_SKIP_BOTH_RE.test(fp)) break;
    var s = readState();
    // Test-only edits invalidate testsRun but preserve simplifyRun (#908).
    var isTestOnly = fp && EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE.test(fp);
    var resetTests = s.testsRun;
    var resetSimplify = s.simplifyRun && !isTestOnly;
    if (!resetTests && !resetSimplify) break;
    var gates = [];
    if (resetTests) { s.testsRun = false; gates.push('tests'); }
    if (resetSimplify) { s.simplifyRun = false; gates.push('simplify'); }
    if (fp) {
      s.lastResetBy = { file: fp, at: new Date().toISOString(), gates: gates };
    }
    writeState(s);
    break;
  }
  case 'check-before-pr': {
    // Anchored to command-start (or chained via && / || / ;) so heredoc bodies
    // and quoted strings that contain the literal "gh pr create" don't trip
    // the gate during regular `git commit -m "...gh pr create..."` flows. The
    // optional ENV=val prefix segment catches `GH_TOKEN=x gh pr create`.
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!/(?:^|&&\s*|\|\|\s*|;\s*)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/.test(cmd)) break;
    var s = readState();
    var missing = [];
    if (config.testing_gate && !s.testsRun) missing.push('tests have not run since the last code edit (run npm test, vitest, jest, pytest, or similar)');
    if (config.simplify_gate && !s.simplifyRun) missing.push('/simplify has not run since the last code edit');
    if (config.learnings_gate && !s.learningsStored) missing.push('learnings have not been stored (call mcp__moflo__memory_store)');
    if (missing.length === 0) break;
    process.stderr.write('BLOCKED: gh pr create requires the following before opening a PR:\n');
    for (var i = 0; i < missing.length; i++) {
      process.stderr.write('  - ' + missing[i] + '\n');
    }
    if (s.lastResetBy && s.lastResetBy.file) {
      process.stderr.write('Last gate reset: ' + s.lastResetBy.file + ' (' + (s.lastResetBy.gates || []).join(', ') + ')\n');
    }
    process.stderr.write('Disable per-gate via moflo.yaml:\n');
    process.stderr.write('  gates:\n    testing_gate: false\n    simplify_gate: false\n    learnings_gate: false\n');
    process.exit(2);
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
    // Wipe per-actor memory tracking too — a new user prompt is a fresh window
    // for both parent AND any subagents the parent may spawn during this turn.
    s.memorySearchedBy = {};
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
    writeState({ tasksCreated: false, taskCount: 0, memorySearched: false, memorySearchedBy: {}, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, interactionCount: 0, sessionStart: new Date().toISOString(), lastBlockedAt: null });
    break;
  }
  default:
    break;
}
