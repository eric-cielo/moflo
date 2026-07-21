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
# moflo Pre-Commit Hook
# Validates code quality before commit

set -e

echo "🔍 Running moflo pre-commit checks..."

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
# moflo Post-Commit Hook
# Records commit metrics and trains patterns

COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B)

echo "📊 Recording commit metrics..."

# Notify flo of commit
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
var os = require('os');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\\/([a-z])\\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

var STATE_DEFAULTS = { tasksCreated: false, taskCount: 0, memorySearched: false, memorySearchedBy: {}, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, verifyRun: false, verifyOutcome: null, interactionCount: 0, sessionStart: null, lastBlockedAt: null, lastNamespaceHint: '', lastNamespaceHintEmittedBy: {}, flMode: null, swarmInitialized: false, hiveInitialized: false, sddMode: false, activeSddSlug: null };

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return Object.assign({}, STATE_DEFAULTS, parsed);
    }
  } catch (e) { /* reset on corruption */ }
  return Object.assign({}, STATE_DEFAULTS);
}

// Per-actor memory-search tracking (#838). When gate-hook.mjs forwards Claude
// Code's stdin session_id as HOOK_SESSION_ID, prefer the per-session map so
// each spawned subagent must search memory itself before its first
// Glob/Grep/Read. Falls back to the legacy boolean otherwise.
function isMemorySearchedFor(state) {
  var sid = process.env.HOOK_SESSION_ID || '';
  if (sid) {
    var map = state.memorySearchedBy || {};
    return map[sid] === true;
  }
  return state.memorySearched === true;
}

// Stamp the legacy bool plus (when HOOK_SESSION_ID is set) the per-actor map.
// Returns true if anything actually changed — callers gate writeState() on it.
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

function writeState(s) {
  try {
    var dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { /* non-fatal */ }
}

// Load moflo.yaml gate config (defaults: all enabled)
function loadGateConfig() {
  var defaults = { memory_first: true, task_create_first: true, context_tracking: true, testing_gate: true, simplify_gate: true, learnings_gate: true, swarm_invocation_gate: true, verify_before_done: true, sdd_gate: true };
  var content = MOFLO_YAML;
  if (content) {
    if (/memory_first:\\s*false/i.test(content)) defaults.memory_first = false;
    if (/task_create_first:\\s*false/i.test(content)) defaults.task_create_first = false;
    if (/context_tracking:\\s*false/i.test(content)) defaults.context_tracking = false;
    if (/testing_gate:\\s*false/i.test(content)) defaults.testing_gate = false;
    if (/simplify_gate:\\s*false/i.test(content)) defaults.simplify_gate = false;
    if (/learnings_gate:\\s*false/i.test(content)) defaults.learnings_gate = false;
    if (/swarm_invocation_gate:\\s*false/i.test(content)) defaults.swarm_invocation_gate = false;
    // Opt-out: on by default (#1294); disable only when explicitly set false.
    if (/verify_before_done:\\s*false/i.test(content)) defaults.verify_before_done = false;
    // #1297 — check-before-implement backstop; opt-out. Only fires when armed.
    if (/sdd_gate:\\s*false/i.test(content)) defaults.sdd_gate = false;
  }
  return defaults;
}

// #1297 — parse the top-level sdd: block (default + specs_dir), scoped so we
// never match a default: key from another section. Tolerates CRLF. SYNC: mirrors
// bin/gate.cjs loadSddConfig.
function loadSddConfig() {
  var out = { default: false, specsDir: '.moflo/specs' };
  var content = MOFLO_YAML;
  if (!content) return out;
  var block = content.match(/^sdd:[ \\t]*\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$))*)/m);
  if (!block) return out;
  var body = block[1];
  if (/^\\s*default:\\s*true\\b/im.test(body)) out.default = true;
  var sd = body.match(/^\\s*specs_dir:\\s*(.+?)\\s*$/im);
  if (sd) {
    var v = sd[1].replace(/\\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (v) out.specsDir = v;
  }
  return out;
}

