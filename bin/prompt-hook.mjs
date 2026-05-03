#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read stdin JSON from Claude Code
var stdinData = '';
try {
  stdinData = await new Promise(function(res) {
    var data = '';
    var timeout = setTimeout(function() { res(data); }, 500);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', function(chunk) { data += chunk; });
    process.stdin.on('end', function() { clearTimeout(timeout); res(data); });
    process.stdin.on('error', function() { clearTimeout(timeout); res(''); });
    if (process.stdin.isTTY) { clearTimeout(timeout); res(''); }
  });
} catch (e) { /* no stdin */ }

var hookContext = {};
try { if (stdinData.trim()) hookContext = JSON.parse(stdinData); } catch (e) {}

var userPrompt = hookContext.user_prompt || hookContext.prompt || '';
var env = Object.assign({}, process.env, { CLAUDE_USER_PROMPT: userPrompt });

// Run prompt-reminder via gate.cjs
var projectDir = (env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var gateScript = resolve(projectDir, '.claude/helpers/gate.cjs');
var output = '';
try {
  output = execFileSync('node', [gateScript, 'prompt-reminder'], {
    env: env, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
} catch (err) { output = (err && err.stdout) || ''; }

// Classify prompt for namespace hint
var lower = userPrompt.toLowerCase();

var LEARNINGS_HINTS = /\b(remember|recall|insight|lesson learned|gotcha|post.?mortem)\b|we (decid|agree|chose|said)/;
var TEST_HINTS = /\b(test|spec|coverage|tested|test case|test cases|tests for|spec for)\b/;
var EXPLICIT_NS = [
  { pattern: /\b(pattern|convention|best practice|style|coding rule)\b/, ns: 'patterns', label: 'code patterns and conventions' },
  { pattern: /\b(code.?map|file structure|project structure|directory)\b/, ns: 'code-map', label: 'codebase navigation' },
];
var PATTERN_HINTS = [/\b(template|example|similar to|how do we|how should)\b/];
var DOMAIN_HINTS = [
  /\b(guidance|guide|docs|documentation|rules|how-to)\b/,
  /\b(architecture|design|domain|tenant|migrat|schema|deploy)/,
  /\b(rule|requirement|constraint|compliance)\b/,
];
var NAV_PATTERNS = [
  /\b(find|where|which file|look up|locate|endpoint|route|url|path)\b/,
  /\b(class|function|method|component|service|entity|module)\b/,
];

var nsHint = '';
if (TEST_HINTS.test(lower)) {
  nsHint = 'Memory namespace hint: use "tests" for test inventory and coverage lookups.';
} else if (LEARNINGS_HINTS.test(lower)) {
  nsHint = 'Memory namespace hint: use "learnings" for user-directed decisions and distilled insights.';
} else {
  var found = EXPLICIT_NS.find(function(e) { return e.pattern.test(lower); });
  if (found) {
    nsHint = 'Memory namespace hint: use "' + found.ns + '" for ' + found.label + '.';
  } else if (DOMAIN_HINTS.some(function(p) { return p.test(lower); })) {
    nsHint = 'Memory namespace hint: search "guidance" and "learnings" for domain rules and project decisions.';
  } else if (PATTERN_HINTS.some(function(p) { return p.test(lower); })) {
    nsHint = 'Memory namespace hint: use "patterns" for code patterns and conventions.';
  } else if (NAV_PATTERNS.some(function(p) { return p.test(lower); })) {
    nsHint = 'Memory namespace hint: use "code-map" for codebase navigation.';
  }
}

// #867 — surface post-install restart notice. File is written by
// scripts/post-install-notice.mjs and cleared by the SessionStart launcher
// once the running moflo matches the file's version, so the file's
// existence at prompt-time is itself the "still needs restart" signal.
var restartNotice = '';
try {
  var pendingPath = resolve(projectDir, '.moflo', 'restart-pending.json');
  var pending = JSON.parse(readFileSync(pendingPath, 'utf-8'));
  if (pending && typeof pending.message === 'string' && pending.message.length > 0) {
    restartNotice = pending.message;
  }
} catch (e) { /* ENOENT or malformed — silent fast-path */ }

var parts = [restartNotice, output.trim(), nsHint].filter(Boolean);
if (parts.length) process.stdout.write(parts.join('\n\n') + '\n');
process.exit(0);
