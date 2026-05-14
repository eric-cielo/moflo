#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

var STATE_DEFAULTS = { tasksCreated: false, taskCount: 0, memorySearched: false, memorySearchedBy: {}, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, simplifySnapshotSha: null, interactionCount: 0, sessionStart: null, lastBlockedAt: null, lastNamespaceHint: '', lastNamespaceHintEmittedBy: {}, flMode: null, swarmInitialized: false, hiveInitialized: false };

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
  var defaults = { memory_first: true, task_create_first: true, context_tracking: true, testing_gate: true, simplify_gate: true, learnings_gate: true, swarm_invocation_gate: true };
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
      if (/swarm_invocation_gate:\s*false/i.test(content)) defaults.swarm_invocation_gate = false;
    }
  } catch (e) { /* use defaults */ }
  return defaults;
}

var config = loadGateConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules', 'moflo.yaml'];
var DANGEROUS = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda'];

// #1132 — Bash memory-first gate.
//
// CREDIT: the legacy detector that marks the gate satisfied when Claude
// manually invokes a memory-search CLI (flo-search, the moflo MCP search via
// shell, etc.). Preserved verbatim from the pre-#1132 behaviour so existing
// recipes keep crediting the gate.
var CREDIT_MEMORY_SEARCH_RE = /semantic-search|memory search|memory retrieve|memory-search/;
// BLOCK: read-like Bash commands that bypass the existing check-before-read /
// check-before-scan gates by going through the shell. Anchored to the start of
// the line so subcommands inside pipelines or `npm install grep` don't trip.
// Covers POSIX read/search tools, Windows cmd `type`, and PowerShell readers.
var READ_LIKE_BASH_RE = new RegExp([
  '^\\s*(?:cat|head|tail|less|more|bat|xxd|od|hexdump)\\b',
  '^\\s*(?:grep|rg|ag|fgrep|egrep|find|fd)\\b',
  '^\\s*sed\\s+-n\\b',
  '^\\s*awk\\s+(?!.*<<)',
  // `type <path>` on Windows. No `$` anchor so a piped form
  // (`type src\foo.ts | grep x`) still matches and gets blocked. Requires at
  // least one non-space argument so shell-builtin usage like `type ls` (which
  // would still false-positive but is an acceptable trade) is differentiated
  // from "no argument" forms.
  '^\\s*type\\s+\\S',
  '^\\s*(?:Get-Content|gc|Select-String|sls)\\b',
].join('|'), 'i');
// CARVE-OUT: commands that LOOK read-like but are operational. Anchored to the
// LEADING command — the pipe-filter case (`npm test | grep FAIL`) is already
// handled by READ_LIKE's `^\s*` anchor never matching the leading `npm`, so
// there is intentionally no pipe arm here: catching the leading command lets
// `grep -r TODO src/ | head -5` reach the BLOCK exit (which it must, that's
// the gap the ticket exists to close). #1132.
var BASH_CARVE_OUT_RE = new RegExp([
  '^\\s*(npm|npx|pnpm|yarn|bun|node|deno|tsx|ts-node)\\s',
  '^\\s*(git|gh|hub)\\s',
  '^\\s*(docker|kubectl|helm|terraform)\\s',
  '^\\s*(curl|wget|http|fetch)\\s',
  '^\\s*(jq|yq|xq)\\s',
  '^\\s*(echo|printf|true|false|sleep|test|\\[)\\s',
  '^\\s*cat\\s+(<<|<<<)',
  '^\\s*cat\\s+[^|]*\\s*>',
  '^\\s*tee\\b',
  // Lazy `.+?` instead of `.+\s` to avoid catastrophic backtracking on long
  // `find` commands that lack a `-delete` / `-exec rm` suffix.
  '^\\s*find\\s+.+?-(delete|exec\\s+rm)\\b',
].join('|'));
var DIRECTIVE_RE = /^(yes|no|yeah|yep|nope|sure|ok|okay|correct|right|exactly|perfect)\b/i;
var TASK_RE = /\b(fix|bug|error|implement|add|create|build|write|refactor|debug|test|feature|issue|security|optimi)\b/i;

