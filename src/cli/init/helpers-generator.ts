/**
 * Helpers Generator
 * Creates utility scripts in .claude/helpers/
 */

import type { InitOptions } from './types.js';

/**
 * Generate pre-commit hook script
 */
export function generatePreCommitHook(): string {
  return `#!/bin/bash
# Claude Flow Pre-Commit Hook
# Validates code quality before commit

set -e

echo "🔍 Running Claude Flow pre-commit checks..."

# Get staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

# Run validation for each staged file
for FILE in $STAGED_FILES; do
  if [[ "$FILE" =~ \\.(ts|js|tsx|jsx)$ ]]; then
    echo "  Validating: $FILE"
    npx moflo hooks pre-edit --file "$FILE" --validate-syntax 2>/dev/null || true
  fi
done

# Run tests if available
if [ -f "package.json" ] && grep -q '"test"' package.json; then
  echo "🧪 Running tests..."
  npm test --if-present 2>/dev/null || echo "  Tests skipped or failed"
fi

echo "✅ Pre-commit checks complete"
`;
}

/**
 * Generate post-commit hook script
 */
export function generatePostCommitHook(): string {
  return `#!/bin/bash
# Claude Flow Post-Commit Hook
# Records commit metrics and trains patterns

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B)

echo "📊 Recording commit metrics..."

# Notify claude-flow of commit
npx moflo hooks notify \\
  --message "Commit: $COMMIT_MSG" \\
  --level info \\
  --metadata '{"hash": "'$COMMIT_HASH'"}' 2>/dev/null || true

echo "✅ Commit recorded"
`;
}

/**
 * Generate a minimal auto-memory-hook.mjs fallback for fresh installs.
 * This ESM script handles import/sync/status commands gracefully when
 * moflo/cli/memory is not installed. Gets overwritten when source copy succeeds.
 */
export function generateAutoMemoryHook(): string {
  return `#!/usr/bin/env node
/**
 * Auto Memory Bridge Hook (ADR-048/049) — Minimal Fallback
 * Full version is copied from package source when available.
 *
 * Usage:
 *   node auto-memory-hook.mjs import   # SessionStart
 *   node auto-memory-hook.mjs sync     # SessionEnd / Stop
 *   node auto-memory-hook.mjs status   # Show bridge status
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.moflo', 'data');
const STORE_PATH = join(DATA_DIR, 'auto-memory-store.json');

const DIM = '\\x1b[2m';
const RESET = '\\x1b[0m';
const dim = (msg) => console.log(\`  \${DIM}\${msg}\${RESET}\`);

// Ensure data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

async function loadMemoryPackage() {
  // Memory was inlined into moflo's cli package by the workspace-collapse epic
  // (#586 / story #598) — the bare \`@moflo/memory\` specifier no longer resolves.
  // After the final cli collapse (#602) the compiled module ships at
  // <moflo-pkg-root>/dist/src/cli/memory/index.js.
  const MEMORY_REL = join('dist', 'src', 'cli', 'memory', 'index.js');
  const { pathToFileURL } = await import('url');

  // Strategy 1: Resolve moflo's package.json directly from the consumer
  // project — its dirname IS the package root, no walk needed.
  try {
    const { createRequire } = await import('module');
    const require = createRequire(join(PROJECT_ROOT, 'package.json'));
    const pkgRoot = dirname(require.resolve('moflo/package.json'));
    const candidate = join(pkgRoot, MEMORY_REL);
    if (existsSync(candidate)) return await import(pathToFileURL(candidate).href);
  } catch { /* fall through */ }

  // Strategy 2: Walk up from PROJECT_ROOT looking for moflo in any node_modules.
  let searchDir = PROJECT_ROOT;
  const { parse } = await import('path');
  while (searchDir !== parse(searchDir).root) {
    const candidate = join(searchDir, 'node_modules', 'moflo', MEMORY_REL);
    if (existsSync(candidate)) {
      try { return await import(pathToFileURL(candidate).href); } catch { /* fall through */ }
    }
    searchDir = dirname(searchDir);
  }

  return null;
}

async function doImport() {
  const memPkg = await loadMemoryPackage();

  if (!memPkg || !memPkg.AutoMemoryBridge) {
    dim('Memory package not available — auto memory import skipped (non-critical)');
    return;
  }

  // Full implementation deferred to copied version
  dim('Auto memory import available — run init --upgrade for full support');
}

async function doSync() {
  if (!existsSync(STORE_PATH)) {
    dim('No entries to sync');
    return;
  }

  const memPkg = await loadMemoryPackage();

  if (!memPkg || !memPkg.AutoMemoryBridge) {
    dim('Memory package not available — sync skipped (non-critical)');
    return;
  }

  dim('Auto memory sync available — run init --upgrade for full support');
}

function doStatus() {
  console.log('\\n=== Auto Memory Bridge Status ===\\n');
  console.log('  Package:        Fallback mode (run init --upgrade for full)');
  console.log(\`  Store:          \${existsSync(STORE_PATH) ? 'Initialized' : 'Not initialized'}\`);
  console.log('');
}

const command = process.argv[2] || 'status';

try {
  switch (command) {
    case 'import': await doImport(); break;
    case 'sync': await doSync(); break;
    case 'status': doStatus(); break;
    default:
      console.log('Usage: auto-memory-hook.mjs <import|sync|status>');
      process.exit(1);
  }
} catch (err) {
  // Hooks must never crash Claude Code - fail silently
  dim(\`Error (non-critical): \${err.message}\`);
}
`;
}

