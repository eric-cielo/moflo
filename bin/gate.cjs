#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var os = require('os');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

var STATE_DEFAULTS = { tasksCreated: false, taskCount: 0, memorySearched: false, memorySearchedBy: {}, memoryRequired: true, learningsStored: false, testsRun: false, simplifyRun: false, simplifySnapshotSha: null, verifyRun: false, verifyOutcome: null, interactionCount: 0, sessionStart: null, lastBlockedAt: null, lastNamespaceHint: '', lastNamespaceHintEmittedBy: {}, flMode: null, swarmInitialized: false, hiveInitialized: false, sddMode: false, activeSddSlug: null };

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
  // verify_before_done is opt-OUT (default true), like every other gate: #1294
  // ships a real /verify skill and has /flo delegate to it, so leaving it off by
  // default would make the default /flo run silently skip the acceptance check.
  // Disable per-project with `verify_before_done: false` or per-run `--no-verify`.
  var defaults = { memory_first: true, task_create_first: true, context_tracking: true, testing_gate: true, simplify_gate: true, learnings_gate: true, swarm_invocation_gate: true, verify_before_done: true, sdd_gate: true };
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
      // Opt-out: on by default; disable only when explicitly set false.
      if (/verify_before_done:\s*false/i.test(content)) defaults.verify_before_done = false;
      // sdd_gate is the check-before-implement backstop (#1297). Opt-out; the
      // gate only fires when a run is actually armed for SDD (sddMode), so
      // leaving it on costs non-SDD work nothing.
      if (/sdd_gate:\s*false/i.test(content)) defaults.sdd_gate = false;
    }
  } catch (e) { /* use defaults */ }
  return defaults;
}