// Namespace classification (#931). The hint used to be emitted on every prompt
// by prompt-hook.mjs which cost ~40 tokens × every prompt × every consumer.
// Now we classify here, store on workflow-state, and let check-before-agent
// emit it once when Claude is actually about to spawn an agent.
//
// SYNC: these regexes + classifyNamespaceHint + applyPromptStateReset are
// duplicated verbatim in src/cli/init/helpers-generator.ts (the embedded
// gate.cjs fallback used by `flo init` when source helpers can't be located).
// Any edit to either copy MUST be applied to both — there is no shared module
// because helpers-generator emits a self-contained string template.
var NS_LEARNINGS_RE = /\b(remember|recall|insight|lesson learned|gotcha|post.?mortem)\b|we (decid|agree|chose|said)/;
var NS_TEST_RE = /\b(test|spec|coverage|tested|test case|test cases|tests for|spec for)\b/;
var NS_EXPLICIT = [
  { pattern: /\b(pattern|convention|best practice|style|coding rule)\b/, ns: 'patterns', label: 'code patterns and conventions' },
  { pattern: /\b(code.?map|file structure|project structure|directory)\b/, ns: 'code-map', label: 'codebase navigation' },
];
var NS_PATTERN_RES = [/\b(template|example|similar to|how do we|how should)\b/];
var NS_DOMAIN_RES = [
  /\b(guidance|guide|docs|documentation|rules|how-to)\b/,
  /\b(architecture|design|domain|tenant|migrat|schema|deploy)/,
  /\b(rule|requirement|constraint|compliance)\b/,
];
var NS_NAV_RES = [
  /\b(find|where|which file|look up|locate|endpoint|route|url|path)\b/,
  /\b(class|function|method|component|service|entity|module)\b/,
];