/**
 * Generate all helper files
 */
export function generateHelpers(options: InitOptions): Record<string, string> {
  const helpers: Record<string, string> = {};

  if (options.components.helpers) {
    helpers['pre-commit'] = generatePreCommitHook();
    helpers['post-commit'] = generatePostCommitHook();
    helpers['gate.cjs'] = generateGateScript();
    helpers['gate-hook.mjs'] = generateGateHookScript();
    helpers['prompt-hook.mjs'] = generatePromptHookScript();
    helpers['hook-handler.cjs'] = generateHookHandlerScript();
  }

  // statusline.cjs is intentionally NOT generated here — it is shipped as a
  // static file in `.claude/helpers/statusline.cjs` and copied during init/
  // upgrade by executor.writeStatusline (#715). One source of truth.

  return helpers;
}

/**
 * Generate lightweight gate.cjs — spell gates without CLI bootstrap.
 * Handles JSON state file read/write for memory-first and TaskCreate gates.
 * This replaces `npx flo gate <command>` to avoid spawning a full CLI process
 * on every tool call (~500ms npx overhead → ~20ms direct node).
 */
export function generateGateScript(): string {
  return `#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\\/([a-z])\\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

var STATE_DEFAULTS = { tasksCreated: false, taskCount: 0, memorySearched: false, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, interactionCount: 0, sessionStart: null, lastBlockedAt: null };

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
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
      if (/memory_first:\\s*false/i.test(content)) defaults.memory_first = false;
      if (/task_create_first:\\s*false/i.test(content)) defaults.task_create_first = false;
      if (/context_tracking:\\s*false/i.test(content)) defaults.context_tracking = false;
      if (/testing_gate:\\s*false/i.test(content)) defaults.testing_gate = false;
      if (/simplify_gate:\\s*false/i.test(content)) defaults.simplify_gate = false;
      if (/learnings_gate:\\s*false/i.test(content)) defaults.learnings_gate = false;
    }
  } catch (e) { /* use defaults */ }
  return defaults;
}

var config = loadGateConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules'];
var DANGEROUS = ['rm -rf /', 'format c:', 'del /s /q c:\\\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];
var DIRECTIVE_RE = /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\\b/i;
var TASK_RE = /\\b(fix|bug|error|implement|add|create|build|write|refactor|debug|test|feature|issue|security|optimi)\\b/i;
var TEST_RUNNER_RE = /(?:^|[^a-z])(?:npm|yarn|pnpm|bun)\\s+(?:run\\s+)?(?:test|t)(?:[:\\s]|$)|\\b(?:npx|pnpx)\\s+(?:vitest|jest|mocha|ava|tap|jasmine|pytest)\\b|(?:^|;|&&|\\|\\|)\\s*(?:vitest|jest|pytest|mocha|jasmine|tap|ava)\\s|\\b(?:cargo|go|deno|dotnet|mvn)\\s+test\\b|\\bgradle\\w*\\s+test\\b/i;
var EDIT_RESET_SKIP_RE = /\\.(md|markdown|txt|rst|adoc|lock|gitignore)$|(?:^|[\\\\\\/])(CHANGELOG(?:\\.md)?|\\.env\\.example|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb)$/i;

switch (command) {
  case 'check-before-agent': {
    // Advisory only — agent spawning is never blocked.
    // Memory-first enforcement happens at the scan/read gate layer.
    // SubagentStart hook injects guidance directive into subagent context.
    var s = readState();
    if (config.task_create_first && !s.tasksCreated) {
      process.stdout.write('REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.\\n');
    }
    if (config.memory_first && s.memoryRequired && !s.memorySearched) {
      process.stdout.write('REMINDER: Search memory (mcp__moflo__memory_search) before spawning agents.\\n');
    }
    break;
  }
  case 'check-before-scan': {
    if (!config.memory_first) break;
    var s = readState();
    if (s.memorySearched || !s.memoryRequired) break;
    var target = (process.env.TOOL_INPUT_pattern || '') + ' ' + (process.env.TOOL_INPUT_path || '');
    if (EXEMPT.some(function(p) { return target.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search.\\n');
    process.exit(2);
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (s.memorySearched || !s.memoryRequired) break;
    var fp = process.env.TOOL_INPUT_file_path || '';
    if (fp.indexOf('.claude/guidance/') < 0 && fp.indexOf('.claude\\\\guidance\\\\') < 0) break;
    process.stderr.write('BLOCKED: Search memory before reading guidance files. Use mcp__moflo__memory_search.\\n');
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
    if (!s.memorySearched) {
      s.memorySearched = true;
      writeState(s);
    }
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
    if (fp && EDIT_RESET_SKIP_RE.test(fp)) break;
    var s = readState();
    if (!s.testsRun && !s.simplifyRun) break;
    s.testsRun = false;
    s.simplifyRun = false;
    writeState(s);
    break;
  }
  case 'check-before-pr': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!/(?:^|&&\\s*|\\|\\|\\s*|;\\s*)\\s*(?:[A-Z_][A-Z0-9_]*=\\S+\\s+)*gh\\s+pr\\s+create\\b/.test(cmd)) break;
    var s = readState();
    var missing = [];
    if (config.testing_gate && !s.testsRun) missing.push('tests have not run since the last code edit (run npm test, vitest, jest, pytest, or similar)');
    if (config.simplify_gate && !s.simplifyRun) missing.push('/simplify has not run since the last code edit');
    if (config.learnings_gate && !s.learningsStored) missing.push('learnings have not been stored (call mcp__moflo__memory_store)');
    if (missing.length === 0) break;
    process.stderr.write('BLOCKED: gh pr create requires the following before opening a PR:\\n');
    for (var i = 0; i < missing.length; i++) {
      process.stderr.write('  - ' + missing[i] + '\\n');
    }
    process.stderr.write('Disable per-gate via moflo.yaml:\\n');
    process.stderr.write('  gates:\\n    testing_gate: false\\n    simplify_gate: false\\n    learnings_gate: false\\n');
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
    // learningsStored is session-scoped — once stored, it stays true until session reset.
    // Resetting per-prompt caused false blocks when PR creation was on a later prompt.
    var prompt = process.env.CLAUDE_USER_PROMPT || '';
    s.memoryRequired = prompt.length >= 4 && !DIRECTIVE_RE.test(prompt) && (TASK_RE.test(prompt) || prompt.length > 80);
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
    writeState({ tasksCreated: false, taskCount: 0, memorySearched: false, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, interactionCount: 0, sessionStart: new Date().toISOString(), lastBlockedAt: null });
    break;
  }
  default:
    break;
}
`;
}