// Parse the top-level `sdd:` block from moflo.yaml (#1297). Scoped to the block
// body so we never match a `default:` key from another section (epic, merge).
// Cross-platform: tolerates CRLF; no path separators hardcoded.
function loadSddConfig() {
  var out = { default: false, specsDir: '.moflo/specs' };
  try {
    var yamlPath = path.join(PROJECT_DIR, 'moflo.yaml');
    if (!fs.existsSync(yamlPath)) return out;
    var content = fs.readFileSync(yamlPath, 'utf-8');
    var block = content.match(/^sdd:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m);
    if (!block) return out;
    var body = block[1];
    if (/^\s*default:\s*true\b/im.test(body)) out.default = true;
    var sd = body.match(/^\s*specs_dir:\s*(.+?)\s*$/im);
    if (sd) {
      var v = sd[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
      if (v) out.specsDir = v;
    }
  } catch (e) { /* use defaults */ }
  return out;
}

var config = loadGateConfig();
var sddConf = loadSddConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules', 'moflo.yaml'];

// #1294 Finding 3 — reads/scans of EPHEMERAL files under the OS temp dir
// (background-task output/transcripts, agent scratchpads) are transient tool
// I/O and never carry indexable project knowledge, so they must not trip the
// memory-first gate. Cross-platform (Rule #1): os.tmpdir() is correct on every
// OS; we normalize a leading `/private` on both sides so macOS's
// /var/folders (os.tmpdir) vs /private/var/folders (realpath) symlink pair
// still matches (CLAUDE.md #1145). Never hardcode `/tmp`.
function stripPrivate(p) { return p.indexOf('/private/') === 0 ? p.slice('/private'.length) : p; }
function isEphemeralPath(fp) {
  if (!fp) return false;
  var tmp;
  try { tmp = path.resolve(os.tmpdir()); } catch (e) { return false; }
  var t = stripPrivate(tmp);
  function under(p) { var n = stripPrivate(p); return n === t || n.indexOf(t + path.sep) === 0; }
  var resolved = path.resolve(fp);
  if (!under(resolved)) return false;
  // Under tmp by literal path — confirm it isn't a symlink staged in tmp that
  // dereferences to a real project file (realpath BOTH sides, CLAUDE.md Rule #2).
  // On ENOENT (a not-yet-created tmp file) keep the verdict — still ephemeral.
  try { return under(fs.realpathSync(resolved)); } catch (e) { return true; }
}
// #1171 — DANGEROUS gained PowerShell additions to match the matcher widening
// that now routes the dedicated `PowerShell` tool through check-dangerous-command.
// POSIX entries still apply because PS will execute them when invoked. Substring
// match (case-insensitive) inside the gate.
var DANGEROUS = [
  'rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda',
  // PowerShell destructive patterns. Won't catch every adversarial spelling
  // (PS aliases let `ri -r -force C:\` mean the same thing) but covers the
  // common-typo destruction class — symmetric to the POSIX list's intent.
  'remove-item -recurse -force c:\\',
  'remove-item -recurse -force /',
  'remove-item -recurse -force ~',
  'format-volume',
  'clear-disk',
];

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
// #1171 — extended with PowerShell-native exploration forms now that the matcher
// widens to the `PowerShell` tool. Plain `Get-ChildItem` without -Recurse stays
// uncovered (it's `ls`-equivalent and plain `ls` is allowed).
var READ_LIKE_BASH_RE = new RegExp([
  '^\\s*(?:cat|head|tail|less|more|bat|xxd|od|hexdump)\\b',
  '^\\s*(?:grep|rg|ag|fgrep|egrep|find|fd)\\b',
  '^\\s*sed\\s+-n\\b',
  '^\\s*awk\\s+(?!.*<<)',
  // `type <path>` on Windows. No `$` anchor so a piped form
  // (`type src\foo.ts | grep x`) still matches and gets blocked. The argument
  // must contain a slash, backslash, or dot — otherwise it's the shell-builtin
  // command-lookup form (`type ls`, `type cd`) which the gate has no business
  // blocking. False-negative trade: extension-less filenames like `type Makefile`
  // pass through. Acceptable — source files all have extensions, and the
  // primary risk pattern is leaking past the gate via `type src\foo.ts`.
  '^\\s*type\\s+\\S*[\\\\/.]',
  '^\\s*(?:Get-Content|gc|Select-String|sls)\\b',
  // #1171 — PowerShell recursive exploration (parallel to POSIX `find`/`fd`).
  // The `-Recurse` flag is what makes it expensive enough to gate; plain
  // `Get-ChildItem` is `ls`-shaped and intentionally not blocked.
  '^\\s*(?:Get-ChildItem|gci)\\b[^|]*-Recurse\\b',
  // #1171 — cmd-style recursive listing (`dir /s` or `dir /S`). Only the
  // Windows `/s` form, NOT POSIX `dir -s` (sort-by-size, where `dir` is aliased
  // to `ls -l` on many distros) — false-positive blocking that would break
  // legitimate POSIX listings.
  '^\\s*dir\\b[^|]*\\s\\/[sS]\\b',
  // #1171 — PowerShell hex dump, parallel to POSIX `xxd`/`hexdump`.
  '^\\s*Format-Hex\\b',
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
// #1171 follow-up — strip quoted string bodies and heredoc bodies from a shell
// command for purposes of dangerous-pattern substring matching. Used by
// check-dangerous-command. Does NOT strip $(...) or `...` because those bodies
// execute. Double-quoted strings handle escaped quotes (`\"`) correctly so
// `git commit -m "fix \"X\""` strips the whole quoted body, not just the first
// `\"` pair. Single quotes don't have escapes in bash/sh — `'[^']*'` is exact.
function stripQuotedAndHeredocs(cmd) {
  var out = cmd;
  // Heredoc tail: `<<TOKEN`, `<<-TOKEN`, `<<'TOKEN'`, `<<"TOKEN"` through end-of-input.
  // Bash heredocs are multi-line; in single-line tool inputs they show up as the
  // tail after `<<TOKEN`. Conservative tail-strip — benign content after a heredoc
  // body on the same logical line is also stripped, harmless for this gate.
  // Token class includes `-` so hyphenated heredoc tags (`<<END-OF-DOC`) match
  // the full token, not just the leading word — without this the strip would
  // halt at `<<END` and leave `-OF-DOC` plus the body as literal text.
  out = out.replace(/<<-?\s*['"]?[\w-]+['"]?[\s\S]*$/, '');
  // Here-string `<<<word` — strip the word.
  out = out.replace(/<<<\s*\S+/g, '');
  // Single-quoted strings — no escapes inside single quotes in sh/bash.
  out = out.replace(/'[^']*'/g, "''");
  // Double-quoted strings — `(?:[^"\\]|\\.)*` matches anything except an
  // unescaped `"`, so escaped `\"` mid-string doesn't terminate the strip early.
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return out;
}

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

// #1297 — arm the SDD implement gate from the user prompt. Only /fl or /flo runs
// can arm it. Explicit -sd/--sdd wins; --no-sdd disarms; otherwise honor the
// sdd.default config. `-sd` is a distinct token from `-s` (swarm): the `d` sits
// on the word boundary so `-s\b` never matches `-sd`.
function detectSddMode(promptText) {
  var p = promptText || '';
  if (!/^\s*\/(?:fl|flo)\b/i.test(p)) return false;
  if (/(?:^|\s)--no-sdd\b/.test(p)) return false;
  if (/(?:^|\s)(?:-sd|--sdd)\b/.test(p)) return true;
  return !!sddConf.default;
}

// Resolve the absolute specs root the same way TS specsRoot does (#1294): split
// the /-written config value on either separator, reject absolute/`..`-escaping
// values, and fall back to the gitignored default. Rule #1: no separator hardcoded.
function sddSpecsRootAbs() {
  var configured = (sddConf.specsDir || '.moflo/specs');
  var segments = configured.split(/[\\/]+/).filter(Boolean);
  var escapes = segments.length === 0
    || segments.indexOf('..') >= 0
    || /^([a-zA-Z]:|~)$/.test(segments[0])
    || configured.charAt(0) === '/'
    || configured.charAt(0) === '\\';
  if (escapes) return path.join(PROJECT_DIR, '.moflo', 'specs');
  return path.join.apply(path, [PROJECT_DIR].concat(segments));
}

// Is the edited path inside the specs dir? Editing spec.md/plan.md themselves must
// never trip the implement gate. Compares resolved absolute paths (Rule #1: the
// edit path may be relative or absolute; normalize both before the prefix test).
function isInsideSpecsDir(filePath) {
  try {
    var root = sddSpecsRootAbs();
    var abs = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_DIR, filePath);
    var rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (e) { return false; }
}

// Read plan.md frontmatter for the active slug and report whether it is reviewed.
// Pure fs + regex (no spawn) so it stays cheap on every Write/Edit. Matches the
// double-quoted scalar serializeArtifact emits (`status: "reviewed"`).
function isPlanReviewed(slug) {
  try {
    var planPath = path.join(sddSpecsRootAbs(), slug, 'plan.md');
    if (!fs.existsSync(planPath)) return false;
    var content = fs.readFileSync(planPath, 'utf-8').replace(/\r\n/g, '\n');
    var fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return false;
    return /^\s*status:\s*["']?reviewed["']?\s*$/im.test(fm[1]);
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
// Used when the prompt-derived `lastNamespaceHint` is empty (e.g. subagents,
// which never see the user prompt) so the block message still routes to a
// useful namespace rather than the generic "pick one of five" list. Returns a
// full sentence in the same shape as classifyNamespaceHint so the BLOCK arm
// can write either source's hint without branching on format.
//
// SYNC: duplicated verbatim in src/cli/init/helpers-generator.ts.
function classifyBashNamespaceHint(cmd) {
  // Search-like tools — the user is hunting for a symbol/file, code-map wins.
  if (/^\s*(?:grep|rg|ag|fgrep|egrep|find|fd|Select-String|sls)\b/i.test(cmd)) {
    return 'Memory namespace hint: use "code-map" for codebase navigation.';
  }
  // Reading a .md / RST / TXT, or a well-known doc file — guidance/learnings win.
  // `.*` (not `\S*`) so flag-prefixed forms like `head -50 README.md` match.
  // Anchored on the leading reader so a piped `cmd | grep foo.md` doesn't trip.
  if (/^\s*(?:cat|head|tail|less|more|bat|type|Get-Content|gc)\b.*\.(?:md|mdx|rst|txt)\b/i.test(cmd)
   || /^\s*(?:cat|head|tail|less|more|bat|type|Get-Content|gc)\b.*\b(?:README|CLAUDE|CHANGELOG|CONTRIBUTING|LICENSE)\b/i.test(cmd)) {
    return 'Memory namespace hint: search "guidance" and "learnings" for project rules and decisions.';
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
  // #1297 — arm/disarm the SDD implement gate per prompt. A fresh /flo run starts
  // with no active slug; `flo sdd spec` stamps activeSddSlug during the run.
  state.sddMode = detectSddMode(promptText);
  state.activeSddSlug = null;
}
// Match npm/yarn/pnpm/bun test, npx vitest|jest|..., bare runners at command-start only,
// and language-native test commands. The bare-runner arm is anchored so that
// `npm install jest`, `grep -r vitest src/`, and similar don't false-positive.
var TEST_RUNNER_RE = /(?:^|[^a-z])(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|t)(?:[:\s]|$)|\b(?:npx|pnpx)\s+(?:vitest|jest|mocha|ava|tap|jasmine|pytest)\b|(?:^|;|&&|\|\|)\s*(?:vitest|jest|pytest|mocha|jasmine|tap|ava)\s|\b(?:cargo|go|deno|dotnet|mvn)\s+test\b|\bgradle\w*\s+test\b/i;
// Edits to these don't change runtime behaviour, so they don't invalidate prior test/simplify runs.
// Lock files and .gitignore are tracked but inert; package.json/*.yaml ARE source — they reset.
var EDIT_RESET_SKIP_BOTH_RE = /\.(md|markdown|txt|rst|adoc|lock|gitignore)$|(?:^|[\\\/])(CHANGELOG(?:\.md)?|\.env\.example|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;
// #1176 — path-based inert markers. The extension-based RE above can't cover
// `.github/workflows/*.yml` without also exempting `moflo.yaml` / `tsconfig.yaml`
// (which ARE source). Anchor on the GitHub-meta directories that hold CI config
// and template scaffolds — editing those doesn't expose new runtime surface, so
// they shouldn't reset testsRun/simplifyRun the way a real source edit does.
// Trailing terminator includes `.` so the single-file template form
// `.github/PULL_REQUEST_TEMPLATE.md` matches alongside the directory form.
var EDIT_RESET_SKIP_PATH_RE = /(?:^|[\\\/])\.github[\\\/](?:workflows|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)(?:[\\\/.]|$)/i;
// Test files: invalidate the testing gate (tests are stale once test code changes)
// but NOT the simplify gate — /simplify already reviewed the production code; touching
// a test file or fixture doesn't expose new untested surface for code review (#908).
var EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE = /(?:^|[\\\/])(__tests__|__mocks__|tests?|spec|specs|cypress|e2e|fixtures?)[\\\/]|\.(test|spec)\.[mc]?[jt]sx?$|\.fixture\.[mc]?[jt]sx?$/i;
// #1176 — source-file extensions used by the no-source-files PR exemption.
// When the cumulative branch diff has zero files matching this RE (i.e. only
// YAML/MD/JSON/lockfiles/images/templates), the testing/simplify/learnings
// gates auto-pass at `check-before-pr`. Lists every language moflo ships
// against — additions here should match TEST_RUNNER_RE's language coverage.
var SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|ps1)$/i;
// Docs-only PR exemption: text/markup/image extensions that cannot change runtime behaviour.
// Retained for the transparency message when the diff is *purely* docs (no YAML/JSON either)
// — gives a more specific reason than "no source files" in that subset.
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

  function tryClassify(diffText, label, allowSmallReviewFix) {
    try {
      var dec = classify(diffText);
      if (dec.tier === 'TRIVIAL') {
        var loc = (dec.stats.added || 0) + (dec.stats.deleted || 0);
        return label + ' is TRIVIAL (' + loc + ' LOC, ' + (dec.stats.fileCount || 0) + ' file(s))';
      }
      // #1176 — SMALL review-fix shape (snapshot path only). A ≤30-LOC delta with
      // zero new declarations on top of an already-reviewed branch is the typical
      // "apply 3 review fixes" cycle — re-running /flo-simplify against the same
      // surface plus a few-line tweak adds no new signal. Baseline path stays
      // TRIVIAL-only so brand-new SMALL features still get reviewed.
      if (allowSmallReviewFix && dec.tier === 'SMALL') {
        var totalLoc = (dec.stats.added || 0) + (dec.stats.deleted || 0);
        if (totalLoc <= 30 && (dec.stats.declAdded || 0) === 0) {
          return label + ' is SMALL review-fix shape (' + totalLoc + ' LOC, no new declarations)';
        }
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
      // Snapshot path: allow SMALL review-fix shape because the original /simplify
      // already covered the surface and only tiny no-decl-touching tweaks followed.
      var hit = tryClassify(combined, 'delta since last /simplify', true);
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
    if (isEphemeralPath(process.env.TOOL_INPUT_path)) break;
    if (EXEMPT.some(function(p) { return target.indexOf(p) >= 0; })) break;
    process.stderr.write('BLOCKED: Search memory before exploring files. Use mcp__moflo__memory_search. On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n');
    process.exit(2);
  }
  case 'check-before-read': {
    if (!config.memory_first) break;
    var s = readState();
    if (!s.memoryRequired || isMemorySearchedFor(s)) break;
    var fp = process.env.TOOL_INPUT_file_path || '';
    // Ephemeral tmp/scratch reads are exempt even when they look like guidance
    // (a temp copy is still transient tool I/O, not the indexed source).
    if (isEphemeralPath(fp)) break;
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
    //
    // #1171 — the case name is historical. The matcher now also covers the
    // dedicated `PowerShell` tool, and READ_LIKE_BASH_RE already matched PS
    // readers (Get-Content/Select-String/Get-ChildItem -Recurse/Format-Hex).
    // Treat this case as shell-agnostic read-gate logic.
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
    // Hint precedence: prompt-derived classification (set by applyPromptStateReset
    // from the user prompt text) → command-shape classification (works for
    // subagents that never saw the user prompt). Either source returns a full
    // "Memory namespace hint: ..." sentence so the BLOCK message stays uniform.
    var hint = s2.lastNamespaceHint || classifyBashNamespaceHint(cmd) || '';
    process.stderr.write(
      'BLOCKED: Search memory before reading files via Bash.\n' +
      'Example: mcp__moflo__memory_search { query: "<topic>", namespace: "<one of: guidance | code-map | patterns | learnings | tests>" }\n' +
      (hint ? hint + '\n' : '') +
      'On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n' +
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
    } else if (cmd) {
      // #1176 — emit a stderr crumb when invoked with a non-empty command that
      // doesn't match the test-runner pattern. Common pitfall: users run the
      // stamp manually from a terminal to "satisfy the gate"; the silent no-op
      // looks indistinguishable from success. gate-hook.mjs drops stderr from
      // exit-0 invocations, so this only surfaces to direct CLI use — exactly
      // the case where the friction lives.
      var preview = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      process.stderr.write('gate: record-test-run no-op — TOOL_INPUT_command="' + preview + '" did not match TEST_RUNNER_RE\n');
    }
    break;
  }
  case 'record-skill-run': {
    var skName = (process.env.TOOL_INPUT_skill || '');
    if (skName === 'simplify' || skName === 'flo-simplify' || skName === 'distill') {
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
    } else if (skName) {
      // #1176 — same rationale as record-test-run. A no-op stamp on a non-simplify
      // skill name is silent to hooks (gate-hook.mjs drops exit-0 stderr) but
      // visible when a user runs the stamp directly to "satisfy the gate" and
      // wonders why simplifyRun stays false.
      process.stderr.write('gate: record-skill-run no-op — TOOL_INPUT_skill="' + skName + '" is not simplify/flo-simplify\n');
    }
    break;
  }
  case 'record-verify-run': {
    // Story #1274 (Epic #1269). Fires PostToolUse on ^Skill$ when the native
    // /verify skill runs, satisfying the verify-before-done gate. Mirrors
    // record-skill-run's fault-tolerant shape. The verification OUTCOME (what
    // was checked, pass/fail) is written to memory by the verify flow itself
    // via mcp__moflo__memory_store — same division of labour as testsRun vs the
    // test output; this recorder only tracks that verification happened.
    var vName = (process.env.TOOL_INPUT_skill || '');
    // Only the native /verify skill satisfies verify-before-done. /ward and
    // /quicken are targeted audits, NOT the completion gate (see fl/sdd.md) —
    // crediting them would let the gate pass without an end-to-end verify.
    if (vName === 'verify') {
      var s = readState();
      if (!s.verifyRun) { s.verifyRun = true; writeState(s); }
    } else if (vName) {
      process.stderr.write('gate: record-verify-run no-op — TOOL_INPUT_skill="' + vName + '" is not verify\n');
    }
    break;
  }
  case 'reset-edit-gates': {
    var fp = process.env.TOOL_INPUT_file_path || '';
    // Inert files (markdown, lockfiles, CHANGELOG, .env.example) AND inert paths
    // (.github/workflows/, .github/ISSUE_TEMPLATE/, .github/PULL_REQUEST_TEMPLATE/, #1176):
    // no gate reset — editing these doesn't expose new runtime surface.
    if (fp && (EDIT_RESET_SKIP_BOTH_RE.test(fp) || EDIT_RESET_SKIP_PATH_RE.test(fp))) break;
    var s = readState();
    // Test-only edits invalidate testsRun but preserve simplifyRun (#908).
    var isTestOnly = fp && EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE.test(fp);
    var resetTests = s.testsRun;
    // A code edit invalidates a prior verification (Story #1274) — same as tests,
    // including test-only edits (the criteria being verified may have moved).
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
    // #1297 — the SDD front-half backstop. When a run is armed for SDD
    // (sddMode, set from -sd/--sdd or sdd.default on a /flo run), block source
    // Write/Edit until a spec exists and its plan is reviewed. Mirrors the
    // memory_first gate shape. Disarmed runs (the default for non-SDD work)
    // pass instantly. Opt out per-project with `gates: sdd_gate: false`.
    if (!config.sdd_gate) break;
    var si = readState();
    if (!si.sddMode) break; // not an SDD run — no enforcement
    var fpi = process.env.TOOL_INPUT_file_path || '';
    if (!fpi) break;
    // Only gate real source edits. Exempt the same inert files/paths the other
    // gates skip, plus the spec/plan artifacts themselves.
    if (EXEMPT.some(function (e) { return fpi.indexOf(e) >= 0; })) break;
    if (!SOURCE_FILE_RE.test(fpi)) break;
    if (EDIT_RESET_SKIP_PATH_RE.test(fpi)) break;
    if (isInsideSpecsDir(fpi)) break;
    if (!si.activeSddSlug) {
      process.stderr.write(
        'BLOCKED: SDD mode is on — author a spec before editing source.\n' +
        'Run: flo sdd spec "<title>"   (then review it, and plan)\n' +
        'This run is spec-gated (-sd / sdd.default). One-off skip: re-run with --no-sdd.\n' +
        'Disable per-project via moflo.yaml: gates: sdd_gate: false\n'
      );
      process.exit(2);
    }
    if (!isPlanReviewed(si.activeSddSlug)) {
      process.stderr.write(
        'BLOCKED: SDD — the plan for "' + si.activeSddSlug + '" is not reviewed yet.\n' +
        'Author + review the plan first:\n' +
        '  flo sdd plan ' + si.activeSddSlug + '\n' +
        '  flo sdd review ' + si.activeSddSlug + ' plan\n' +
        'One-off skip: re-run with --no-sdd. Disable via moflo.yaml: gates: sdd_gate: false\n'
      );
      process.exit(2);
    }
    break;
  }
  case 'check-before-pr': {
    // Anchored to command-start (or chained via && / || / ;) so heredoc bodies
    // and quoted strings that contain the literal "gh pr create" don't trip
    // the gate during regular `git commit -m "...gh pr create..."` flows. The
    // optional ENV=val prefix segment catches `GH_TOKEN=x gh pr create`.
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!/(?:^|&&\s*|\|\|\s*|;\s*)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/.test(cmd)) break;
    // No-source-files exemption (#1176, supersedes the original docs-only path).
    // If every file changed vs the merge-base is either a docs/image file or a
    // path-inert file (.github/workflows/, ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE/)
    // — i.e. NO source files in the diff — skip testing/simplify/learnings gates
    // and surface a one-line transparency note. Falls through to the standard gate
    // on any failure (no base, no diff, exec error) — fail-safe by design.
    //
    // Source-file detection is the inverse of the inert checks: a file is "source"
    // when it matches SOURCE_FILE_RE AND is not inside an inert path. This catches
    // `.github/workflows/foo.sh` (sh extension but path-inert → no source).
    var changed = getChangedFilesVsBase();
    if (changed && changed.length > 0) {
      var hasSource = changed.some(function(f) {
        return SOURCE_FILE_RE.test(f) && !EDIT_RESET_SKIP_PATH_RE.test(f);
      });
      if (!hasSource) {
        var allDocs = changed.every(function(f) { return DOCS_ONLY_RE.test(f); });
        var reason = allDocs ? 'Docs-only' : 'No source files in branch diff';
        process.stdout.write(reason + ' (' + changed.length + ' file' + (changed.length === 1 ? '' : 's') + ') — skipping testing/simplify/learnings gates.\n');
        break;
      }
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
    if (config.simplify_gate && !s.simplifyRun) missing.push('/flo-simplify (or /distill) has not run since the last code edit');
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
  case 'check-before-done': {
    // Story #1274 (Epic #1269) + #1294. Verify-before-done: block `gh pr create`
    // until the change has been verified end-to-end (the /verify skill) against
    // the plan's acceptance criteria. ON by default (#1294) — /flo delegates to
    // /verify, so a default run does the acceptance check; disable per-project
    // with `gates: verify_before_done: false` or per-run `--no-verify`. Same
    // trigger + no-source exemption as check-before-pr, so they compose on one
    // command (docs-only diffs are exempt, so this never blocks a docs PR).
    if (!config.verify_before_done) break;
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!/(?:^|&&\s*|\|\|\s*|;\s*)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/.test(cmd)) break;
    // No-source-files exemption — a docs-only / path-inert diff needs no verify.
    var changedD = getChangedFilesVsBase();
    if (changedD && changedD.length > 0) {
      var hasSourceD = changedD.some(function(f) {
        return SOURCE_FILE_RE.test(f) && !EDIT_RESET_SKIP_PATH_RE.test(f);
      });
      if (!hasSourceD) {
        var reasonD = changedD.every(function(f) { return DOCS_ONLY_RE.test(f); }) ? 'Docs-only' : 'No source files in branch diff';
        process.stdout.write(reasonD + ' (' + changedD.length + ' file' + (changedD.length === 1 ? '' : 's') + ') — skipping verify-before-done gate.\n');
        break;
      }
    }
    var sd = readState();
    if (sd.verifyRun) break;
    process.stderr.write('BLOCKED: gh pr create requires verification before done:\n');
    process.stderr.write('  - the change has not been verified since the last code edit (run /verify)\n');
    if (sd.lastResetBy && sd.lastResetBy.file && (sd.lastResetBy.gates || []).indexOf('verify') >= 0) {
      process.stderr.write('Last gate reset: ' + sd.lastResetBy.file + ' (verify)\n');
    }
    process.stderr.write('Disable via moflo.yaml:\n');
    process.stderr.write('  gates:\n    verify_before_done: false\n');
    process.exit(2);
  }
  case 'check-dangerous-command': {
    // #1171 follow-up — strip quoted string bodies and heredoc bodies before
    // substring-matching DANGEROUS. Without this, `git commit -m "...remove-item
    // -recurse -force c:\..."` blocks because the literal pattern appears in
    // the quoted message body. Quoted text isn't executing — the gate's job is
    // to catch typo-class destruction in the actual command, not text mentions
    // inside arguments. Trade-off: `bash -c "rm -rf /"` also bypasses now; the
    // gate is a typo safety net, not a security boundary, so this is acceptable.
    // Command substitutions `$(...)` and backticks are NOT stripped — those
    // bodies execute and dangerous content there is real.
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
