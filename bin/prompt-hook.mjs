#!/usr/bin/env node
import { execSync } from 'child_process';
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
  output = execSync('node "' + gateScript + '" prompt-reminder', {
    env: env, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
  });
} catch (err) { output = (err && err.stdout) || ''; }

// Classify prompt for namespace hint
var lower = userPrompt.toLowerCase();

var KNOWLEDGE_ONLY = /\b(knowledge|remember|recall)\b|we (decid|agree|chose|said)/;
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
if (KNOWLEDGE_ONLY.test(lower)) {
  nsHint = 'Memory namespace hint: use "knowledge" for user-directed project decisions.';
} else {
  var found = EXPLICIT_NS.find(function(e) { return e.pattern.test(lower); });
  if (found) {
    nsHint = 'Memory namespace hint: use "' + found.ns + '" for ' + found.label + '.';
  } else if (DOMAIN_HINTS.some(function(p) { return p.test(lower); })) {
    nsHint = 'Memory namespace hint: search "guidance" and "knowledge" for domain rules and project decisions.';
  } else if (PATTERN_HINTS.some(function(p) { return p.test(lower); })) {
    nsHint = 'Memory namespace hint: use "patterns" for code patterns and conventions.';
  } else if (NAV_PATTERNS.some(function(p) { return p.test(lower); })) {
    nsHint = 'Memory namespace hint: use "code-map" for codebase navigation.';
  }
}

var parts = [output.trim(), nsHint].filter(Boolean);
if (parts.length) process.stdout.write(parts.join('\n') + '\n');
process.exit(0);