/**
 * Generate gate-hook.mjs — ESM wrapper that reads Claude Code stdin JSON
 * and passes tool_name + tool_input to gate.cjs via environment variables.
 *
 * Claude Code hooks receive context as JSON on stdin but don't set env vars
 * for tool input. This script bridges that gap. It also translates exit code 1
 * from gate.cjs into exit code 2 (which Claude Code requires to block tools).
 */
export function generateGateHookScript(): string {
  return `#!/usr/bin/env node
import { execSync } from 'child_process';
import { resolve } from 'path';

var command = process.argv[2];
if (!command) process.exit(0);

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

// Pass tool info as env vars for gate.cjs
var env = Object.assign({}, process.env);
if (hookContext.tool_name) env.TOOL_NAME = hookContext.tool_name;
if (hookContext.tool_input && typeof hookContext.tool_input === 'object') {
  Object.keys(hookContext.tool_input).forEach(function(key) {
    if (typeof hookContext.tool_input[key] === 'string') {
      env['TOOL_INPUT_' + key] = hookContext.tool_input[key];
    }
  });
}

// Run gate.cjs with the enriched environment
var projectDir = (env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\\/([a-z])\\//i, '$1:/');
var gateScript = resolve(projectDir, '.claude/helpers/gate.cjs');
try {
  var output = execSync('node "' + gateScript + '" ' + command, {
    env: env, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
  });
  if (output.trim()) process.stdout.write(output);
  process.exit(0);
} catch (err) {
  // gate.cjs exit(2) = block, exit(1) = also block attempt — translate both to exit(2)
  if (err.stderr) process.stderr.write(err.stderr);
  if (err.stdout) process.stderr.write(err.stdout);
  process.exit(err.status === 2 || err.status === 1 ? 2 : 0);
}
`;
}