// #1297 — read moflo.yaml once (both loaders parse it; gate fires on every
// Write/Edit). SYNC: mirrors bin/gate.cjs readMofloYaml.
function readMofloYaml() {
  try { return fs.readFileSync(path.join(PROJECT_DIR, 'moflo.yaml'), 'utf-8'); }
  catch (e) { return ''; }
}
var MOFLO_YAML = readMofloYaml();

var config = loadGateConfig();
var sddConf = loadSddConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules', 'moflo.yaml'];
// #1294 Finding 3 — exempt ephemeral reads/scans under the OS temp dir
// (background-task output, scratchpads) from the memory-first gate. Mirrors
// bin/gate.cjs isEphemeralPath. Cross-platform via os.tmpdir(); normalizes a
// leading /private so macOS /var-vs-/private/var symlink pairs match.
function stripPrivate(p) { return p.indexOf('/private/') === 0 ? p.slice('/private'.length) : p; }
function isEphemeralPath(fp) {
  if (!fp) return false;
  var tmp;
  try { tmp = path.resolve(os.tmpdir()); } catch (e) { return false; }
  var t = stripPrivate(tmp);
  function under(p) { var n = stripPrivate(p); return n === t || n.indexOf(t + path.sep) === 0; }
  var resolved = path.resolve(fp);
  if (!under(resolved)) return false;
  // Symlink staged in tmp could deref to a real file — realpath both (Rule #2).
  try { return under(fs.realpathSync(resolved)); } catch (e) { return true; }
}
// #1171 — DANGEROUS gained PS additions to match the matcher widening that now
// routes the PowerShell tool through check-dangerous-command. See bin/gate.cjs.
var DANGEROUS = ['rm -rf /', 'format c:', 'del /s /q c:\\\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda', 'remove-item -recurse -force c:\\\\', 'remove-item -recurse -force /', 'remove-item -recurse -force ~', 'format-volume', 'clear-disk'];
// #1132 — Bash memory-first gate regexes. See bin/gate.cjs for documentation.
// #1171 — READ_LIKE extended with PS-native exploration forms (Get-ChildItem -Recurse,
// dir /s, Format-Hex). Plain Get-ChildItem stays uncovered (ls-equivalent).
var CREDIT_MEMORY_SEARCH_RE = /semantic-search|memory search|memory retrieve|memory-search/;
var READ_LIKE_BASH_RE = /^\\s*(?:cat|head|tail|less|more|bat|xxd|od|hexdump)\\b|^\\s*(?:grep|rg|ag|fgrep|egrep|find|fd)\\b|^\\s*sed\\s+-n\\b|^\\s*awk\\s+(?!.*<<)|^\\s*type\\s+\\S*[\\\\/.]|^\\s*(?:Get-Content|gc|Select-String|sls)\\b|^\\s*(?:Get-ChildItem|gci)\\b[^|]*-Recurse\\b|^\\s*dir\\b[^|]*\\s\\/[sS]\\b|^\\s*Format-Hex\\b/i;
var BASH_CARVE_OUT_RE = /^\\s*(npm|npx|pnpm|yarn|bun|node|deno|tsx|ts-node)\\s|^\\s*(git|gh|hub)\\s|^\\s*(docker|kubectl|helm|terraform)\\s|^\\s*(curl|wget|http|fetch)\\s|^\\s*(jq|yq|xq)\\s|^\\s*(echo|printf|true|false|sleep|test|\\[)\\s|^\\s*cat\\s+(<<|<<<)|^\\s*cat\\s+[^|]*\\s*>|^\\s*tee\\b|^\\s*find\\s+.+?-(delete|exec\\s+rm)\\b/;
// #1171 follow-up — strip quoted bodies + heredocs before DANGEROUS substring
// match so git commit messages with dangerous-shaped text in quoted bodies do
// not trip the gate. See bin/gate.cjs for the full rationale. Command-sub
// bodies are intentionally not stripped (those execute).
function stripQuotedAndHeredocs(cmd) {
  var out = cmd;
  out = out.replace(/<<-?\\s*['"]?[\\w-]+['"]?[\\s\\S]*$/, '');
  out = out.replace(/<<<\\s*\\S+/g, '');
  out = out.replace(/'[^']*'/g, "''");
  out = out.replace(/"(?:[^"\\\\]|\\\\.)*"/g, '""');
  return out;
}

var DIRECTIVE_RE = /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\\b/i;
var TASK_RE = /\\b(fix|bug|error|implement|add|create|build|write|refactor|debug|test|feature|issue|security|optimi)\\b/i;

// Namespace classification (#931). Hint stored on workflow-state and emitted
// once by check-before-agent at Agent-spawn time — was emitted on every prompt
// before, costing ~40 tokens × every prompt × every consumer.
//
// SYNC: these regexes + classifyNamespaceHint + applyPromptStateReset are
// duplicated verbatim in bin/gate.cjs (canonical, synced to consumer
// .claude/helpers/gate.cjs by post-install-bootstrap). Any edit MUST be
// applied to both — this template is the fallback for the flo-init path
// where source helpers cannot be located, so it must keep parity.
var NS_LEARNINGS_RE = /\\b(remember|recall|insight|lesson learned|gotcha|post.?mortem)\\b|we (decid|agree|chose|said)/;
var NS_TEST_RE = /\\b(test|spec|coverage|tested|test case|test cases|tests for|spec for)\\b/;
var NS_EXPLICIT = [
  { pattern: /\\b(pattern|convention|best practice|style|coding rule)\\b/, ns: 'patterns', label: 'code patterns and conventions' },
  { pattern: /\\b(code.?map|file structure|project structure|directory)\\b/, ns: 'code-map', label: 'codebase navigation' },
];
var NS_PATTERN_RES = [/\\b(template|example|similar to|how do we|how should)\\b/];
var NS_DOMAIN_RES = [
  /\\b(guidance|guide|docs|documentation|rules|how-to)\\b/,
  /\\b(architecture|design|domain|tenant|migrat|schema|deploy)/,
  /\\b(rule|requirement|constraint|compliance)\\b/,
];
var NS_NAV_RES = [
  /\\b(find|where|which file|look up|locate|endpoint|route|url|path)\\b/,
  /\\b(class|function|method|component|service|entity|module)\\b/,
];

// Detect whether the current prompt invoked /fl or /flo with a swarm/hive flag
// (#952). When set, check-before-agent BLOCKS the Agent spawn until the matching
// MCP init has been recorded — the user explicitly opted in to the protected
// coordination surface, so falling back to raw Agent dispatch silently regresses
// headline moflo product capability.
//
// SYNC: duplicated verbatim in bin/gate.cjs.
function detectFlMode(promptText) {
  var p = promptText || '';
  if (!/^\\s*\\/(?:fl|flo)\\b/i.test(p)) return null;
  if (/(?:^|\\s)(?:-s|--swarm)\\b/.test(p)) return 'swarm';
  if (/(?:^|\\s)(?:-h|--hive)\\b/.test(p)) return 'hive';
  return null;
}

// #1297 — arm the SDD implement gate from a /flo prompt. SYNC: mirrors bin/gate.cjs.
function detectSddMode(promptText) {
  var p = promptText || '';
  if (!/^\\s*\\/(?:fl|flo)\\b/i.test(p)) return false;
  if (/(?:^|\\s)--no-sdd\\b/.test(p)) return false;
  if (/(?:^|\\s)(?:-sd|--sdd)\\b/.test(p)) return true;
  return !!sddConf.default;
}

// SDD specs-root resolution + artifact helpers for check-before-implement.
// SYNC: mirrors bin/gate.cjs. Rule #1: no separator hardcoded; CRLF-tolerant.
var SOURCE_FILE_RE = /\\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|ps1)$/i;
function sddSpecsRootAbs() {
  var configured = (sddConf.specsDir || '.moflo/specs');
  var segments = configured.split(/[\\\\/]+/).filter(Boolean);
  var escapes = segments.length === 0
    || segments.indexOf('..') >= 0
    || /^([a-zA-Z]:|~)$/.test(segments[0])
    || configured.charAt(0) === '/'
    || configured.charAt(0) === '\\\\';
  if (escapes) return path.join(PROJECT_DIR, '.moflo', 'specs');
  return path.join.apply(path, [PROJECT_DIR].concat(segments));
}
function isInsideSpecsDir(filePath) {
  try {
    var root = sddSpecsRootAbs();
    var abs = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_DIR, filePath);
    var rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (e) { return false; }
}
function isPlanReviewed(slug) {
  try {
    var planPath = path.join(sddSpecsRootAbs(), slug, 'plan.md');
    if (!fs.existsSync(planPath)) return false;
    var content = fs.readFileSync(planPath, 'utf-8').replace(/\\r\\n/g, '\\n');
    var fm = content.match(/^---\\n([\\s\\S]*?)\\n---/);
    if (!fm) return false;
    return /^\\s*status:\\s*["']?reviewed["']?\\s*$/im.test(fm[1]);
  } catch (e) { return false; }
}

function classifyNamespaceHint(promptText) {
  var lower = (promptText || '').toLowerCase();
  if (NS_TEST_RE.test(lower)) return 'Memory namespace hint: use "tests" for test inventory and coverage lookups.';
  if (NS_LEARNINGS_RE.test(lower)) return 'Memory namespace hint: use "learnings" for user-directed decisions and distilled insights.';
  for (var i = 0; i < NS_EXPLICIT.length; i++) {
    if (NS_EXPLICIT[i].pattern.test(lower)) return 'Memory namespace hint: use "' + NS_EXPLICIT[i].ns + '" for ' + NS_EXPLICIT[i].label + '.';
  }
  for (var j = 0; j < NS_DOMAIN_RES.length; j++) {
    if (NS_DOMAIN_RES[j].test(lower)) return 'Memory namespace hint: search "guidance" and "learnings" for domain rules and project decisions.';
  }
  for (var k = 0; k < NS_PATTERN_RES.length; k++) {
    if (NS_PATTERN_RES[k].test(lower)) return 'Memory namespace hint: use "patterns" for code patterns and conventions.';
  }
  for (var m = 0; m < NS_NAV_RES.length; m++) {
    if (NS_NAV_RES[m].test(lower)) return 'Memory namespace hint: use "code-map" for codebase navigation.';
  }
  return '';
}

// #1132 — command-shape namespace classifier for the bash-BLOCK message.
// SYNC: duplicated verbatim in bin/gate.cjs. See that file for rationale.
function classifyBashNamespaceHint(cmd) {
  if (/^\\s*(?:grep|rg|ag|fgrep|egrep|find|fd|Select-String|sls)\\b/i.test(cmd)) {
    return 'Memory namespace hint: use "code-map" for codebase navigation.';
  }
  if (/^\\s*(?:cat|head|tail|less|more|bat|type|Get-Content|gc)\\b.*\\.(?:md|mdx|rst|txt)\\b/i.test(cmd)
   || /^\\s*(?:cat|head|tail|less|more|bat|type|Get-Content|gc)\\b.*\\b(?:README|CLAUDE|CHANGELOG|CONTRIBUTING|LICENSE)\\b/i.test(cmd)) {
    return 'Memory namespace hint: search "guidance" and "learnings" for project rules and decisions.';
  }
  return '';
}

function applyPromptStateReset(state, promptText) {
  state.memorySearched = false;
  state.memorySearchedBy = {};
  var DIRECTIVE_MAX_LEN = 20;
  var escaped = /^@@\\s*/.test(promptText || '');
  state.memoryRequired = !escaped && (promptText || '').length >= 4 && (TASK_RE.test(promptText || '') || (promptText || '').length > DIRECTIVE_MAX_LEN);
  state.lastNamespaceHint = classifyNamespaceHint(promptText);
  // Per-actor emission tracking — fresh window each prompt so subagents that
  // spawn their own agents still see the hint on their first check-before-agent.
  state.lastNamespaceHintEmittedBy = {};
  // #952 — derive flMode from the user prompt and reset the matching init
  // flag. Each /fl invocation must call its protected MCP init.
  state.flMode = detectFlMode(promptText);
  state.swarmInitialized = false;
  state.hiveInitialized = false;
  // #1297 — arm/disarm SDD implement gate per prompt; fresh run has no active slug.
  state.sddMode = detectSddMode(promptText);
  state.activeSddSlug = null;
}
var TEST_RUNNER_RE = /(?:^|[^a-z])(?:npm|yarn|pnpm|bun)\\s+(?:run\\s+)?(?:test|t)(?:[:\\s]|$)|\\b(?:npx|pnpx)\\s+(?:vitest|jest|mocha|ava|tap|jasmine|pytest)\\b|(?:^|;|&&|\\|\\|)\\s*(?:vitest|jest|pytest|mocha|jasmine|tap|ava)\\s|\\b(?:cargo|go|deno|dotnet|mvn)\\s+test\\b|\\bgradle\\w*\\s+test\\b/i;
var EDIT_RESET_SKIP_BOTH_RE = /\\.(md|markdown|txt|rst|adoc|lock|gitignore)$|(?:^|[\\\\\\/])(CHANGELOG(?:\\.md)?|\\.env\\.example|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb)$/i;
// #1297 — path-inert dirs (.github/workflows etc.); SYNC: mirrors bin/gate.cjs EDIT_RESET_SKIP_PATH_RE.
var EDIT_RESET_SKIP_PATH_RE = /(?:^|[\\\\\\/])\\.github[\\\\\\/](?:workflows|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)(?:[\\\\\\/.]|$)/i;
// Test files: invalidate testsRun but preserve simplifyRun (#908) — /simplify
// already reviewed the production code, touching tests/fixtures doesn't expose
// new untested surface for code review.
var EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE = /(?:^|[\\\\\\/])(__tests__|__mocks__|tests?|spec|specs|cypress|e2e|fixtures?)[\\\\\\/]|\\.(test|spec)\\.[mc]?[jt]sx?$|\\.fixture\\.[mc]?[jt]sx?$/i;

switch (command) {
  case 'check-before-agent': {
    // Advisory only — agent spawning is never blocked.
    // Memory-first enforcement happens at the scan/read gate layer.
    // SubagentStart hook injects guidance directive into subagent context.
    // #931 — TaskCreate REMINDER + namespace hint moved here from
    // prompt-reminder so they emit only when Claude is about to spawn an Agent.
    var s = readState();
    if (config.task_create_first && !s.tasksCreated) {
      process.stdout.write('REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.\\n');
    }
    if (config.memory_first && s.memoryRequired && !s.memorySearched) {
      process.stdout.write('REMINDER: Search memory (mcp__moflo__memory_search) before spawning agents.\\n');
    }
    if (s.lastNamespaceHint) {
      // Per-actor single-shot — each session_id emits the hint at most once
      // per prompt. Subagents that spawn their own agents still see it on
      // their first check-before-agent because their session_id is its own
      // bucket. Falls back to a _legacy_ bucket when HOOK_SESSION_ID is
      // missing (older Claude Code, direct CLI). The map clears on every
      // new prompt via applyPromptStateReset.
      var sid = process.env.HOOK_SESSION_ID || '';
      var emittedBy = s.lastNamespaceHintEmittedBy || {};
      var bucket = sid || '_legacy_';
      if (!emittedBy[bucket]) {
        process.stdout.write(s.lastNamespaceHint + '\\n');
        emittedBy[bucket] = true;
        s.lastNamespaceHintEmittedBy = emittedBy;
        writeState(s);
      }
    }
    // #952 — when /fl was invoked with -s/-h, the protected MCP init must run
    // BEFORE any Agent spawn. Hard block: the user explicitly opted in to
    // moflo's coordination surface, so silently dispatching Agent calls
    // without mcp__moflo__swarm_init / mcp__moflo__hive-mind_init is the
    // failure mode this gate exists to prevent (CLAUDE.md "⛔ Protected
    // functionality"). Other Agent uses remain advisory.
    if (config.swarm_invocation_gate) {
      if (s.flMode === 'swarm' && !s.swarmInitialized) {
        process.stderr.write('BLOCKED: /fl was invoked with -s/--swarm but mcp__moflo__swarm_init has not been called.\\n');
        process.stderr.write('Run mcp__moflo__swarm_init first, then mcp__moflo__agent_spawn for each role, then dispatch Agent.\\n');
        process.stderr.write('See .claude/skills/fl/execution-modes.md "SWARM mode" and CLAUDE.md "⛔ Protected functionality".\\n');
        process.stderr.write('Disable via moflo.yaml: gates: swarm_invocation_gate: false\\n');
        process.exit(2);
      }
      if (s.flMode === 'hive' && !s.hiveInitialized) {
        process.stderr.write('BLOCKED: /fl was invoked with -h/--hive but mcp__moflo__hive-mind_init has not been called.\\n');
        process.stderr.write('Run mcp__moflo__hive-mind_init first, then dispatch Agent or hive-mind workers.\\n');
        process.stderr.write('See .claude/skills/fl/execution-modes.md "HIVE-MIND mode" and CLAUDE.md "⛔ Protected functionality".\\n');
        process.stderr.write('Disable via moflo.yaml: gates: swarm_invocation_gate: false\\n');
        process.exit(2);
      }
    }
    break;
  }
  case 'record-swarm-init': {
    // #952 — wired to mcp__moflo__swarm_init PostToolUse.
    var s = readState();
    if (!s.swarmInitialized) {
      s.swarmInitialized = true;
      writeState(s);
    }
    break;
  }
  case 'record-hive-init': {
    // #952 — wired to mcp__moflo__hive-mind_init PostToolUse.
    var s = readState();
    if (!s.hiveInitialized) {
      s.hiveInitialized = true;
      writeState(s);
    }
    break;
  }
  case 'check-before-scan': {
    if (!config.memory_first) break;
    var s = readState();
    if (!s.memoryRequired || isMemorySearchedFor(s)) break;
    var target = (process.env.TOOL_INPUT_pattern || '') + ' ' + (process.env.TOOL_INPUT_path || '');
    if (isEphemeralPath(process.env.TOOL_INPUT_path)) break;
    if (EXEMPT.some(function(p) { return target.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search.\\n');
    process.exit(2);
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (!s.memoryRequired || isMemorySearchedFor(s)) break;
    var fp = process.env.TOOL_INPUT_file_path || '';
    if (isEphemeralPath(fp)) break;
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
    if (markMemorySearched(s)) writeState(s);
    break;
  }
  case 'check-bash-memory': {
    // #1132 — credit + block. See bin/gate.cjs for full documentation.
    var cmd = process.env.TOOL_INPUT_command || '';
    if (CREDIT_MEMORY_SEARCH_RE.test(cmd)) {
      var s = readState();
      if (markMemorySearched(s)) writeState(s);
      break;
    }
    if (!config.memory_first) break;
    if (!READ_LIKE_BASH_RE.test(cmd)) break;
    if (BASH_CARVE_OUT_RE.test(cmd)) break;
    var s2 = readState();
    if (!s2.memoryRequired || isMemorySearchedFor(s2)) break;
    // Hint precedence: prompt classification → command-shape classification.
    // See bin/gate.cjs check-bash-memory for full rationale.
    var hint = s2.lastNamespaceHint || classifyBashNamespaceHint(cmd) || '';
    process.stderr.write(
      'BLOCKED: Search memory before reading files via Bash.\\n' +
      'Example: mcp__moflo__memory_search { query: "<topic>", namespace: "<one of: guidance | code-map | patterns | learnings | tests>" }\\n' +
      (hint ? hint + '\\n' : '') +
      'On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\\n' +
      'Disable per-gate via moflo.yaml: gates: memory_first: false\\n'
    );
    process.exit(2);
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
    var skName = (process.env.TOOL_INPUT_skill || '');
    if (skName === 'simplify' || skName === 'flo-simplify' || skName === 'distill') {
      var s = readState();
      if (!s.simplifyRun) {
        s.simplifyRun = true;
        writeState(s);
      }
    }
    break;
  }
  case 'record-verify-run': {
    // Story #1274 (Epic #1269) — credit the native /verify skill for the
    // verify-before-done gate.
    var vName = (process.env.TOOL_INPUT_skill || '');
    // Only /verify satisfies the gate — /ward and /quicken are audits, not
    // end-to-end verification (see fl/sdd.md).
    if (vName === 'verify') {
      var s = readState();
      if (!s.verifyRun) { s.verifyRun = true; writeState(s); }
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
    // A code edit invalidates a prior verification (Story #1274), like tests.
    var resetVerify = s.verifyRun;
    var resetSimplify = s.simplifyRun && !isTestOnly;
    if (!resetTests && !resetSimplify && !resetVerify) break;
    var gates = [];
    if (resetTests) { s.testsRun = false; gates.push('tests'); }
    if (resetVerify) { s.verifyRun = false; gates.push('verify'); }
    if (resetSimplify) { s.simplifyRun = false; gates.push('simplify'); }
    if (fp) {
      s.lastResetBy = { file: fp, at: new Date().toISOString(), gates: gates };
    }
    writeState(s);
    break;
  }
  case 'check-before-implement': {
    // #1297 — SDD front-half backstop. Block source Write/Edit until a spec
    // exists and its plan is reviewed, when the run is armed for SDD. SYNC:
    // mirrors bin/gate.cjs. Disarmed (non-SDD) runs pass instantly.
    if (!config.sdd_gate) break;
    var si = readState();
    if (!si.sddMode) break;
    var fpi = process.env.TOOL_INPUT_file_path || '';
    if (!fpi) break;
    if (EXEMPT.some(function (e) { return fpi.indexOf(e) >= 0; })) break;
    if (!SOURCE_FILE_RE.test(fpi)) break;
    if (EDIT_RESET_SKIP_PATH_RE.test(fpi)) break;
    if (isInsideSpecsDir(fpi)) break;
    if (!si.activeSddSlug) {
      process.stderr.write('BLOCKED: SDD mode is on — author a spec before editing source.\\n' +
        'Run: flo sdd spec "<title>"   (then review it, and plan)\\n' +
        'One-off skip: re-run with --no-sdd. Disable via moflo.yaml: gates: sdd_gate: false\\n');
      process.exit(2);
    }
    if (!isPlanReviewed(si.activeSddSlug)) {
      process.stderr.write('BLOCKED: SDD — the plan for "' + si.activeSddSlug + '" is not reviewed yet.\\n' +
        '  flo sdd plan ' + si.activeSddSlug + '\\n' +
        '  flo sdd review ' + si.activeSddSlug + ' plan\\n' +
        'One-off skip: re-run with --no-sdd. Disable via moflo.yaml: gates: sdd_gate: false\\n');
      process.exit(2);
    }
    break;
  }
  case 'check-before-pr': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!/(?:^|&&\\s*|\\|\\|\\s*|;\\s*)\\s*(?:[A-Z_][A-Z0-9_]*=\\S+\\s+)*gh\\s+pr\\s+create\\b/.test(cmd)) break;
    var s = readState();
    var missing = [];
    if (config.testing_gate && !s.testsRun) missing.push('tests have not run since the last code edit (run npm test, vitest, jest, pytest, or similar)');
    if (config.simplify_gate && !s.simplifyRun) missing.push('/flo-simplify (or /distill) has not run since the last code edit');
    if (config.learnings_gate && !s.learningsStored) missing.push('learnings have not been stored (call mcp__moflo__memory_store)');
    if (missing.length === 0) break;
    process.stderr.write('BLOCKED: gh pr create requires the following before opening a PR:\\n');
    for (var i = 0; i < missing.length; i++) {
      process.stderr.write('  - ' + missing[i] + '\\n');
    }
    if (s.lastResetBy && s.lastResetBy.file) {
      process.stderr.write('Last gate reset: ' + s.lastResetBy.file + ' (' + (s.lastResetBy.gates || []).join(', ') + ')\\n');
    }
    process.stderr.write('Disable per-gate via moflo.yaml:\\n');
    process.stderr.write('  gates:\\n    testing_gate: false\\n    simplify_gate: false\\n    learnings_gate: false\\n');
    process.exit(2);
  }
  case 'check-before-done': {
    // Story #1274 (Epic #1269) + #1294 — verify-before-done. ON by default
    // (#1294); disable via moflo.yaml gates.verify_before_done: false or per-run
    // --no-verify. Same 'gh pr create' trigger as check-before-pr. This
    // template variant intentionally omits the no-source (docs-only) exemption to
    // stay consistent with THIS file's simpler check-before-pr; the full exemption
    // lives in the source bin/gate.cjs that the launcher syncs over this fallback.
    if (!config.verify_before_done) break;
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!/(?:^|&&\\s*|\\|\\|\\s*|;\\s*)\\s*(?:[A-Z_][A-Z0-9_]*=\\S+\\s+)*gh\\s+pr\\s+create\\b/.test(cmd)) break;
    var s = readState();
    if (s.verifyRun) break;
    process.stderr.write('BLOCKED: gh pr create requires verification before done:\\n');
    process.stderr.write('  - the change has not been verified since the last code edit (run /verify)\\n');
    process.stderr.write('Disable via moflo.yaml:\\n');
    process.stderr.write('  gates:\\n    verify_before_done: false\\n');
    process.exit(2);
  }
  case 'check-dangerous-command': {
    // #1171 follow-up — strip quoted bodies + heredocs before substring match.
    // See bin/gate.cjs for full rationale.
    var raw = process.env.TOOL_INPUT_command || '';
    var cmd = stripQuotedAndHeredocs(raw).toLowerCase();
    for (var i = 0; i < DANGEROUS.length; i++) {
      if (cmd.indexOf(DANGEROUS[i]) >= 0) {
        console.log('[BLOCKED] Dangerous command: ' + DANGEROUS[i]);
        process.exit(2);
      }
    }
    break;
  }
  case 'prompt-reminder': {
    // Full per-prompt reset (first UserPromptSubmit hook via prompt-hook.mjs).
    // Owns interactionCount + Context warnings. TaskCreate REMINDER and
    // namespace hint moved to check-before-agent (#931).
    var s = readState();
    var prompt = process.env.CLAUDE_USER_PROMPT || '';
    applyPromptStateReset(s, prompt);
    s.interactionCount = (s.interactionCount || 0) + 1;
    writeState(s);
    if (config.context_tracking) {
      var ic = s.interactionCount;
      if (ic > 30) console.log('Context: CRITICAL. Commit, store learnings, suggest new session.');
      else if (ic > 20) console.log('Context: DEPLETED. Checkpoint progress. Recommend /compact or fresh session.');
      else if (ic > 10) console.log('Context: MODERATE. Re-state goal before architectural decisions. Use agents for >300 LOC.');
    }
    break;
  }
  case 'prompt-state-reset': {
    // Defensive safety-net (second UserPromptSubmit hook). Idempotent state
    // reset only — no interactionCount increment, no emission. Ensures the
    // per-prompt reset still happens if prompt-hook.mjs throws (#931). Skip
    // the disk write when prompt-reminder already wrote the byte-identical
    // post-reset state (the normal no-exception path).
    var s = readState();
    var prompt = process.env.CLAUDE_USER_PROMPT || '';
    var before = JSON.stringify(s);
    applyPromptStateReset(s, prompt);
    if (JSON.stringify(s) !== before) writeState(s);
    break;
  }
  case 'compact-guidance': {
    console.log('Pre-Compact: Check CLAUDE.md for rules. Use memory search to recover context after compact.');
    break;
  }
  case 'session-reset': {
    // Derive from STATE_DEFAULTS so adding a new state field requires only one
    // edit (the defaults object).
    writeState(Object.assign({}, STATE_DEFAULTS, { sessionStart: new Date().toISOString() }));
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
// Forward Claude Code's session_id so gate.cjs can enforce memory-first
// per-actor (#838) — each spawned subagent has its own session_id.
if (typeof hookContext.session_id === 'string' && hookContext.session_id) {
  env.HOOK_SESSION_ID = hookContext.session_id;
}
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

// #931 — Namespace hint classification moved into gate.cjs (computed by
// prompt-reminder, stored on workflow-state, emitted once by check-before-agent).
var parts = [output.trim()].filter(Boolean);
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