// Detect whether the current prompt invoked /fl or /flo with a swarm/hive flag (#952).
// When set, check-before-agent BLOCKS the Agent spawn until the matching MCP init
// (mcp__moflo__swarm_init or mcp__moflo__hive-mind_init) has been recorded — the user
// explicitly opted in to the protected coordination surface, so falling back to
// raw Agent dispatch silently regresses headline moflo product capability.
//
// SYNC: duplicated verbatim in src/cli/init/helpers-generator.ts.
function detectFlMode(promptText) {
  var p = promptText || '';
  if (!/^\s*\/(?:fl|flo)\b/i.test(p)) return null;
  if (/(?:^|\s)(?:-s|--swarm)\b/.test(p)) return 'swarm';
  if (/(?:^|\s)(?:-h|--hive)\b/.test(p)) return 'hive';
  return null;
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

// Apply per-prompt state reset shared by `prompt-reminder` (full) and
// `prompt-state-reset` (defensive safety-net, no emission). Idempotent — both
// UserPromptSubmit hooks can run it without compounding any field. Caller
// owns interactionCount and the user-visible REMINDER/Context emissions, so
// this helper stays silent.
function applyPromptStateReset(state, promptText) {
  state.memorySearched = false;
  // Wipe per-actor memory tracking too — a new user prompt is a fresh window
  // for both parent AND any subagents the parent may spawn during this turn.
  state.memorySearchedBy = {};
  // learningsStored is session-scoped — once stored, it stays true until session reset.
  // Resetting per-prompt caused false blocks when PR creation was on a later prompt.
  var DIRECTIVE_MAX_LEN = 20;
  var escaped = /^@@\s*/.test(promptText || '');
  state.memoryRequired = !escaped && (promptText || '').length >= 4 && (TASK_RE.test(promptText || '') || (promptText || '').length > DIRECTIVE_MAX_LEN);
  // Stash namespace hint for check-before-agent to emit when Claude actually
  // spawns an Agent (#931). Empty string when nothing matched — overwriting
  // any stale value from the previous prompt.
  state.lastNamespaceHint = classifyNamespaceHint(promptText);
  // Per-actor emission tracking — each subagent's session gets the hint at
  // most once per prompt, but a fresh prompt resets every actor's window so
  // subsequent agents (parent + subagents that spawn their own agents) all
  // see the new classification on their first check-before-agent.
  state.lastNamespaceHintEmittedBy = {};
  // #952 — derive flMode from the user prompt, and reset the matching init
  // flag. Each /fl invocation must call its protected MCP init; the previous
  // prompt's swarm/hive registration does not satisfy this prompt's gate.
  state.flMode = detectFlMode(promptText);
  state.swarmInitialized = false;
  state.hiveInitialized = false;
}
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
// Docs-only PR exemption: text/markup/image extensions that cannot change runtime behaviour.
// If EVERY file in the PR diff matches this, skip testing/simplify/learnings gates.
// Anchored to end-of-path so e.g. `foo.md.js` does not match. Excludes lock files / configs
// on purpose — those are inert for edit-reset (above) but not "documentation".
var DOCS_ONLY_RE = /\.(md|markdown|txt|rst|adoc|html?|pdf|png|jpe?g|gif|svg|webp|ico|bmp)$/i;

// Classifier-aware simplify gate skip. Returns a string reason if the gate
// can be auto-passed, or null if /simplify must run. Uses simplify-classify.cjs
// so the gate's "trivial" definition matches the skill's exactly.
//
// Two paths:
//   1. snapshot path — /simplify ran earlier on this branch. Classify the diff
//      between simplifySnapshotSha and current HEAD/working-tree. If TRIVIAL,
//      the prior review still covers the branch — no re-run needed.
//   2. baseline path — no snapshot (first time). Classify the entire branch
//      diff vs merge-base. If TRIVIAL, the whole PR is below the threshold
//      where /simplify provides value — auto-pass without ever invoking it.
//
// Fail-safe: any error (no classifier, no git, no merge-base) returns null,
// which forces /simplify to run as today.
function classifyForGateSkip(state) {
  var classify;
  try {
    classify = require('./simplify-classify.cjs').classifyDiff;
  } catch (e) { return null; }
  if (typeof classify !== 'function') return null;

  function tryClassify(diffText, label) {
    try {
      var dec = classify(diffText);
      if (dec.tier === 'TRIVIAL') {
        var loc = (dec.stats.added || 0) + (dec.stats.deleted || 0);
        return label + ' is TRIVIAL (' + loc + ' LOC, ' + (dec.stats.fileCount || 0) + ' file(s))';
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  function gitDiff(args) {
    try {
      return cp.execFileSync('git', args, {
        cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 5000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024
      });
    } catch (e) { return null; }
  }

  // Snapshot path: classify everything since /simplify last ran.
  if (state.simplifySnapshotSha) {
    var snapDiff = gitDiff(['diff', state.simplifySnapshotSha + '...HEAD']);
    var workTreeA = gitDiff(['diff', 'HEAD']) || '';
    if (snapDiff !== null) {
      var combined = snapDiff + (workTreeA ? '\n' + workTreeA : '');
      var hit = tryClassify(combined, 'delta since last /simplify');
      if (hit) return hit;
    }
  }

  // Baseline path: classify the whole branch vs merge-base.
  var bases = ['origin/main', 'main', 'origin/master', 'master'];
  for (var i = 0; i < bases.length; i++) {
    var base;
    try {
      base = cp.execFileSync('git', ['merge-base', 'HEAD', bases[i]], {
        cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 2000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (e) { continue; }
    if (!base) continue;
    var branchDiff = gitDiff(['diff', base + '...HEAD']);
    var workTreeB = gitDiff(['diff', 'HEAD']) || '';
    if (branchDiff !== null) {
      return tryClassify(branchDiff + (workTreeB ? '\n' + workTreeB : ''), 'branch diff');
    }
    break;
  }
  return null;
}

// Get the file list changed on the current branch vs the merge-base with origin/main
// (falling back to local main). Returns an array of repo-relative paths, or null on
// failure — in which case callers MUST fall through to the standard gate (fail-safe).
function getChangedFilesVsBase() {
  var bases = ['origin/main', 'main', 'origin/master', 'master'];
  var base = null;
  for (var i = 0; i < bases.length; i++) {
    try {
      base = cp.execFileSync('git', ['merge-base', 'HEAD', bases[i]], {
        cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 2000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (base) break;
    } catch (e) { /* try next */ }
  }
  if (!base) return null;
  try {
    var out = cp.execFileSync('git', ['diff', '--name-only', base + '...HEAD'], {
      cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 2000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  } catch (e) { return null; }
}

switch (command) {
  case 'check-before-agent': {
    // Advisory only — agent spawning is never blocked.
    // Memory-first enforcement happens at the scan/read gate layer.
    // SubagentStart hook injects guidance directive into subagent context.
    //
    // #931 — TaskCreate REMINDER and the namespace hint moved here from
    // prompt-reminder. They only matter when Claude is actually about to spawn
    // an Agent; emitting per-prompt cost ~90 tokens × every prompt × every
    // consumer.
    var s = readState();
    if (config.task_create_first && !s.tasksCreated) {
      process.stdout.write('REMINDER: Use TaskCreate before spawning agents. Task tool is blocked until then.\n');
    }
    if (config.memory_first && s.memoryRequired && !s.memorySearched) {
      process.stdout.write('REMINDER: Search memory (mcp__moflo__memory_search) before spawning agents. On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n');
    }
    if (s.lastNamespaceHint) {
      // Per-actor single-shot. Each session_id gets the hint at most once per
      // prompt, but the hint itself stays available for other actors (e.g.
      // a subagent that spawns its own agent has its own session_id and is
      // entitled to a fresh emission). Falls back to a `_legacy_` bucket when
      // Claude Code didn't forward a session_id (older host or direct CLI
      // invocation), preserving the old "emit once globally" behavior. The
      // map is wiped by applyPromptStateReset on every new prompt.
      var sid = process.env.HOOK_SESSION_ID || '';
      var emittedBy = s.lastNamespaceHintEmittedBy || {};
      var bucket = sid || '_legacy_';
      if (!emittedBy[bucket]) {
        process.stdout.write(s.lastNamespaceHint + '\n');
        emittedBy[bucket] = true;
        s.lastNamespaceHintEmittedBy = emittedBy;
        writeState(s);
      }
    }
    // #952 — when /fl was invoked with -s/-h, the protected MCP init must run
    // BEFORE any Agent spawn. Hard block: the user explicitly opted in to
    // moflo's coordination surface, so silently dispatching `Agent` calls
    // without `mcp__moflo__swarm_init` / `mcp__moflo__hive-mind_init` is the
    // failure mode this gate exists to prevent (CLAUDE.md "⛔ Protected
    // functionality — swarm + hive-mind"). Other Agent uses remain advisory.
    if (config.swarm_invocation_gate) {
      if (s.flMode === 'swarm' && !s.swarmInitialized) {
        process.stderr.write('BLOCKED: /fl was invoked with -s/--swarm but mcp__moflo__swarm_init has not been called.\n');
        process.stderr.write('Run mcp__moflo__swarm_init first, then mcp__moflo__agent_spawn for each role, then dispatch Agent.\n');
        process.stderr.write('See .claude/skills/fl/execution-modes.md "SWARM mode" and CLAUDE.md "⛔ Protected functionality".\n');
        process.stderr.write('Disable via moflo.yaml: gates: swarm_invocation_gate: false\n');
        process.exit(2);
      }
      if (s.flMode === 'hive' && !s.hiveInitialized) {
        process.stderr.write('BLOCKED: /fl was invoked with -h/--hive but mcp__moflo__hive-mind_init has not been called.\n');
        process.stderr.write('Run mcp__moflo__hive-mind_init first, then dispatch Agent or hive-mind workers.\n');
        process.stderr.write('See .claude/skills/fl/execution-modes.md "HIVE-MIND mode" and CLAUDE.md "⛔ Protected functionality".\n');
        process.stderr.write('Disable via moflo.yaml: gates: swarm_invocation_gate: false\n');
        process.exit(2);
      }
    }
    break;
  }
  case 'record-swarm-init': {
    // #952 — wired to mcp__moflo__swarm_init PostToolUse. Marks the gate
    // satisfied so subsequent Agent spawns under /fl -s pass.
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
    if (EXEMPT.some(function(p) { return target.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search. On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n');
    process.exit(2);
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (!s.memoryRequired || isMemorySearchedFor(s)) break;
    var fp = process.env.TOOL_INPUT_file_path || '';
    var isGuidance = fp.indexOf('.claude/guidance/') >= 0 || fp.indexOf('.claude\\guidance\\') >= 0;
    if (!isGuidance && EXEMPT.some(function(p) { return fp.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before reading files. Use mcp__moflo__memory_search. On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n');
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
    // #1132 — preserve CREDIT side-effect AND add a BLOCK arm for read-like
    // Bash commands. Wired as PreToolUse[Bash] (was PostToolUse before #1132)
    // so process.exit(2) actually prevents the read from reaching the shell.
    var cmd = process.env.TOOL_INPUT_command || '';

    // 1) CREDIT — preserved behavior. A real memory-search invocation flips
    // the gate flag so subsequent Read/Grep/Glob within this prompt pass.
    if (CREDIT_MEMORY_SEARCH_RE.test(cmd)) {
      var s = readState();
      if (markMemorySearched(s)) writeState(s);
      break;
    }

    // 2) BLOCK — new behavior. Cheap regex checks come BEFORE readState() so
    // the overwhelming majority of Bash invocations (git/npm/curl/echo/etc.)
    // never touch the filesystem. Order: config flag → command-shape regexes
    // → state read → memory gate.
    if (!config.memory_first) break;
    if (!READ_LIKE_BASH_RE.test(cmd)) break;
    if (BASH_CARVE_OUT_RE.test(cmd)) break;
    var s2 = readState();
    if (!s2.memoryRequired || isMemorySearchedFor(s2)) break;
    process.stderr.write(
      'BLOCKED: Search memory before reading files via Bash. ' +
      'Use mcp__moflo__memory_search. On chunk hits, traverse via ' +
      'mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n' +
      'Disable per-gate via moflo.yaml: gates: memory_first: false\n'
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
    if (skName === 'simplify' || skName === 'flo-simplify') {
      var s = readState();
      var changed = false;
      if (!s.simplifyRun) { s.simplifyRun = true; changed = true; }
      // Snapshot HEAD so check-before-pr can classify delta-since-simplify and
      // skip a redundant /simplify re-run when only trivial fixes followed.
      // Non-fatal — gate falls through to current behaviour without the snapshot.
      try {
        var sha = cp.execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 2000, windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (sha && s.simplifySnapshotSha !== sha) { s.simplifySnapshotSha = sha; changed = true; }
      } catch (e) { /* no git or detached state — skip snapshot, gate still works */ }
      if (changed) writeState(s);
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
    // Docs-only exemption: if every file changed vs the merge-base is a docs/image
    // file (no runtime-behaviour surface), skip the testing/simplify/learnings gates
    // and surface a one-line transparency note. Falls through to the standard gate
    // on any failure (no base, no diff, exec error) — fail-safe by design.
    var changed = getChangedFilesVsBase();
    if (changed && changed.length > 0 && changed.every(function(f) { return DOCS_ONLY_RE.test(f); })) {
      process.stdout.write('Docs-only PR (' + changed.length + ' file' + (changed.length === 1 ? '' : 's') + ') — skipping testing/simplify/learnings gates.\n');
      break;
    }
    var s = readState();
    // Classifier-aware skip: if delta-since-snapshot or whole-branch diff is
    // TRIVIAL, satisfy the simplify gate silently. Reuses the same classifier
    // the skill uses — same "trivial" definition, no drift. Same threshold that
    // already maps to TRIVIAL=0 agents inside /simplify, so trusting it at the
    // gate level is the same trust profile, just one decision earlier.
    if (config.simplify_gate && !s.simplifyRun) {
      var skipReason = classifyForGateSkip(s);
      if (skipReason) {
        s.simplifyRun = true;
        writeState(s);
        process.stdout.write('Simplify gate auto-passed: ' + skipReason + '\n');
      }
    }
    var missing = [];
    if (config.testing_gate && !s.testsRun) missing.push('tests have not run since the last code edit (run npm test, vitest, jest, pytest, or similar)');
    if (config.simplify_gate && !s.simplifyRun) missing.push('/flo-simplify has not run since the last code edit');
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
    // Full per-prompt reset. Wired as the first UserPromptSubmit hook (via
    // prompt-hook.mjs). Owns interactionCount + Context warnings; the
    // TaskCreate REMINDER and namespace hint moved to check-before-agent
    // (#931) so they only fire when Claude is actually about to spawn an
    // Agent.
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
    // Defensive safety-net hook (#931 dedupe). Wired as the second
    // UserPromptSubmit hook so an exception in prompt-hook.mjs doesn't skip
    // the per-prompt state reset. Idempotent — applyPromptStateReset only
    // sets fields to derived values, and we deliberately do NOT increment
    // interactionCount or emit anything (that's prompt-reminder's job).
    //
    // Skip the disk write on the normal path: prompt-reminder runs first and
    // already wrote the byte-identical post-reset state. Only writeState when
    // the reset actually changed something (i.e., prompt-reminder was skipped
    // because prompt-hook.mjs threw before invoking it).
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
    // edit (the defaults object) — the literal that used to live here drifted
    // every time a field was added and is what motivated #952's audit of state
    // shape consistency.
    writeState(Object.assign({}, STATE_DEFAULTS, { sessionStart: new Date().toISOString() }));
    break;
  }
  default:
    break;
}