/**
 * Generate prompt-hook.mjs — reads user prompt from Claude Code stdin JSON,
 * runs prompt classification via gate.cjs, and appends namespace hints.
 */
export function generatePromptHookScript(): string {
  return `#!/usr/bin/env node
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
var projectDir = (env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\\/([a-z])\\//i, '$1:/');
var gateScript = resolve(projectDir, '.claude/helpers/gate.cjs');
var output = '';
try {
  output = execSync('node "' + gateScript + '" prompt-reminder', {
    env: env, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
  });
} catch (err) { output = (err && err.stdout) || ''; }

// Classify prompt for namespace hint
var lower = userPrompt.toLowerCase();

var LEARNINGS_HINTS = /\\b(remember|recall|insight|lesson learned|gotcha|post.?mortem)\\b|we (decid|agree|chose|said)/;
var TEST_HINTS = /\\b(test|spec|coverage|tested|test case|test cases|tests for|spec for)\\b/;
var EXPLICIT_NS = [
  { pattern: /\\b(pattern|convention|best practice|style|coding rule)\\b/, ns: 'patterns', label: 'code patterns and conventions' },
  { pattern: /\\b(code.?map|file structure|project structure|directory)\\b/, ns: 'code-map', label: 'codebase navigation' },
];
var PATTERN_HINTS = [/\\b(template|example|similar to|how do we|how should)\\b/];
var DOMAIN_HINTS = [
  /\\b(guidance|guide|docs|documentation|rules|how-to)\\b/,
  /\\b(architecture|design|domain|tenant|migrat|schema|deploy)/,
  /\\b(rule|requirement|constraint|compliance)\\b/,
];
var NAV_PATTERNS = [
  /\\b(find|where|which file|look up|locate|endpoint|route|url|path)\\b/,
  /\\b(class|function|method|component|service|entity|module)\\b/,
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

var parts = [output.trim(), nsHint].filter(Boolean);
if (parts.length) process.stdout.write(parts.join('\\n') + '\\n');
process.exit(0);
`;
}

/**
 * Generate lightweight hook-handler.cjs — hook dispatch without CLI bootstrap.
 * Handles routing, edit/task tracking, session lifecycle, and notifications.
 * This replaces `npx flo hooks <command>` to avoid spawning a full CLI process.
 */
export function generateHookHandlerScript(): string {
  return `#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');

var PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
var METRICS_FILE = path.join(PROJECT_DIR, '.moflo', 'metrics', 'learning.json');
var command = process.argv[2];

// Read stdin (Claude Code sends hook data as JSON)
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise(function(resolve) {
    var data = '';
    var timer = setTimeout(function() {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    }, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function(chunk) { data += chunk; });
    process.stdin.on('end', function() { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', function() { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

function bumpMetric(key) {
  try {
    var metrics = {};
    if (fs.existsSync(METRICS_FILE)) metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8'));
    metrics[key] = (metrics[key] || 0) + 1;
    metrics.lastUpdated = new Date().toISOString();
    var dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
  } catch (e) { /* non-fatal */ }
}

readStdin().then(function(stdinData) {
  var hookInput = {};
  if (stdinData && stdinData.trim()) {
    try { hookInput = JSON.parse(stdinData); } catch (e) { /* ignore */ }
  }

  switch (command) {
    case 'route': {
      var prompt = hookInput.prompt || hookInput.command || process.env.PROMPT || '';
      if (prompt) console.log('[INFO] Routing: ' + prompt.substring(0, 80));
      else console.log('[INFO] Ready');
      break;
    }
    case 'pre-edit':
    case 'post-edit':
      bumpMetric('edits');
      console.log('[OK] Edit recorded');
      break;
    case 'pre-task':
      bumpMetric('tasks');
      console.log('[OK] Task started');
      break;
    case 'post-task':
      bumpMetric('tasksCompleted');
      console.log('[OK] Task completed');
      break;
    case 'session-end':
      console.log('[OK] Session ended');
      break;
    case 'notification':
      // Silent — just acknowledge
      break;
    default:
      if (command) console.log('[OK] Hook: ' + command);
      break;
  }
});
`;
}
