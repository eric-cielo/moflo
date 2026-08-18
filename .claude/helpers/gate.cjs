#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var os = require('os');
var crypto = require('crypto');

var PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var STATE_FILE = path.join(PROJECT_DIR, '.claude', 'workflow-state.json');

// testsFingerprint / simplifyFingerprint / verifyFingerprint pin each credit to
// the code it describes, so a change made outside Write/Edit/MultiEdit (a Bash
// write, a branch switch, the next issue in the same session) invalidates it.
// See creditFingerprint() for why the boolean flags alone cannot.
var STATE_DEFAULTS = { tasksCreated: false, taskCount: 0, tasksAcknowledged: false, memorySearched: false, memorySearchedBy: {}, memoryRequired: true, learningsStored: false, testsRun: false, testsFingerprint: null, simplifyRun: false, simplifySnapshotSha: null, simplifyFingerprint: null, verifyRun: false, verifyOutcome: null, verifyFingerprint: null, interactionCount: 0, sessionStart: null, lastBlockedAt: null, lastNamespaceHint: '', lastNamespaceHintEmittedBy: {}, flMode: null, swarmInitialized: false, hiveInitialized: false, sddMode: false, activeSddSlug: null };

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
  // task_status_gate is a MODE, not a boolean: 'block' | 'warn' | 'off' (#1435).
  // #1374 shipped the open-task count as a warn-only stdout line, and a consumer
  // still shipped a PR over four untouched tasks — a reminder that survived ten
  // consecutive ignores in one session is not a control. Blocking is the default
  // because the honest "these stay open on purpose" outcome is one command away
  // (record-tasks-acknowledged), so nothing here can deadlock a run.
  var defaults = { memory_first: true, task_create_first: true, context_tracking: true, testing_gate: true, simplify_gate: true, learnings_gate: true, swarm_invocation_gate: true, verify_before_done: true, sdd_gate: true, task_status_gate: 'block' };
  var content = MOFLO_YAML;
  if (content) {
    // Boolean forms are accepted so this key reads like every other gate in the
    // block: `false` is the same opt-out `testing_gate: false` is, `true` means
    // enforce. Anything unrecognised falls through to the default rather than
    // silently disabling the gate — a typo must not be a stealth opt-out.
    var tsg = /task_status_gate:\s*['"]?(block|warn|off|false|true)['"]?/i.exec(content);
    if (tsg) {
      var mode = tsg[1].toLowerCase();
      defaults.task_status_gate = mode === 'false' ? 'off' : mode === 'true' ? 'block' : mode;
    }
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
  return defaults;
}

// Parse the top-level `sdd:` block from moflo.yaml (#1297). Scoped to the block
// body so we never match a `default:` key from another section (epic, merge).
// Cross-platform: tolerates CRLF; no path separators hardcoded.
function loadSddConfig() {
  var out = { default: false, specsDir: '.moflo/specs' };
  var content = MOFLO_YAML;
  if (!content) return out;
  var block = content.match(/^sdd:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m);
  if (!block) return out;
  var body = block[1];
  if (/^\s*default:\s*true\b/im.test(body)) out.default = true;
  var sd = body.match(/^\s*specs_dir:\s*(.+?)\s*$/im);
  if (sd) {
    var v = sd[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (v) out.specsDir = v;
  }
  return out;
}

// Parse the top-level `merge:` block from moflo.yaml (#1285). Block-scoped for
// the same reason as loadSddConfig: a bare `auto:` key can appear under other
// sections. Cross-platform: tolerates CRLF.
function loadMergeConfig() {
  var out = { auto: false };
  var content = MOFLO_YAML;
  if (!content) return out;
  var block = content.match(/^merge:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m);
  if (!block) return out;
  if (/^\s*auto:\s*true\b/im.test(block[1])) out.auto = true;
  return out;
}

// Read moflo.yaml exactly once per gate process (#1297 review): loadGateConfig
// and loadSddConfig both parse it, and the gate fires on every Write/Edit — a
// second read is wasted syscalls. Single readFileSync in try/catch (no existsSync
// double-stat); ENOENT/unreadable → '' → every parser falls back to defaults.
function readMofloYaml() {
  try { return fs.readFileSync(path.join(PROJECT_DIR, 'moflo.yaml'), 'utf-8'); }
  catch (e) { return ''; }
}
var MOFLO_YAML = readMofloYaml();

// #1394 — is the hook that transcribes /verify's verdict into workflow-state.json
// actually wired? Distinguishes "the agent skipped Step 5" from "nothing exists
// to record the verdict", which need opposite remedies: the first is fixed by
// re-running /verify, the second cannot be.
//
// Deliberately NOT hoisted to module scope like MOFLO_YAML: this is only ever
// consulted on an already-blocked check-before-done path, so reading it eagerly
// would add a syscall to every Write/Edit to answer a question almost no gate
// invocation asks. Substring match (not a JSON walk) so it holds regardless of
// which matcher block a consumer's hook lives in, or how they hand-edited it.
// Unreadable/malformed settings → true, so a parse failure falls back to the
// pre-existing generic message rather than asserting a wiring bug that may not
// exist.
function isVerifyOutcomeHookWired() {
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, '.claude', 'settings.json'), 'utf-8')
      .indexOf('record-verify-outcome') >= 0;
  } catch (e) { return true; }
}

var config = loadGateConfig();
var sddConf = loadSddConfig();
var mergeConf = loadMergeConfig();
var command = process.argv[2];

var EXEMPT = ['.claude/', '.claude\\', 'CLAUDE.md', 'MEMORY.md', 'workflow-state', 'node_modules', 'moflo.yaml'];

// Appended to every memory-first denial. Without it, a context audit of Claude
// Code's denial telemetry reads moflo's gate enforcements as permission-setup
// failures and "fixes" them with allow rules — which cannot override a hook
// block at all (#1307 finding 5). Naming the gate makes the cause self-evident.
var GATE_ORIGIN_NOTE = 'This is a moflo hook, not a Claude Code permission rule — allow-rules cannot override it.';

// #1348 — the pre-PR gates are order-dependent and each block message named only
// its own missing gate, so a caller could satisfy them one at a time forever:
// /flo-simplify may edit code (which resets tests and verify), and /verify must
// not, so simplify strictly precedes verify. Both blocking gates print this.
// /verify's Step 5 memory_store carries the verdict AND stamps learnings, which
// is why learnings has no separate step here.
var ORDER_HINT = 'Order that satisfies all of them: tests green -> /flo-simplify (re-run tests if it edits) -> /verify -> its memory_store verdict -> gh pr create\n';
// #1434 — the old text ('learnings have not been stored (call memory_store)')
// named the mechanism but no quality bar, so the cheapest way past it was a
// summary of the run — audit exhaust that displaces reusable lessons from every
// future bounded search. Name the bar AND the no-write path here: an escape
// hatch nobody can find is not an escape hatch (see #1332's gate deadlock).
//
// The escape command is built from __filename, not written as a relative path.
// The caller is the model typing into a Bash tool, NOT a hook: $CLAUDE_PROJECT_DIR
// is unset there (so the settings.json form would expand to "/.claude/..."), and a
// bare `.claude/helpers/gate.cjs` breaks from any cwd but the project root. The
// running script's own absolute path is correct on every OS and from any cwd;
// double quotes carry Windows separators and spaces through the shell.
var LEARNINGS_MISSING =
  'no durable lesson recorded. A lesson qualifies only if it would help a future session ' +
  'working on a DIFFERENT task — a reusable pattern, a trap, a decision + rationale. ' +
  'Store one with mcp__moflo__memory_store (namespace "learnings"; use "patterns" for a ' +
  'reusable code shape). What THIS run changed is git history — it belongs in the PR body, ' +
  'not in memory. If this run taught nothing new, say so instead of inventing one: ' +
  'node "' + __filename + '" record-no-durable-lesson';
var GATE_DISABLE_NOTE = 'Disable per-gate via moflo.yaml: gates: memory_first: false';
// #1338 — Claude Code spawns stdio MCP servers once at session start and never
// respawns them, so a session can outlive its moflo MCP connection. Naming only
// mcp__moflo__memory_search there points the reader at the one thing that cannot
// work; this CLI path credits the gate identically and needs no MCP.
var MCP_FALLBACK_NOTE = 'If mcp__moflo__* tools are unavailable this session (MCP server not connected), this credits the gate too: npx flo memory search --query "<topic>" --namespace <ns>';
// #1338 follow-up — the swarm/hive gate's equivalent. The CLI runs the same
// in-process handler and persists the swarm, so it satisfies this gate for
// real; it is recorded only on success (PostToolUse, #1322).
var COORD_FALLBACK_NOTE = 'If mcp__moflo__* tools are unavailable this session (MCP server not connected), this satisfies the gate too:';

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
// POSIX entries still apply because PS will execute them when invoked. Matched
// case-insensitively by `matchesDangerous` below — substring for most entries,
// root-anchored for the ones that end at a filesystem root.
var DANGEROUS = [
  'rm -rf /', 'rm -rf ~', 'format c:', 'del /s /q c:\\', ':(){:|:&};:', 'mkfs.', '> /dev/sda',
  // PowerShell destructive patterns. Won't catch every adversarial spelling
  // (PS aliases let `ri -r -force C:\` mean the same thing) but covers the
  // common-typo destruction class — symmetric to the POSIX list's intent.
  'remove-item -recurse -force c:\\',
  'remove-item -recurse -force /',
  'remove-item -recurse -force ~',
  'format-volume',
  'clear-disk',
];

// #1449 — the entries above that END at a filesystem root are also a PREFIX of
// every absolute path beneath it, so plain substring matching blocked routine
// cleanup: `rm -rf /tmp/scratch` reported as `rm -rf /`. Those entries must
// match ON the root rather than at the head of a longer path.
//
// WHICH entries those are is derived, not listed: a pattern is root-shaped iff
// it ends at a root — a separator or `~`. That selects `rm -rf /`, `rm -rf ~`,
// `del /s /q c:\` and the three `remove-item` forms, and leaves `format c:`,
// `mkfs.`, `> /dev/sda`, `format-volume` and `clear-disk` on plain substring
// matching, where trailing text is still the same dangerous command. Deriving
// it rather than keeping a parallel list means a future root-shaped addition to
// DANGEROUS is anchored automatically instead of silently falling back to the
// prefix bug this fixes.
//
// `rm -rf ~` joins DANGEROUS with this change: it was never listed, so wiping a
// home directory was allowed outright while cleaning a subdirectory of one was
// blocked. Anchoring is what makes the entry safe to add.
function endsAtRoot(pat) {
  var last = pat.charAt(pat.length - 1);
  return last === '/' || last === '\\' || last === '~';
}
// What may legally follow a root target: nothing, whitespace, a glob (`rm -rf /*`
// still blocks), a shell operator, or a closing quote/paren. A path character —
// letter, digit, `-`, `_` — means another segment follows, i.e. routine cleanup
// of something below root. Rule #1: pure string logic, no platform branch; both
// separators are handled for every OS's spelling.
var ROOT_BOUNDARY_RE = /[\s;&|)"'`*<>]/;
function isRootBoundary(cmd, i) {
  if (i >= cmd.length) return true;
  var c = cmd.charAt(i);
  return c === '/' || c === '\\' || ROOT_BOUNDARY_RE.test(c);
}

/**
 * Advance past text that does not move OFF the root: repeated separators, and
 * `.` / `..` segments, which resolve back to where they started. `rm -rf //`,
 * `rm -rf /.` and `rm -rf /..` all still mean `rm -rf /` and must block, while
 * `rm -rf //tmp/x` and `rm -rf /.config` are real paths below root and must not.
 * Without the dot handling the anchoring would OPEN a hole the substring match
 * did not have — `.` is not a boundary character, so `rm -rf /.` would read as
 * "a longer path follows" and pass.
 */
function skipToRootEnd(cmd, i) {
  for (;;) {
    var start = i;
    while (i < cmd.length && (cmd.charAt(i) === '/' || cmd.charAt(i) === '\\')) i++;
    var dots = 0;
    while (cmd.charAt(i + dots) === '.') dots++;
    // Only a BARE `.` or `..` segment is a no-op; `.config` and `..foo` are names.
    if ((dots === 1 || dots === 2) && isRootBoundary(cmd, i + dots)) i += dots;
    if (i === start) return i;
  }
}

/**
 * True when `pat` occurs in `cmd` as a real dangerous command. Root-shaped
 * patterns must land on the root; every occurrence is examined, so a safe
 * leading match (`rm -rf /tmp/a && rm -rf /`) never masks a later real one.
 */
function matchesDangerous(cmd, pat) {
  if (!endsAtRoot(pat)) return cmd.indexOf(pat) >= 0;
  for (var at = cmd.indexOf(pat); at >= 0; at = cmd.indexOf(pat, at + 1)) {
    var end = skipToRootEnd(cmd, at + pat.length);
    if (end >= cmd.length || ROOT_BOUNDARY_RE.test(cmd.charAt(end))) return true;
  }
  return false;
}

// #1132 — Bash memory-first gate.
//
// CREDIT: marks the gate satisfied when Claude invokes a memory-search CLI
// (`flo memory search`, `flo-search`, `semantic-search.mjs`) from the shell —
// the escape hatch that keeps the gate satisfiable when the moflo MCP server
// is not connected to the session.
//
// #1338 — this used to be an unanchored substring test
// (/semantic-search|memory search|memory retrieve|memory-search/) against the
// whole command, so `echo "memory search"` — or a `git commit -m` mentioning
// the phrase — satisfied the gate for the rest of the prompt. That is the
// opposite discipline from READ_LIKE_BASH_RE directly below, which is
// deliberately anchored. Credit now requires a real INVOCATION, matched by
// BASENAME so Rule #1 holds: `flo`, `flo.cmd`, `npx.cmd flo`, `node ./bin/cli.js`
// and `node C:\...\bin\cli.js` all credit, with either path separator.
var CREDIT_RUNNER_RE = /^(?:npx|npm|pnpm|yarn|bun|bunx|deno|node|nodejs|tsx|ts-node)(?:\.(?:cmd|exe|bat|ps1))?$/i;
// Sub-words of a runner invocation that are not the entrypoint itself
// (`pnpm dlx flo`, `npm exec -- flo`, `npx -y flo`).
var CREDIT_RUNNER_SKIP_RE = /^(?:dlx|exec|run|-y|--yes|-q|--quiet|--silent|--no-install|--)$/i;
// The moflo CLI, under every name package.json binds it to (plus the raw entry
// script, for `node node_modules/moflo/bin/cli.js`).
var CREDIT_CLI_RE = /^(?:flo|moflo|claude-flow|cli\.js|cli\.mjs)(?:\.(?:cmd|exe|bat|ps1))?$/i;
// A search entrypoint — every invocation of these IS a memory search.
var CREDIT_SEARCH_BIN_RE = /^(?:flo-search(?:\.(?:cmd|exe|bat|ps1))?|semantic-search\.mjs)$/i;
// Substring every crediting form must contain — the hot-path pre-filter. Covers
// flo / moflo / flo-search / claude-flow (all contain "flo"), cli.js|cli.mjs,
// and semantic-search.mjs.
var CREDIT_HINT_RE = /flo|cli\.m?js|semantic-search/i;
// `flo memory search` / `flo memory retrieve`, and the hyphen/underscore spellings.
var CREDIT_MEMORY_VERB_RE = /^(?:search|retrieve)$/i;
var CREDIT_MEMORY_COMPOUND_RE = /^memory[-_](?:search|retrieve)$/i;

/**
 * Last path segment of a token, lowercased. Splits on BOTH separators, unlike
 * path.basename, which only honours the HOST's separator (Rule #1): an agent on
 * POSIX can legitimately type `node .claude\scripts\semantic-search.mjs`, and a
 * Windows-shaped path must resolve the same wherever the gate happens to run.
 */
function commandBasename(tok) {
  var t = tok.replace(/^["']+|["']+$/g, '');
  var cut = t.lastIndexOf('/');
  var bs = t.lastIndexOf('\\');
  if (bs > cut) cut = bs;
  return (cut >= 0 ? t.slice(cut + 1) : t).toLowerCase();
}

/**
 * The moflo subcommand one shell segment invokes, as lowercased positional
 * args (`['memory','search']`, `['swarm','init']`), or null when the segment
 * does not invoke moflo at all. A dedicated search binary reports the
 * subcommand it is — that is all `flo-search` does.
 */
function mofloSubcommand(seg) {
  var tokens = seg.trim().split(/\s+/).filter(Boolean);
  var i = 0;
  // Skip shell noise ahead of the entrypoint: env assignments (`FOO=bar flo …`),
  // sudo, package runners and their flags.
  while (i < tokens.length) {
    var tok = tokens[i];
    if (tok === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { i++; continue; }
    if (CREDIT_RUNNER_SKIP_RE.test(tok)) { i++; continue; }
    if (CREDIT_RUNNER_RE.test(commandBasename(tok))) { i++; continue; }
    break;
  }
  if (i >= tokens.length) return null;
  var entry = commandBasename(tokens[i]);
  if (CREDIT_SEARCH_BIN_RE.test(entry)) return ['memory', 'search'];
  if (!CREDIT_CLI_RE.test(entry)) return null;
  // Positional args after the CLI entrypoint; flags carry no subcommand.
  var rest = [];
  for (var j = i + 1; j < tokens.length; j++) {
    if (tokens[j].charAt(0) !== '-') rest.push(tokens[j].toLowerCase());
  }
  return rest;
}

/** Does one shell segment invoke a moflo memory search? */
function segmentCreditsMemorySearch(seg) {
  var sub = mofloSubcommand(seg);
  if (!sub || !sub.length) return false;
  if (CREDIT_MEMORY_COMPOUND_RE.test(sub[0])) return true;
  return sub[0] === 'memory' && sub.length > 1 && CREDIT_MEMORY_VERB_RE.test(sub[1]);
}

/**
 * CREDIT test for a whole Bash/PowerShell command. Quoted bodies are stripped
 * first (so a commit message quoting "memory search" cannot credit), then each
 * shell segment is checked at its own start — `cd repo && flo memory search`
 * credits, `echo "flo memory search"` does not.
 */
function creditsMemorySearch(rawCmd) {
  // Cheap reject first. This runs on EVERY Bash call in every consumer, ahead
  // of the block arm's regexes, and every crediting form necessarily names an
  // entrypoint containing one of these — so non-matches cost one regex, not a
  // strip + split + tokenize.
  if (!CREDIT_HINT_RE.test(rawCmd || '')) return false;
  return mofloSegments(rawCmd).some(segmentCreditsMemorySearch);
}

/** Shell segments of a command, quoted bodies stripped. */
function mofloSegments(rawCmd) {
  return stripQuotedAndHeredocs(rawCmd || '').split(/[;|&\n]+/);
}

/**
 * #1338 follow-up — which protected-coordination init, if any, did this shell
 * command run? Returns 'swarm', 'hive', or null.
 *
 * `flo swarm init` and `flo hive-mind init` are NOT second-class stand-ins for
 * the MCP tools: the CLI dispatches in-process through the same TOOL_REGISTRY
 * handler the MCP server exposes (`mcp-client.ts` callMCPTool), and the
 * resulting swarm is persisted (#806 agents/topology, #1329 tasks), so a later
 * process — including a restarted MCP server — hydrates the same swarm.
 *
 * This matters because Claude Code spawns stdio MCP servers once at session
 * start and never respawns them. Before this, `record-swarm-init` fired only on
 * `mcp__moflo__swarm_init`, so a session that lost its MCP server hit the #952
 * gate with NO way to satisfy it: `/fl -s` blocked every Agent spawn and told
 * the reader to call a tool that did not exist in that session. Unlike the
 * memory gate, there was not even an unadvertised escape.
 *
 * Deliberately wired PostToolUse, not PreToolUse where the memory credit lives:
 * Claude Code does not fire PostToolUse when a command exits non-zero (#1322),
 * so only an init that actually SUCCEEDED credits the gate. A failed init must
 * never open it — that would be the silent-degradation failure CLAUDE.md's
 * protected-functionality rule exists to prevent.
 */
function bashCoordinationInit(rawCmd) {
  // Cheap reject, same hot-path discipline as creditsMemorySearch: every
  // crediting form names a moflo entrypoint AND the `init` subcommand.
  if (!CREDIT_HINT_RE.test(rawCmd || '') || !/\binit\b/i.test(rawCmd)) return null;
  var segments = mofloSegments(rawCmd);
  for (var i = 0; i < segments.length; i++) {
    var sub = mofloSubcommand(segments[i]);
    if (!sub || sub.length < 2 || sub[1] !== 'init') continue;
    if (sub[0] === 'swarm') return 'swarm';
    // `hive` is the registered alias for `hive-mind` (commands/hive-mind.ts).
    if (sub[0] === 'hive-mind' || sub[0] === 'hive') return 'hive';
  }
  return null;
}
// #1445 — read shapes whose LEADING command is one BASH_CARVE_OUT_RE carves out
// wholesale (`node …`, `git …`). They are read-like because of what FOLLOWS the
// leading token, so anchoring on that token alone can never see them: in one
// real session 539 file-exploration calls went through `node -e` + readFileSync
// and `git show <ref>:<path>` with the gate blind to every one of them. That is
// the dominant exploration shape in repos whose own guidance steers away from
// `grep` (e.g. where `grep` is `ugrep` and silently skips files, so any
// inventory a decision rests on must go through `fs.readFileSync`).
//
// These sources are spliced into READ_LIKE_BASH_RE below AND kept addressable
// on their own, because check-bash-memory has to let them override the
// carve-out — extending READ_LIKE alone would change nothing, the `^\s*(node|
// git)\s` carve-out arms swallow them one line later.
var RUNNER_READ_SOURCES = [
  // `node -e "...readFileSync(...)..."`, in every eval spelling (-e/--eval/-p/
  // --print/--input-type=module -e). The eval FLAG is deliberately not required:
  // a script-file invocation (`node scripts/build.mjs`) does not carry a read
  // call in its command line, so the read call itself is the reliable signal and
  // demanding the flag only adds spellings to miss.
  //
  // The negative lookahead is load-bearing, not caution: Rule #1 tells authors
  // to do cross-platform file OPS through `node -e` with fs (`mkdir`/`rm`/`cp`
  // do not exist on Windows), and a read-modify-write is an operation, not
  // exploration. Only fs MUTATION calls carve out — matching a bare `write`
  // would carve out `process.stdout.write`, which nearly every inline read
  // script ends with, and that would hand back the whole gap.
  //
  // Every mutation name covers its sync, callback AND promise spelling: authors
  // reach for `fs.promises.rm` as readily as `rmSync`, and listing only the
  // `*Sync` form would block the delete op Rule #1 sent them to `node -e` for.
  // `rm`/`rmdir`/`cp` carry `\b` because they are short enough to appear inside
  // unrelated words — an unanchored `rm` matches "format" and "transform", and
  // would carve out most of what this arm exists to catch.
  '^\\s*(?:node|nodejs)(?:\\.(?:exe|cmd))?\\s'
    + '(?=[\\s\\S]*(?:read(?:File|dir)|globSync))'
    + '(?![\\s\\S]*(?:writeFile|appendFile|mkdir|mkdtemp|unlink|copyFile|rename'
    + '|symlink|createWriteStream|\\brm(?:dir)?(?:Sync)?\\b|\\bcp(?:Sync)?\\b))',
  // `git show <ref>:<path>` / `git cat-file -p <ref>:<path>` — the colon form
  // reads a blob and is `cat` by another name. Leading `-`-prefixed tokens are
  // consumed as flags first so `--pretty=format:%h` (a colon inside a FLAG)
  // cannot masquerade as a ref:path, and the segment after the colon must carry
  // a path character — same false-negative trade as the `type \S*[\\/.]` arm
  // above (`git show HEAD:src`, a bare directory, passes; source files all have
  // extensions). Bare `git show`, `git show --stat`, `git log` and `git diff`
  // have no ref:path token and stay operational.
  '^\\s*git\\s+(?:show|cat-file)\\s+(?:-{1,2}\\S+\\s+)*[^-\\s]\\S*:\\S*[\\\\/.]',
  // Repo-wide content search and file inventory — the `git` spellings of
  // `grep -r` and `find`. NOT `git log --grep`, which searches commit messages,
  // is already in the passing set, and does not match `git\s+grep`.
  '^\\s*git\\s+(?:grep|ls-files)\\b',
];
// Same sources as their own matcher — check-bash-memory tests this to let a
// carved-out leading command still block when the rest of the command is a read.
var RUNNER_READ_BASH_RE = new RegExp(RUNNER_READ_SOURCES.join('|'), 'i');
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
].concat(RUNNER_READ_SOURCES).join('|'), 'i');
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

// #1447 — words that carry no subject to search FOR: assent, acknowledgement,
// "keep going", and conversational filler. A prompt built ONLY from these
// continues work already under way, so the memory gate stays down; anything
// that survives the strip is a subject, and the gate arms.
//
// Supersedes two things. `DIRECTIVE_RE` — a `^(yes|ok|sure|…)` prefix test that
// had already been dead code for some time, unreferenced by the reset it was
// written for. And the live rule, `TASK_RE.test(p) || p.length > 20`, whose
// real work was skipping short replies: every prompt of 20 characters or fewer
// without a task word was exempt. That caught trivia ("hmm", "got it") and
// equally caught "check the daemon" — a genuine topic change — which is the
// half this replaces. The list below has to carry the trivia half on its own,
// so it covers considerably more ground than DIRECTIVE_RE ever did.
//
// Matching by SUBTRACTION, not by a leading-token test, is what lets
// "yes, now fix the daemon" arm while "yes" does not — a `^(yes|ok)\b` test
// sees the same first word in both. It is also why the list can safely hold
// ordinary words like `do`/`it`/`work`/`the`: a word only exempts a prompt when
// NOTHING else in that prompt survives, so each addition costs precision only
// for prompts made entirely of listed words. Deliberately absent for that
// reason: task words (`fix`, `test`, `build`) and any noun.
var CONTINUATION_WORD_RE = new RegExp('\\b(?:' + [
  // Assent / dissent / acknowledgement
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'sure', 'ok', 'okay', 'k',
  'correct', 'right', 'exactly', 'perfect', 'agreed', 'true', 'indeed',
  'understood', 'gotcha', 'got', 'makes', 'sense', 'fine', 'alright',
  // Continuation / assent to proceed
  'continue', 'proceed', 'carry', 'keep', 'going', 'go', 'ahead', 'on', 'next',
  'again', 'more', 'rest', 'both', 'all', 'them', 'those',
  // Politeness and praise
  'please', 'thanks', 'thank', 'ty', 'great', 'nice', 'cool', 'good', 'awesome',
  'excellent', 'sounds', 'lgtm', 'love', 'well', 'work', 'job', 'wow', 'yay',
  // Conversational filler / hesitation / greetings
  'hmm', 'hm', 'huh', 'ah', 'oh', 'ha', 'haha', 'lol', 'wait', 'hold', 'hang',
  'actually', 'anyway', 'whatever', 'nvm', 'nevermind', 'sorry', 'oops',
  'hi', 'hello', 'hey', 'stop', 'pause', 'never', 'mind',
  'think', 'know', 'see', 'guess', 'suppose', 'maybe', 'probably',
  // Function words with no subject of their own
  'do', 'it', 'that', 'this', 'the', 'a', 'an', 'and', 'is', 'are', 'was',
  'you', 'your', 'i', 'we', 'lets', 'let', 'us', 'me', 'my', 'now', 'then',
  'done', 'finish', 'finished', 'ready', 'too', 'also', 'just', 'still',
].join('|') + ')\\b', 'gi');
/**
 * Does this prompt consist of nothing but continuation filler?
 *
 * An EMPTY prompt answers true — a prompt the gate cannot see is not evidence
 * that a search is needed, and arming on it would block every read in a
 * consumer whose host omits the field, with nothing on screen explaining why.
 * Fail-open here; `prompt-state-reset` separately refuses to WRITE a verdict it
 * derived from an empty prompt (#1447), so an unreadable prompt now leaves the
 * gate exactly as prompt-reminder set it rather than silently disarming it.
 */
function isContinuationPrompt(promptText) {
  var t = (promptText || '').trim();
  if (!t) return true;
  // Subtract continuation words, then every non-alphanumeric character. What
  // remains is the prompt's actual subject matter; nothing remaining means the
  // prompt introduced no new subject.
  // `\p{L}\p{N}` with /u, NOT `A-Za-z0-9`: an ASCII-only class strips every
  // character of a CJK, Cyrillic, Arabic, Hebrew, Greek or Thai prompt — and
  // most of an accented French or Spanish one — leaving nothing, so a
  // substantive non-English request would score as pure filler and silently
  // disarm the gate. Stripping only what is neither letter nor number keeps
  // every script's content intact and removes just punctuation and spacing.
  var rest = t.replace(CONTINUATION_WORD_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return rest.length === 0;
}

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
// This file is the single source; #1443 replaced helpers-generator.ts's
// hand-maintained copy with a build-time embed of this exact file, so there is
// no longer a second copy of this function to keep in step.
function detectFlMode(promptText) {
  var p = promptText || '';
  if (!/^\s*\/(?:fl|flo)\b/i.test(p)) return null;
  if (/(?:^|\s)(?:-s|--swarm)\b/.test(p)) return 'swarm';
  if (/(?:^|\s)(?:-h|--hive)\b/.test(p)) return 'hive';
  return null;
}

// Resolve the FULL set of /flo run modifiers from the prompt + moflo.yaml — the
// single source of truth for both gate arming (#1297) and the authoritative
// announcement emitted by prompt-reminder. Two consumers, one resolver: a second
// implementation is exactly how `sdd.default: true` got silently ignored (the
// skill's prompt carried `let sddMode = false` and the model executed the literal).
//
// Precedence per key: explicit --no-X > explicit -x/--X > moflo.yaml > built-in.
// NOTE the differing built-in defaults: sdd is opt-IN (false), verify is opt-OUT
// (true, #1294), merge is opt-IN (false, #1285).
//
// `-sd` is a distinct token from `-s` (swarm): the `d` sits on the word boundary
// so `-s\b` never matches `-sd`.
function resolveFloRun(promptText) {
  var p = promptText || '';
  var out = { isFlo: false, workflow: 'full', sdd: false, verify: false, merge: false,
              sddSrc: 'default', verifySrc: 'default', mergeSrc: 'default' };
  if (!/^\s*\/(?:fl|flo)\b/i.test(p)) return out;
  out.isFlo = true;

  // Workflow mode — decides which modifiers are even applicable.
  if (/(?:^|\s)(?:-wf|--workflow)\b/.test(p)) out.workflow = 'spell-engine';
  else if (/(?:^|\s)(?:-r|--research)\b/.test(p)) out.workflow = 'research';
  else if (/(?:^|\s)(?:-t|--ticket)\b/.test(p)) out.workflow = 'ticket';
  var epicBranch = /(?:^|\s)--epic-branch\b/.test(p);

  if (/(?:^|\s)--no-sdd\b/.test(p)) { out.sdd = false; out.sddSrc = 'flag'; }
  else if (/(?:^|\s)(?:-sd|--sdd)\b/.test(p)) { out.sdd = true; out.sddSrc = 'flag'; }
  else if (sddConf.default) { out.sdd = true; out.sddSrc = 'moflo.yaml sdd.default'; }

  if (/(?:^|\s)--no-verify\b/.test(p)) { out.verify = false; out.verifySrc = 'flag'; }
  else if (/(?:^|\s)(?:-v|--verify)\b/.test(p)) { out.verify = true; out.verifySrc = 'flag'; }
  else if (!config.verify_before_done) { out.verify = false; out.verifySrc = 'moflo.yaml gates.verify_before_done'; }
  else { out.verify = true; out.verifySrc = 'default'; }
  // --sdd implies --verify: a spec/plan without an enforced verify step drifts.
  if (out.sdd && !out.verify && out.verifySrc !== 'flag') out.verify = true;

  if (/(?:^|\s)--no-merge\b/.test(p)) { out.merge = false; out.mergeSrc = 'flag'; }
  else if (/(?:^|\s)(?:-m|--merge)\b/.test(p)) { out.merge = true; out.mergeSrc = 'flag'; }
  else if (mergeConf.auto) { out.merge = true; out.mergeSrc = 'moflo.yaml merge.auto'; }

  // Applicability: -t/-r never implement, so verify is a no-op there; -r produces
  // no artifacts, so sdd is a no-op too (in -t the spec/plan goes INTO the ticket,
  // so sdd stays on). Only a full non-epic-branch run opens a PR to merge.
  // Re-attribute anything applicability turned off, so a false never carries the
  // source of the value it no longer has. This whole change exists to stop modes
  // being reported inaccurately — the attribution has to be honest too.
  if (out.workflow === 'ticket' || out.workflow === 'research') {
    if (out.verify) out.verifySrc = out.workflow + ' mode does not implement';
    out.verify = false;
  }
  if (out.workflow === 'research' || out.workflow === 'spell-engine') {
    if (out.sdd) out.sddSrc = out.workflow + ' mode produces no spec artifacts';
    out.sdd = false;
  }
  if (out.workflow !== 'full' || epicBranch) {
    if (out.merge) out.mergeSrc = epicBranch ? '--epic-branch owns merging' : out.workflow + ' mode opens no PR';
    out.merge = false;
  }
  return out;
}

// #1297 — arm the SDD implement gate from the user prompt. Thin wrapper so the
// arming decision and the announced decision can never disagree.
function detectSddMode(promptText) {
  return resolveFloRun(promptText).sdd;
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
// This file is the single source — see the note on detectFlMode above (#1443).
function classifyBashNamespaceHint(cmd) {
  // Search-like tools — the user is hunting for a symbol/file, code-map wins.
  // #1445 — `git grep` / `git ls-files` are the same hunt through a different
  // binary, so they route to the same namespace rather than falling through to
  // the hintless generic message.
  if (/^\s*(?:grep|rg|ag|fgrep|egrep|find|fd|Select-String|sls)\b/i.test(cmd)
   || /^\s*git\s+(?:grep|ls-files)\b/i.test(cmd)) {
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
function applyPromptStateReset(state, promptText, opts) {
  // #352/#1331 — this is the ONLY place the memory gate resets. Deliberately
  // NOT on task transitions: within a single prompt (e.g. a /flo workflow)
  // memory stays searched so Read/Grep aren't blocked mid-execution. A
  // `TaskUpdate`-driven reset would re-block the agent halfway through its own
  // workflow. The rationale used to live on the `check-task-transition` case,
  // which is why that case is an empty no-op; #1331 unwired the hook and moved
  // the reasoning here, where the reset it describes actually happens.
  state.memorySearched = false;
  // Wipe per-actor memory tracking too — a new user prompt is a fresh window
  // for both parent AND any subagents the parent may spawn during this turn.
  state.memorySearchedBy = {};
  // learningsStored is session-scoped — once stored, it stays true until session reset.
  // Resetting per-prompt caused false blocks when PR creation was on a later prompt.
  // #1447 — arm by DEFAULT; exempt only prompts that carry no subject of their
  // own. This replaces `TASK_RE.test(p) || p.length > 20`, whose length cliff
  // was arbitrary and invisible: "now look at the daemon" (22) armed the gate
  // and "check the daemon" (16) did not, which is most of why the gate felt
  // like it fired at random. Memory-first is this project's first rule, so the
  // default has to be "search", with continuations as the carve-out — not the
  // reverse. The per-prompt latch bounds the cost at one search per new prompt.
  //
  // `opts.skipArming` splits the reset in two. Invalidating the credits above
  // is prompt-INDEPENDENT and always correct; deciding whether this prompt
  // needs a search is not, and a caller holding no prompt text must not decide
  // it from nothing. Skipping the whole reset instead would be worse than
  // either: `memorySearchedBy` would survive, and a stale per-actor credit from
  // the previous prompt would satisfy the gate for a prompt it never saw.
  if (!(opts && opts.skipArming)) {
    var escaped = /^@@\s*/.test(promptText || '');
    state.memoryRequired = !escaped && !isContinuationPrompt(promptText);
  }
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
// #1322 — failure markers in a test runner's own OUTPUT.
//
// This is deliberately not an exit-code check: Claude Code's PostToolUse payload
// carries no exit status, and PostToolUse does not fire at all when a command
// exits non-zero — so an unmasked red suite already leaves testsRun false, by
// accident of the hook lifecycle rather than by design. What DOES defeat the
// gate is a masked exit (`npm test | tail -20`, `npm test || true`,
// `npm test 2>&1 | grep -i fail`): the pipeline exits 0, PostToolUse fires with
// a clean-looking response, and a red suite credits the gate. Output is the only
// signal left, and it is genuinely weaker than a status — see the ticket.
//
// Every arm matches a SUMMARY shape a runner emits, never a bare "fail", which
// occurs constantly in ordinary passing test names ("returns null when the
// lookup failed"). The count arm excludes an explicit zero so jest's
// `0 failed, 12 passed` cannot self-block.
//
// The count arm's trailing lookahead is what keeps a GREEN run from blocking
// itself. Mocha's default spec reporter prints every passing test name, so
// `npm test | tail -20` on a green suite legitimately contains lines like
// `✓ handles 2 failed retries`. A real summary is followed by a delimiter or a
// line end (`3 failed | 40 passed`, `1 failed, 2 passed`, `1 failing`), never by
// more prose — so a lowercase word after the count means it is a sentence, not a
// tally. `tests`/`test` is exempted because `2 failed tests` is a real summary.
// Same-line whitespace only: at a line end there is nothing to disqualify.
var TEST_FAILURE_RE = new RegExp([
  '\\b(?!0\\b)\\d+\\s+(?:tests?\\s+)?(?:failed|failing|failures?)\\b(?![^\\S\\n]+(?!tests?\\b)[a-z])', // vitest/jest/pytest/mocha counts
  '^\\s*(?:FAIL|FAILED)\\b',                                          // vitest + jest per-file, pytest FAILED
  '^\\s*---\\s*FAIL:',                                                // go test
  '\\btest result:\\s*FAILED\\b',                                     // cargo
  '^npm ERR!',                                                        // npm wrapper around any of the above
].join('|'), 'im');

/**
 * #1322 — why a just-fired record-test-run must NOT be credited, or null.
 *
 * Absent output is not evidence of failure: a quiet green `npm test > /dev/null`
 * and a silently-masked red one are indistinguishable, and treating the pair as
 * failures would block every consumer who redirects test output. Absent means
 * unknown, and unknown keeps the pre-#1322 behaviour.
 */
function detectTestFailure() {
  if (process.env.TOOL_RESPONSE_interrupted === 'true') return 'the run was interrupted';
  var out = (process.env.TOOL_RESPONSE_stdout || '') + '\n' + (process.env.TOOL_RESPONSE_stderr || '');
  if (!out.trim()) return null;
  var hit = out.match(TEST_FAILURE_RE);
  return hit ? 'output reports "' + hit[0].trim().slice(0, 40) + '"' : null;
}
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
// #1348 — `.moflo/` joins them. It is moflo's own gitignored state directory
// (daemon locks, memory db, SDD spec/plan artifacts), so nothing written there
// can appear in the branch diff, and a spec edit invalidating the test run is
// pure noise. Scoped to the reset only — deliberately NOT added to EXEMPT,
// which would also un-gate reads of `.moflo/specs/**`, and those are indexed
// guidance that memory-first should still route through a search.
// #1395 — `.claude/` CONFIG joins them, by the same "doesn't expose new runtime
// surface" reasoning: hook wiring, skills and guidance are not the code under
// verification. This is the stronger case, in fact — it is the directory a user
// edits *because a gate told them to*. Before this, fixing hook wiring on a
// gate's own instruction reset verifyRun and invalidated the verification the
// fix existed to let through, so the recovery was: fix wiring → verification
// invalidated → restart session → re-run /verify → retry (#1392 field report).
//
// Scoped to config, NOT all of `.claude/**`: `scripts/` and `helpers/` hold
// executable runtime surface (gate.cjs itself lives there), and editing
// executable code SHOULD still invalidate a verification. Listing the config
// subdirectories explicitly keeps that invariant intact.
//
// Both separators in every alternative — a bare `/` here would silently no-op
// on Windows, where TOOL_INPUT paths arrive backslashed (Rule #1).
var EDIT_RESET_SKIP_PATH_RE = /(?:^|[\\\/])\.github[\\\/](?:workflows|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)(?:[\\\/.]|$)|(?:^|[\\\/])\.moflo[\\\/]|(?:^|[\\\/])\.claude[\\\/](?:settings(?:\.local)?\.json$|skills[\\\/]|guidance[\\\/]|agents[\\\/])/i;
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

// ── Content-addressed gate credit ───────────────────────────────────────────
// A boolean `testsRun`/`simplifyRun`/`verifyRun` answers "was an edit
// observed?" — which is only equivalent to "does this credit still describe the
// code?" if every mutation flows through Write/Edit/MultiEdit. It does not.
// `node -e` with fs.writeFileSync, `sed -i`, shell redirection, `cp`, and every
// git operation that moves the tree (checkout, pull, merge, rebase, apply)
// change source without firing PostToolUse on those tools, so reset-edit-gates
// never runs and credit earned beforehand survives the change. Demonstrated by
// earning full credit, appending an execSync call to a source file via Bash,
// and watching check-before-pr allow the PR. Multi-issue sessions have the same
// shape: nothing is per-prompt, so issue B inherits issue A's credit.
//
// Every one of #908 / #1176 / #1322 / #1332 / #1348 refined WHICH tool call to
// watch. None of them could close this, because the observer is the wrong
// primitive. So stop observing mutations and fingerprint the code itself: HEAD
// plus the content of every changed and untracked file. Recompute at check
// time; any mismatch means the credit describes different code and is stale. No
// tool can bypass it, because it watches no tools.
//
// Scope mirrors the reset predicates so their intentional exemptions survive.
// Inert files (#1176) and `.github/` + `.moflo/` paths never contribute, so a
// markdown or spec edit still leaves a test run standing. 'nontest' also drops
// test files, preserving #908: touching a test does not invalidate /simplify.
//
// isEphemeralPath is deliberately NOT applied — it exists for agent scratchpads
// outside the project, and `git status` cannot report those.
// The gate's own state file must never contribute: recording a credit writes
// it, which would change the very fingerprint the credit is pinned to and make
// every credit instantly stale. It is gitignored in moflo's repo, but a
// consumer project need not ignore it, and there the self-reference would
// deadlock their gate permanently — so exclude it by name rather than trusting
// .gitignore. Scoped to this one file: `.claude/` also holds real source
// (helpers/, scripts/) that must keep counting.
var FINGERPRINT_SELF_RE = /(?:^|[\\\/])\.claude[\\\/]workflow-state\.json$/i;

function fingerprintIncludes(rel, scope) {
  if (FINGERPRINT_SELF_RE.test(rel)) return false;
  if (EDIT_RESET_SKIP_BOTH_RE.test(rel)) return false;
  if (EDIT_RESET_SKIP_PATH_RE.test(rel)) return false;
  if (scope === 'nontest' && EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE.test(rel)) return false;
  return true;
}

/**
 * Paths reported by `git status --porcelain=v1 -uall -z`, as
 * `{ path, orig }` — `orig` set only for renames and copies.
 *
 * A rename emits `R  <new>\0<old>\0`: two NUL-terminated tokens for one entry.
 * The origin token must be consumed or it is misread as the next entry's status
 * bytes, AND it must be reported, because a rename means the old path no longer
 * exists. Dropping it on the floor leaves the old path in the content map — the
 * fingerprint would then carry a phantom entry that disappears the moment the
 * rename is committed, expiring credit on a commit that changed no content.
 * That is the same defect content-addressing was introduced to remove.
 */
function parsePorcelainZ(raw) {
  var out = [];
  var parts = String(raw).split('\0');
  for (var i = 0; i < parts.length; i++) {
    var entry = parts[i];
    if (!entry || entry.length < 4) continue;
    // Check BOTH status columns, not just the staged one: git reports a rename
    // as `R ` when staged and can report ` R` for one detected in the worktree.
    // Missing the second form would leave the origin token unconsumed, and it
    // would then be read as the next entry's status bytes — misaligning every
    // entry after it. R and C always emit an origin token, so consuming one
    // whenever either column shows them cannot over-consume.
    var st = entry.slice(0, 2);
    var rec = { path: entry.slice(3), orig: null };
    if (st.indexOf('R') >= 0 || st.indexOf('C') >= 0) { rec.orig = parts[i + 1] || null; i++; }
    out.push(rec);
  }
  return out;
}

/**
 * Fingerprint of the code a gate credit describes, or null when it cannot be
 * computed (no git, no repo, no commits). Null is the fail-open signal: callers
 * fall back to the flag alone, so non-git projects behave exactly as before.
 */
// Memoised per scope. check-before-pr tests three credits and check-before-done
// a fourth, and each computation shells out to `git status -uall` over the whole
// tree. The gate process is short-lived and single-shot — it exits before any
// tool it gates can run — so nothing can change underneath the cache.
var FINGERPRINT_CACHE = {};

function creditFingerprint(scope) {
  if (Object.prototype.hasOwnProperty.call(FINGERPRINT_CACHE, scope)) return FINGERPRINT_CACHE[scope];
  var value = computeCreditFingerprint(scope);
  FINGERPRINT_CACHE[scope] = value;
  return value;
}

function computeCreditFingerprint(scope) {
  var git = function (args) {
    return cp.execFileSync('git', args, {
      cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 10000, windowsHide: true,
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  };
  // Fingerprint the CONTENT of the working tree, never (HEAD + delta). Those
  // are not the same thing: `git commit` moves changes from the working tree
  // into HEAD without altering a single byte of code, and a HEAD-based
  // fingerprint would expire every credit on commit — forcing a pointless
  // re-run of the tests that just passed on exactly this code. Content-
  // addressing also makes the fingerprint stable across amend, stash/pop, and
  // any branch switch that lands on identical content, while still moving the
  // moment real content differs.
  //
  // Unchanged files contribute git's own blob hashes (free, already computed);
  // only files git reports as changed or untracked are hashed here.
  var tracked;
  try {
    tracked = git(['ls-tree', '-r', '-z', 'HEAD']);
  } catch (e) { return null; } // no git, no repo, or no commit yet
  var byPath = Object.create(null);
  var entries = String(tracked).split('\0');
  for (var i = 0; i < entries.length; i++) {
    // "<mode> <type> <object>\t<path>"
    var tab = entries[i].indexOf('\t');
    if (tab < 0) continue;
    var meta = entries[i].slice(0, tab).split(' ');
    byPath[entries[i].slice(tab + 1)] = meta[2];
  }
  try {
    var changed = parsePorcelainZ(git(['status', '--porcelain=v1', '-uall', '-z']));
    var live = [];
    for (var j = 0; j < changed.length; j++) {
      var rel = changed[j].path;
      // A rename's origin path is gone from the content — drop it, or it
      // lingers until the rename is committed and then vanishes, moving the
      // fingerprint on a commit that changed nothing.
      if (changed[j].orig) delete byPath[changed[j].orig];
      var abs = path.resolve(PROJECT_DIR, rel);
      var isFile = false;
      try { isFile = fs.statSync(abs).isFile(); } catch (e) { isFile = false; }
      // A path git reports but that is gone (or is not a regular file) is
      // absent from the content, so it must leave the map entirely.
      if (!isFile) { delete byPath[rel]; continue; }
      if (rel.indexOf('\n') >= 0) { delete byPath[rel]; continue; } // unhashable via --stdin-paths
      live.push(rel);
    }
    if (live.length) {
      // `git hash-object` — NOT a raw sha1 of the bytes. A git blob id hashes
      // "blob <size>\0" plus the content, and applies the same clean filters
      // and core.autocrlf normalisation git would apply on checkin. Hashing the
      // raw bytes here instead would produce a different string than ls-tree
      // reports for identical content, so a file would appear to "change" the
      // moment it was committed — and on Windows, whenever autocrlf rewrote its
      // line endings. One batched call covers every changed path.
      var hashed = cp.execFileSync('git', ['hash-object', '--stdin-paths'], {
        cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 10000, windowsHide: true,
        maxBuffer: 64 * 1024 * 1024, input: live.join('\n') + '\n',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim().split('\n');
      for (var m = 0; m < live.length; m++) {
        if (hashed[m]) byPath[live[m]] = hashed[m].trim();
      }
    }
  } catch (e) {
    // status failed — fall back to the committed tree alone rather than null,
    // so the fingerprint still tracks committed content.
  }
  var paths = Object.keys(byPath).filter(function (p) { return fingerprintIncludes(p, scope); });
  paths.sort();
  var h = crypto.createHash('sha1');
  for (var k = 0; k < paths.length; k++) h.update(paths[k] + ':' + byPath[paths[k]] + '\n');
  return h.digest('hex');
}

/**
 * Is a credit still live? `flag` is the legacy boolean, `stored` the fingerprint
 * captured when it was earned.
 *
 * Fail-open on an uncomputable fingerprint (non-git project) — the gate keeps
 * its previous semantics there rather than blocking work it cannot reason about.
 * Fail-CLOSED on a missing stored fingerprint: that is credit earned by a
 * pre-upgrade gate, and it carries no evidence about which code it covered. The
 * cost is re-running once on the first PR after upgrade, which self-heals.
 */
function creditIsLive(flag, stored, scope) {
  if (!flag) return false;
  var now = creditFingerprint(scope);
  if (now === null) return true;
  if (!stored) return false;
  return stored === now;
}

// #1410 — is this Bash command actually a `gh pr create` invocation? Delegates
// to pr-create-command.cjs, which sanitises data regions (quotes, heredoc
// bodies, comments) before looking for the command, so the gate neither misses
// real invocations (newline-separated, piped, parenthesised) nor fires on
// commands that merely quote the literal (`git commit -m "...gh pr create..."`).
//
// Fail-safe, in BOTH directions, because this runs on every Bash call in every
// consumer. gate-hook.mjs maps a non-zero exit from this script to exit 2, so an
// uncaught throw here does not degrade one gate — it blocks every Bash call the
// consumer makes. So a load failure (partial `.claude/helpers` sync mid-upgrade,
// hand-pruned install) AND a throw from the matcher itself both fall back to the
// pre-#1410 regex: previous behaviour, not a wedged session.
//
// Not silent (#854, hook-authoring §4): the fallback path advises on stderr and
// continues. If this ever fires it means the matcher crashed, which is worth
// being loud about — and it cannot spam a healthy session, because a healthy
// session never reaches it.
var LEGACY_PR_CREATE_RE = /(?:^|&&\s*|\|\|\s*|;\s*)\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)*gh\s+pr\s+create\b/;
var prCreateMatcher = null;
function isPrCreateCommand(cmd) {
  if (prCreateMatcher === null) {
    try {
      prCreateMatcher = require('./pr-create-command.cjs').isPrCreateCommand;
    } catch (e) {
      prCreateMatcher = false;
      process.stderr.write('moflo: pr-create-command.cjs unavailable (' + (e && e.message) + ') — PR gates fall back to the legacy matcher. Run `npx flo doctor --fix`.\n');
    }
    if (typeof prCreateMatcher !== 'function') prCreateMatcher = false;
  }
  if (prCreateMatcher) {
    try {
      return prCreateMatcher(cmd);
    } catch (e) {
      process.stderr.write('moflo: pr-create matcher threw (' + (e && e.message) + ') — falling back to the legacy matcher. Please report with the command that triggered it.\n');
    }
  }
  return LEGACY_PR_CREATE_RE.test(cmd);
}

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
  var mod;
  try {
    mod = require('./simplify-classify.cjs');
  } catch (e) { return null; }
  var classify = mod && mod.classifyDiff;
  var readUntracked = mod && mod.readUntrackedDiff;
  // EXEC_MAX_BUFFER is checked alongside the functions because falling back to
  // Node's 1 MiB default would silently reinstate the very cliff #1451 removed.
  if (typeof classify !== 'function' || typeof readUntracked !== 'function'
      || typeof mod.EXEC_MAX_BUFFER !== 'number') return null;

  // Untracked files show up in no `git diff` output, so without them the gate
  // could auto-pass a branch of brand-new unstaged files as TRIVIAL (#1451).
  // Reading every one of them is real work, so it is deferred until a path is
  // actually about to classify. Returns null if the read failed — the caller
  // must then fall through and force /simplify rather than classify a partial
  // diff.
  var untrackedText = null;
  function untrackedSuffix() {
    if (untrackedText !== null) return untrackedText;
    var u;
    try { u = readUntracked(PROJECT_DIR); } catch (e) { return null; }
    if (!u || u.unreadable) return null;
    untrackedText = u.text ? '\n' + u.text : '';
    return untrackedText;
  }

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

  // maxBuffer comes FROM the classifier (#1451) rather than being a matching
  // literal here, so the gate and the skill cannot drift on which diffs are
  // readable at all. Past it execFileSync throws ENOBUFS and gitDiff returns
  // null — which every caller below must treat as "unknown", never "empty".
  var maxBuffer = mod.EXEC_MAX_BUFFER;
  function gitDiff(args) {
    try {
      return cp.execFileSync('git', args, {
        cwd: PROJECT_DIR, encoding: 'utf-8', timeout: 5000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: maxBuffer
      });
    } catch (e) { return null; }
  }

  // Snapshot path: classify everything since /simplify last ran.
  if (state.simplifySnapshotSha) {
    var snapDiff = gitDiff(['diff', state.simplifySnapshotSha + '...HEAD']);
    var workTreeA = gitDiff(['diff', 'HEAD']);
    // BOTH reads must succeed. Coalescing a failed working-tree read to '' is
    // how an over-buffer working tree used to read as "no working-tree changes"
    // and let the gate skip review (#1451).
    if (snapDiff !== null && workTreeA !== null) {
      var suffixA = untrackedSuffix();
      if (suffixA === null) return null;
      var combined = snapDiff + (workTreeA ? '\n' + workTreeA : '') + suffixA;
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
    var workTreeB = gitDiff(['diff', 'HEAD']);
    if (branchDiff !== null && workTreeB !== null) {
      var suffixB = untrackedSuffix();
      if (suffixB === null) return null;
      return tryClassify(branchDiff + (workTreeB ? '\n' + workTreeB : '') + suffixB, 'branch diff');
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

// #1374 — the missing half of the TaskCreate reminder.
//
// moflo nags you to OPEN a task list (check-before-agent) and then never looks
// again: `taskCount` only counts up, so a run that creates four tasks and closes
// none satisfies every gate. That is the exact shape of an abandoned list.
//
// The ledger is read from the session TRANSCRIPT, and both alternatives were
// rejected on evidence rather than taste:
//
//   - A `^TaskUpdate$` PostToolUse observer feeding a counter is the wiring
//     #1331 removed as pure hot-path overhead. It would also have to survive
//     applyPromptStateReset, whereas a transcript read holds no state to reset.
//   - Claude Code's own task store (`~/.claude/tasks/session-<id>/`) is ground
//     truth but unreachable: measured on v2.1.220, the id keying that directory
//     does NOT rotate on `/clear`, so a session whose transcript is <A> writes
//     its tasks under the pre-clear id <B> — and <A> is what the bridge forwards
//     as HOOK_SESSION_ID. There is no path from the hook environment to the dir.
//
// Cost lands only where it is already justified: the sole caller runs after
// check-before-pr's `gh pr create` match, i.e. once per PR attempt, never on the
// per-tool path.
//
// Returns null when the transcript is missing, oversized, unreadable, or records
// no TaskCreate at all — the caller then stays silent rather than guessing.
// Sized against measurement, not a round number: a 3.4MB transcript (the largest
// in a week of local sessions) costs ~55ms to scan, so ~16ms/MB. 16MB is ~4x the
// worst observed session and lands near 260ms — a chunk of the hook's 2000ms
// budget, but a bounded one. Past the cap the ledger goes silent rather than
// risking the timeout, since a hook that times out is worse than one that
// declines to comment. Unrelated to `TRANSCRIPT_TAIL_BYTES` in bin/lib/meditate.mjs
// despite the similar name — that one truncates to a tail window, which cannot
// work here (a TaskCreate from early in the session falls outside any tail).
var TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
function readTaskLedger() {
  var tp = process.env.HOOK_TRANSCRIPT_PATH || '';
  if (!tp) return null;
  var raw;
  try {
    var st = fs.statSync(tp);
    if (!st.isFile() || st.size > TRANSCRIPT_MAX_BYTES) return null;
    raw = fs.readFileSync(tp, 'utf-8');
  } catch (e) { return null; }
  var created = 0;                       // TaskCreate CALLS seen
  var pendingCreates = {};               // tool_use id → awaiting its result
  var createdIds = {};                   // task ids this transcript actually opened
  var createdIdCount = 0;
  var latest = {};                       // task id → most recent status seen
  // Walked by newline index rather than raw.split('\n'): the split would hold a
  // second full-size copy of a multi-MB transcript alongside the first, and the
  // scan needs one line at a time.
  var pos = 0;
  while (pos <= raw.length) {
    var nl = raw.indexOf('\n', pos);
    var line = nl < 0 ? raw.slice(pos) : raw.slice(pos, nl);
    pos = nl < 0 ? raw.length + 1 : nl + 1;
    // Cheap pre-filter. A multi-MB transcript has a handful of task lines and
    // tens of thousands of others; JSON.parse on every line is the whole cost.
    if (line.indexOf('TaskCreate') < 0 && line.indexOf('TaskUpdate') < 0
      && line.indexOf('created successfully') < 0) continue;
    var entry;
    try { entry = JSON.parse(line); } catch (e) { continue; }
    var content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (var j = 0; j < content.length; j++) {
      var block = content[j];
      if (!block) continue;
      // The created ids come from TaskCreate's RESULT, because the call itself
      // carries no id. Without them `created` (a count of calls) and the closed
      // set (a set of ids) are different units: a TaskUpdate naming a task from
      // before this transcript — one carried across `/clear`, which is exactly
      // what Claude Code's task store does — would discount a task it never
      // opened, and the advisory would under-report the open list.
      if (block.type === 'tool_result') {
        if (!pendingCreates[block.tool_use_id]) continue;
        delete pendingCreates[block.tool_use_id];
        var text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        var m = /Task #(\S+) created successfully/.exec(text || '');
        if (m && !createdIds[m[1]]) { createdIds[m[1]] = true; createdIdCount++; }
        continue;
      }
      // Structural, not substring. A line that merely MENTIONS TaskCreate — this
      // ticket's own discussion, a guidance excerpt, a shell command echoing the
      // phrase — is text, and counting it would inflate the created total on
      // exactly the sessions most likely to reach a PR gate. Correlating on
      // tool_use_id is what keeps such an echo out of the created ids too.
      if (block.type !== 'tool_use') continue;
      if (block.name === 'TaskCreate') {
        created++;
        if (block.id) pendingCreates[block.id] = true;
        continue;
      }
      if (block.name !== 'TaskUpdate') continue;
      var input = block.input || {};
      var id = input.taskId != null ? input.taskId : input.task_id;
      var status = input.status;
      if (id == null || typeof status !== 'string' || !status) continue;
      // Last write wins — transcript order is chronological, so a task reopened
      // after completion is correctly counted as open again.
      latest[String(id)] = status;
    }
  }
  if (created === 0) return null;
  // A create whose result never landed (interrupted call, truncated transcript)
  // is counted OPEN: it was opened, and nothing observed it being closed.
  var open = created - createdIdCount;
  Object.keys(createdIds).forEach(function(id) {
    // `deleted` closes the loop as legitimately as `completed`: a task removed
    // because it no longer applies is not an abandoned one.
    if (latest[id] !== 'completed' && latest[id] !== 'deleted') open++;
  });
  if (open > created) open = created;
  return { created: created, closed: created - open, open: open };
}

switch (command) {
  case 'check-before-agent': {
    // Mostly advisory. The TaskCreate + memory reminders below go to stdout and
    // never block — their wording must not claim otherwise (#1326). The one
    // exception is the #952 swarm/hive check at the bottom of this case, which
    // writes to stderr and exits 2.
    // Memory-first enforcement otherwise happens at the scan/read gate layer.
    // SubagentStart hook injects guidance directive into subagent context.
    //
    // #931 — TaskCreate REMINDER and the namespace hint moved here from
    // prompt-reminder. They only matter when Claude is actually about to spawn
    // an Agent; emitting per-prompt cost ~90 tokens × every prompt × every
    // consumer.
    var s = readState();
    if (config.task_create_first && !s.tasksCreated) {
      process.stdout.write('REMINDER: Use TaskCreate before spawning agents.\n');
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
        process.stderr.write(COORD_FALLBACK_NOTE + '  npx flo swarm init --topology hierarchical  (then: npx flo agent spawn --type <role>)\n');
        process.stderr.write('See .claude/skills/fl/execution-modes.md "SWARM mode" and CLAUDE.md "⛔ Protected functionality".\n');
        process.stderr.write('Disable via moflo.yaml: gates: swarm_invocation_gate: false\n');
        process.exit(2);
      }
      if (s.flMode === 'hive' && !s.hiveInitialized) {
        process.stderr.write('BLOCKED: /fl was invoked with -h/--hive but mcp__moflo__hive-mind_init has not been called.\n');
        process.stderr.write('Run mcp__moflo__hive-mind_init first, then dispatch Agent or hive-mind workers.\n');
        process.stderr.write(COORD_FALLBACK_NOTE + '  npx flo hive-mind init  (then: npx flo hive-mind spawn)\n');
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
  case 'record-bash-swarm-init': {
    // #1338 follow-up — the CLI half of record-swarm-init / record-hive-init.
    // Wired PostToolUse[Bash|PowerShell], so it only sees commands that
    // succeeded (#1322). See bashCoordinationInit for why the CLI route is a
    // real satisfaction of the #952 gate and not a stand-in.
    var kind = bashCoordinationInit(process.env.TOOL_INPUT_command || '');
    if (!kind) break;
    var s = readState();
    var flag = kind === 'swarm' ? 'swarmInitialized' : 'hiveInitialized';
    if (!s[flag]) {
      s[flag] = true;
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
    process.stderr.write('BLOCKED [moflo memory_first gate]: Search memory before exploring files. Use mcp__moflo__memory_search. On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n' + MCP_FALLBACK_NOTE + '\n' + GATE_ORIGIN_NOTE + '\n' + GATE_DISABLE_NOTE + '\n');
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
    process.stderr.write('BLOCKED [moflo memory_first gate]: Search memory before reading files. Use mcp__moflo__memory_search. On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n' + MCP_FALLBACK_NOTE + '\n' + GATE_ORIGIN_NOTE + '\n' + GATE_DISABLE_NOTE + '\n');
    process.exit(2);
  }
  case 'record-task-created': {
    var s = readState();
    s.tasksCreated = true;
    s.taskCount = (s.taskCount || 0) + 1;
    writeState(s);
    break;
  }
  // #1435 — the escape from the task-status gate, for work deliberately left
  // open. Session-scoped like `learningsStored`: it lives in STATE_DEFAULTS, so
  // session-reset clears it, and neither applyPromptStateReset nor
  // reset-edit-gates touches it — a decision the user made about the task list
  // is not invalidated by the next prompt or the next source edit.
  //
  // A plain flag, not a count. The command is typed by the model into a Bash
  // tool, where HOOK_TRANSCRIPT_PATH is unset (it is forwarded by gate-hook.mjs
  // from the hook payload and exists only inside a hook), so this process cannot
  // read the ledger to record WHICH tasks were acknowledged even if it wanted to.
  case 'record-tasks-acknowledged': {
    var s = readState();
    if (!s.tasksAcknowledged) {
      s.tasksAcknowledged = true;
      writeState(s);
    }
    // writeState swallows its own errors by design — a gate must never crash the
    // hook it runs in. That was harmless while every recorder was advisory. This
    // one is the ONLY escape from a BLOCKING gate, so a lost write would report
    // "satisfied" and then block the very next `gh pr create` with nothing said
    // about why: #1332's deadlock shape exactly. Confirm it landed before
    // claiming it did, and name the file and the way out when it did not.
    if (!readState().tasksAcknowledged) {
      process.stderr.write(
        'Task-status gate NOT satisfied: the acknowledgement could not be persisted to\n' +
        STATE_FILE + '\n' +
        'Check that the file and its directory are writable, then run this again.\n' +
        'To proceed without it: set gates: task_status_gate: off in moflo.yaml.\n');
      process.exit(1);
    }
    process.stdout.write(
      'Task-status gate satisfied: open tasks acknowledged as deliberately deferred.\n' +
      'They stay visible in the task list — this records the decision, it does not close them.\n');
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
    if (creditsMemorySearch(cmd)) {
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
    // #1445 — the carve-out is anchored to the LEADING command, so its `node`
    // and `git` arms swallow every shape RUNNER_READ_SOURCES exists to catch.
    // Those shapes earn their read classification from what follows the leading
    // token, so they override the carve-out; every other command keeps #1132's
    // semantics exactly (`npm test | grep FAIL`, `git diff`, `node build.mjs`).
    if (BASH_CARVE_OUT_RE.test(cmd) && !RUNNER_READ_BASH_RE.test(cmd)) break;
    var s2 = readState();
    if (!s2.memoryRequired || isMemorySearchedFor(s2)) break;
    // Hint precedence: prompt-derived classification (set by applyPromptStateReset
    // from the user prompt text) → command-shape classification (works for
    // subagents that never saw the user prompt). Either source returns a full
    // "Memory namespace hint: ..." sentence so the BLOCK message stays uniform.
    var hint = s2.lastNamespaceHint || classifyBashNamespaceHint(cmd) || '';
    process.stderr.write(
      'BLOCKED [moflo memory_first gate]: Search memory before reading files via Bash.\n' +
      'Example: mcp__moflo__memory_search { query: "<topic>", namespace: "<one of: guidance | code-map | patterns | learnings | tests>" }\n' +
      (hint ? hint + '\n' : '') +
      'On chunk hits, traverse via mcp__moflo__memory_get_neighbors — see .claude/guidance/moflo-memory-protocol.md\n' +
      MCP_FALLBACK_NOTE + '\n' +
      GATE_ORIGIN_NOTE + '\n' +
      GATE_DISABLE_NOTE + '\n'
    );
    process.exit(2);
    break;
  }
  case 'check-task-transition': {
    // Intentional no-op, retained for backwards compatibility only (#1331).
    // The `^TaskUpdate$` wiring was removed from settings-generator.ts,
    // hook-block-hash.ts and hook-wiring.ts because spawning gate-hook.mjs +
    // gate.cjs on every TaskUpdate to do nothing is pure overhead. The case
    // stays because doctor-checks-deep.ts lists it in REQUIRED_GATE_CASES —
    // dropping the case would turn `flo doctor`'s Gate Health check red in
    // every consumer for no gain. (Falling through to `default: break` would
    // otherwise be harmless; this is about the doctor contract, not runtime.)
    // Why it does nothing: see applyPromptStateReset().
    break;
  }
  // #1434 — the gate demanded one memory_store per run whether or not the run
  // produced a reusable lesson, and a mandatory write with nothing to say
  // produces filler: a summary of this ticket, this commit, applicable never
  // again. memory_search returns a bounded set, so each of those displaces a
  // real lesson from every future search — the cost is retrieval quality, not
  // disk. Declaring "nothing durable here" is the honest outcome of a run that
  // learned nothing new, so it has to be reachable without a write; otherwise
  // the cheapest way past the gate stays the filler write.
  //
  // Both credits set the same flag; they differ only in whether the run has
  // something to say. Sharing the case body keeps that single write in one
  // place across all three copies of this file.
  case 'record-learnings-stored':
  case 'record-no-durable-lesson': {
    var s = readState();
    if (!s.learningsStored) {
      s.learningsStored = true;
      writeState(s);
    }
    if (command === 'record-no-durable-lesson') {
      // Same reasoning as record-tasks-acknowledged above: writeState swallows
      // its own errors so a gate never crashes the hook it runs in, and this is
      // the ONLY escape from the BLOCKING learnings gate that does not require a
      // memory_store. A lost write here would print "satisfied" and then block
      // the next `gh pr create` with nothing said about why — #1332's deadlock.
      // Verified only on this arm: record-learnings-stored is fired
      // automatically by the PostToolUse hook on every memory_store, where a
      // failed write leaves the gate closed but the run still has the ordinary
      // way through, and a diagnostic on every store would be noise.
      if (!readState().learningsStored) {
        process.stderr.write(
          'Learnings gate NOT satisfied: the declaration could not be persisted to\n' +
          STATE_FILE + '\n' +
          'Check that the file and its directory are writable, then run this again.\n' +
          'To proceed without it: set gates: learnings_gate: false in moflo.yaml.\n');
        process.exit(1);
      }
      process.stdout.write(
        'Learnings gate satisfied: no durable lesson declared for this run.\n' +
        'What this run did belongs in the PR body, not in memory.\n',
      );
    }
    break;
  }
  case 'record-test-run': {
    var cmd = process.env.TOOL_INPUT_command || '';
    if (TEST_RUNNER_RE.test(cmd)) {
      // #1322 — a red run is evidence AGAINST the gate, so it also clears a
      // flag an earlier green run earned. Without the reset, `npm test` (green)
      // followed by an edit and `npm test | tail -20` (red) would leave the
      // gate satisfied by the stale first run — the edit resets testsRun, but
      // the masked red run would immediately set it back.
      var failure = detectTestFailure();
      var s = readState();
      if (failure) {
        if (s.testsRun) { s.testsRun = false; s.testsFingerprint = null; writeState(s); }
        process.stderr.write('gate: record-test-run not credited — ' + failure + '\n');
      } else {
        // Re-stamp on every green run, not only the first: the tree may have
        // moved since the last one, and this run is evidence about the tree as
        // it is NOW. Gating on `!s.testsRun` would keep the older fingerprint
        // and discard the fresher evidence.
        var testsFp = creditFingerprint('all');
        if (!s.testsRun || s.testsFingerprint !== testsFp) {
          s.testsRun = true;
          s.testsFingerprint = testsFp;
          writeState(s);
        }
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
      // 'nontest' scope: a later test-only edit must not invalidate this review
      // (#908), so test files are excluded from what the credit is pinned to.
      var simplifyFp = creditFingerprint('nontest');
      if (s.simplifyFingerprint !== simplifyFp) { s.simplifyFingerprint = simplifyFp; changed = true; }
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
      // #1332: invoking /verify starts a verification; it does not conclude
      // one. Clear any prior verdict so the run in progress cannot inherit the
      // PASS from a previous issue and satisfy check-before-done on its own.
      var verifyFp = creditFingerprint('all');
      if (!s.verifyRun || s.verifyOutcome || s.verifyFingerprint !== verifyFp) {
        s.verifyRun = true;
        s.verifyOutcome = null;
        s.verifyFingerprint = verifyFp;
        writeState(s);
      }
    } else if (vName) {
      process.stderr.write('gate: record-verify-run no-op — TOOL_INPUT_skill="' + vName + '" is not verify\n');
    }
    break;
  }
  case 'record-verify-outcome': {
    // #1332. Fires PostToolUse on mcp__moflo__memory_store. `record-verify-run`
    // above proves a verification was ATTEMPTED; this proves how it ENDED.
    //
    // The verdict is read from the structured record #1328 made /verify write
    // to memory_store's `metadata` — never parsed out of the prose `value`,
    // which is precisely the free-text dependency #1328 removed. gate-hook.mjs
    // forwards the object as JSON (see its MAX_STRUCTURED_LEN note).
    var mKey = process.env.TOOL_INPUT_key || '';
    if (mKey.indexOf('verify:') !== 0) break;
    var rawMeta = process.env.TOOL_INPUT_metadata || '';
    if (!rawMeta) {
      process.stderr.write('gate: record-verify-outcome — "' + mKey + '" carries no metadata; verdict not recorded\n');
      break;
    }
    var parsedMeta = null;
    try { parsedMeta = JSON.parse(rawMeta); } catch (e) { parsedMeta = null; }
    if (!parsedMeta || typeof parsedMeta !== 'object' || parsedMeta.type !== 'verify-record') break;
    var overall = typeof parsedMeta.overall === 'string' ? parsedMeta.overall.toUpperCase() : '';
    if (overall !== 'PASS' && overall !== 'FAIL' && overall !== 'UNVERIFIED') {
      process.stderr.write('gate: record-verify-outcome — unrecognised overall="' + parsedMeta.overall + '"; treating as not-passing\n');
      overall = 'UNVERIFIED';
    }
    var vs = readState();
    // #1348 — refuse a verdict for a run that is no longer live. `verifyRun`
    // false here means a code edit fired reset-edit-gates between the /verify
    // invocation and this store, so the verdict describes pre-edit code.
    // Recording it anyway produced the contradictory `verifyRun:false,
    // verifyOutcome:'PASS'` state that check-before-done's four-way message
    // chain has no branch for — it reports "a code edit invalidated the previous
    // verification" while a PASS sits in state, which reads as a gate bug.
    if (!vs.verifyRun) {
      process.stderr.write('gate: record-verify-outcome — "' + mKey + '" arrived after a code edit invalidated the run; verdict not recorded (re-run /verify)\n');
      break;
    }
    vs.verifyOutcome = overall;
    writeState(vs);
    break;
  }
  case 'reset-edit-gates': {
    var fp = process.env.TOOL_INPUT_file_path || '';
    // Inert files (markdown, lockfiles, CHANGELOG, .env.example) AND inert paths
    // (.github/workflows/, .github/ISSUE_TEMPLATE/, .github/PULL_REQUEST_TEMPLATE/, #1176):
    // no gate reset — editing these doesn't expose new runtime surface.
    if (fp && (EDIT_RESET_SKIP_BOTH_RE.test(fp) || EDIT_RESET_SKIP_PATH_RE.test(fp))) break;
    // #1348 — a scratchpad write under the OS temp dir is transient tool I/O and
    // can never reach the branch diff, but it used to reset tests + simplify +
    // verify like any source change: a /verify run that jotted a probe cleared
    // the /flo-simplify stamp, and the two gates invalidated each other with no
    // ordering that satisfied both. Reuses the predicate the memory-first gate
    // already trusts for these paths (#1294) rather than a second one.
    // Scope: tmp-only, NOT project-root containment — so a project rooted under
    // tmp has its own edits skipped too (pinned in the #1348 tests). Containment
    // is the more general rule, but it fails OPEN when the root can't be
    // resolved, and a gate that silently stops resetting is the worse failure.
    if (isEphemeralPath(fp)) break;
    var s = readState();
    // Test-only edits invalidate testsRun but preserve simplifyRun (#908).
    var isTestOnly = fp && EDIT_RESET_SKIP_SIMPLIFY_ONLY_RE.test(fp);
    var resetTests = s.testsRun;
    // A code edit invalidates a prior verification (Story #1274) — same as tests,
    // including test-only edits (the criteria being verified may have moved).
    // #1332: also fires when a verdict lingers without the flag, so no path
    // can leave a recorded outcome behind after a source edit.
    var resetVerify = s.verifyRun || !!s.verifyOutcome;
    var resetSimplify = s.simplifyRun && !isTestOnly;
    if (!resetTests && !resetSimplify && !resetVerify) break;
    var gates = [];
    if (resetTests) { s.testsRun = false; gates.push('tests'); }
    // #1332: drop the recorded verdict with the flag. Leaving a stale PASS
    // behind would let the next check-before-done pass on a verdict that
    // describes pre-edit code.
    if (resetVerify) { s.verifyRun = false; s.verifyOutcome = null; gates.push('verify'); }
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
    // Anchored to command-start so heredoc bodies and quoted strings that
    // contain the literal "gh pr create" don't trip the gate during regular
    // `git commit -m "...gh pr create..."` flows, while still catching the
    // chained, piped, parenthesised, and multi-line shapes (#1410).
    var cmd = process.env.TOOL_INPUT_command || '';
    if (!isPrCreateCommand(cmd)) break;
    // #1374 opened this loop; #1435 closes it. The count itself is unchanged —
    // what changed is that it now has teeth and, in warn mode, a delivery path.
    //
    // Deliberately ABOVE the no-source exemption below: a docs-only PR can
    // abandon a list exactly like a source PR can, and the exemption is about
    // testing/simplify/learnings, not about whether the run told the user what
    // it did. It also exits on its own rather than joining `missing` below, for
    // the same reason — `missing` is unreachable on an exempt diff.
    //
    // Gated on the same `task_create_first` flag as the reminder itself so the
    // two halves are always consistent: a project that turned the nag off is
    // not then blocked about the other end of it.
    //
    // Fail-open is load-bearing. readTaskLedger() returns null on a missing,
    // oversized, or unreadable transcript and on a session with no TaskCreate at
    // all, and null must never block — a gate that stops PRs because it could
    // not read a file is worse than the reporting gap it is closing.
    //
    // State is read ONCE for the whole case, here — the pre-PR gate logic below
    // reuses it and nothing writes in between. Reading it before the ledger also
    // means an already-acknowledged run never pays for the transcript scan.
    var s = readState();
    if (config.task_create_first && config.task_status_gate !== 'off' && !s.tasksAcknowledged) {
      var ledger = readTaskLedger();
      if (ledger && ledger.open > 0) {
        var tally = ledger.created + ' task' + (ledger.created === 1 ? '' : 's') +
          ' created this session, ' + ledger.open + ' still open.';
        var closeIt = 'Close them with TaskUpdate (status: completed), or delete the ones ' +
          'that no longer apply, so the run does not report done over an unfinished list.\n';
        if (config.task_status_gate === 'warn') {
          process.stdout.write('REMINDER: ' + tally + ' ' + closeIt);
        } else {
          process.stderr.write(
            'BLOCKED: ' + tally + '\n' + closeIt +
            'Deferring them on purpose is a legitimate outcome — declare it instead of\n' +
            'closing tasks that are not done: node "' + __filename + '" record-tasks-acknowledged\n' +
            GATE_ORIGIN_NOTE + '\n' +
            'Report instead of blocking via moflo.yaml: gates: task_status_gate: warn   (or: off)\n');
          process.exit(2);
        }
      }
    }
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
    // Expire any credit whose fingerprint no longer matches the code before
    // reading the flags. This is what catches the mutations reset-edit-gates
    // structurally cannot see — Bash writes, git checkout/pull/merge, and the
    // next issue in the same session — so the flags below mean "still true of
    // THIS code", not merely "was true at some point this session".
    var expired = [];
    if (s.testsRun && !creditIsLive(s.testsRun, s.testsFingerprint, 'all')) {
      s.testsRun = false; s.testsFingerprint = null; expired.push('tests');
    }
    if (s.simplifyRun && !creditIsLive(s.simplifyRun, s.simplifyFingerprint, 'nontest')) {
      s.simplifyRun = false; s.simplifyFingerprint = null; expired.push('simplify');
    }
    if ((s.verifyRun || s.verifyOutcome) && !creditIsLive(s.verifyRun, s.verifyFingerprint, 'all')) {
      s.verifyRun = false; s.verifyOutcome = null; s.verifyFingerprint = null; expired.push('verify');
    }
    if (expired.length) writeState(s);
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
    if (config.testing_gate && !s.testsRun) missing.push('tests have not run green since the last code edit (run npm test, vitest, jest, pytest, or similar — a run whose output reports failures does not count)');
    if (config.simplify_gate && !s.simplifyRun) missing.push('/flo-simplify (or /distill) has not run since the last code edit');
    if (config.learnings_gate && !s.learningsStored) missing.push(LEARNINGS_MISSING);
    if (missing.length === 0) break;
    process.stderr.write('BLOCKED: gh pr create requires the following before opening a PR:\n');
    for (var i = 0; i < missing.length; i++) {
      process.stderr.write('  - ' + missing[i] + '\n');
    }
    if (expired.length) {
      process.stderr.write(
        'Expired because the code changed since they ran (' + expired.join(', ') +
        ') — this includes changes made outside Write/Edit, e.g. a Bash write, ' +
        'git checkout/pull, or moving on to a different change in the same session.\n',
      );
    }
    if (s.lastResetBy && s.lastResetBy.file) {
      process.stderr.write('Last gate reset: ' + s.lastResetBy.file + ' (' + (s.lastResetBy.gates || []).join(', ') + ')\n');
    }
    // #1348 — name the order, not just the missing gate. Satisfying one gate can
    // invalidate another (/flo-simplify edits code, which resets tests + verify),
    // so "what is missing" alone left callers rediscovering the sequence by trial.
    process.stderr.write(ORDER_HINT);
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
    if (!isPrCreateCommand(cmd)) break;
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
    // Expire a verdict that no longer describes the code, for the same reason
    // check-before-pr does: a PASS earned before a Bash write, a branch switch,
    // or the next change in this session is evidence about different code.
    // #1332 made the gate read the outcome instead of attendance; this makes it
    // read an outcome that is still ABOUT the thing being shipped.
    var verifyStale = (sd.verifyRun || sd.verifyOutcome)
      && !creditIsLive(sd.verifyRun, sd.verifyFingerprint, 'all');
    if (verifyStale) {
      sd.verifyRun = false; sd.verifyOutcome = null; sd.verifyFingerprint = null;
      writeState(sd);
    }
    // #1332: gate on the OUTCOME, not on attendance. Before this, `verifyRun`
    // alone opened the gate, so a /verify returning FAIL satisfied it exactly
    // as a PASS did — a failing verdict is still a successful tool invocation.
    if (sd.verifyRun && sd.verifyOutcome === 'PASS') break;
    process.stderr.write('BLOCKED: gh pr create requires verification before done:\n');
    // The four states need different remedies, so name which one applies
    // rather than emitting one message that fits none of them.
    var invalidated = sd.lastResetBy && sd.lastResetBy.file
      && (sd.lastResetBy.gates || []).indexOf('verify') >= 0;
    if (verifyStale) {
      process.stderr.write('  - the code changed since /verify ran — re-run /verify\n');
      process.stderr.write('    (detected by content, so this covers changes made outside Write/Edit:\n');
      process.stderr.write('     a Bash write, git checkout/pull, or a different change in the same session)\n');
    } else if (!sd.verifyRun && invalidated) {
      process.stderr.write('  - a code edit invalidated the previous verification — re-run /verify\n');
      process.stderr.write('Last gate reset: ' + sd.lastResetBy.file + ' (verify)\n');
    } else if (!sd.verifyRun) {
      process.stderr.write('  - the change has not been verified since the last code edit (run /verify)\n');
    } else if (sd.verifyOutcome === 'FAIL' || sd.verifyOutcome === 'UNVERIFIED') {
      process.stderr.write('  - /verify ran and returned ' + sd.verifyOutcome + ' — fix the failing criteria, then re-run /verify\n');
      process.stderr.write('    (a FAIL is a real result, not a gate error; the PR is blocked because the change did not meet its acceptance criteria)\n');
    } else {
      // Ran, but no verdict reached the gate. TWO very different causes, and
      // #1394 exists because they used to share one message that fit only the
      // first: either /verify never recorded a structured outcome, or the hook
      // that TRANSCRIBES the outcome is not wired, in which case a perfectly
      // correct verdict was stored and nothing could carry it to the gate.
      // Blaming the agent for the second case sends the user into an unbounded
      // retry loop — re-running /verify cannot fix absent wiring.
      if (!isVerifyOutcomeHookWired()) {
        process.stderr.write('  - `record-verify-outcome` is not wired in .claude/settings.json — the verdict cannot be recorded\n');
        process.stderr.write('    /verify may well have passed; nothing exists to transcribe its result, so re-running it will not help.\n');
        process.stderr.write('    Fix: run `flo doctor --fix`, restart the session (Claude Code loads hooks only at start), then re-run /verify.\n');
      } else {
        process.stderr.write('  - /verify ran but recorded no verdict — re-run it so it stores a structured result\n');
        process.stderr.write('    (Step 5 of the verify skill must pass metadata.overall to memory_store)\n');
        // #1348 — the trap this state sets: re-invoking /verify CLEARS any prior
        // verdict by design (#1332), so the obvious recovery lands right back here
        // unless Step 5 completes. Say so, rather than letting it be rediscovered.
        process.stderr.write('    Re-invoking /verify clears the prior verdict, so a re-run that skips Step 5 lands here again.\n');
      }
    }
    process.stderr.write(ORDER_HINT);
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
      if (matchesDangerous(cmd, DANGEROUS[i])) {
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
    // Record the MAIN-LOOP session id so `flo run finalize` can attribute
    // transcript token usage to a run (#1333). UserPromptSubmit fires only for
    // the top-level session — subagents never submit a user prompt — so unlike
    // the per-actor `memorySearchedBy` map this is unambiguously the session
    // whose transcript carries the run. Survives applyPromptStateReset by being
    // written after it; refreshed every prompt, so a /clear that mints a new id
    // is picked up on the next turn rather than going stale.
    if (process.env.HOOK_SESSION_ID) s.sessionId = process.env.HOOK_SESSION_ID;
    writeState(s);
    // Announce the resolved /flo run modifiers. The gate already parsed
    // moflo.yaml in THIS process (fresh per prompt — a git pull or a mid-session
    // yaml edit is picked up automatically, no cache to invalidate), so this
    // costs no extra read. Emitting it is what closes the loop: the skill used
    // to carry `let sddMode = false` as a literal and the model executed it,
    // silently ignoring `sdd.default: true`. Only fires on /fl|/flo prompts.
    var floRun = resolveFloRun(prompt);
    if (floRun.isFlo) {
      console.log(
        '[moflo] /flo run modes (AUTHORITATIVE — use verbatim; do NOT re-derive from the skill defaults): ' +
        'sdd=' + (floRun.sdd ? 'ON' : 'off') +
        ' verify=' + (floRun.verify ? 'ON' : 'off') +
        ' merge=' + (floRun.merge ? 'ON' : 'off') +
        ' [workflow=' + floRun.workflow + ']'
      );
      // Spell out the surprising case: a project default the user did not type.
      if (floRun.sdd && floRun.sddSrc !== 'flag') {
        console.log(
          '[moflo] sdd is ON via ' + floRun.sddSrc + ' — the spec→plan→implement→verify cycle is ' +
          'MANDATORY this run. Author the spec before editing source (the sdd_gate blocks source ' +
          'Write/Edit until a reviewed plan exists). One-off opt out: re-run with --no-sdd.'
        );
      }
      if (floRun.merge && floRun.mergeSrc !== 'flag') {
        console.log('[moflo] merge is ON via ' + floRun.mergeSrc + ' — the PR will be auto-merged. Opt out: --no-merge.');
      }
    }
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
    var prompt = process.env.CLAUDE_USER_PROMPT || '';
    // #1447 — a safety net that cannot see the prompt must do NOTHING, not
    // decide. This bridge did not forward `prompt` until #1447, so this hook
    // classified the empty string on every prompt, concluded "no memory
    // required", and wrote that over the correct value prompt-reminder had just
    // computed — disarming the memory gate it exists to protect, intermittently,
    // depending on which UserPromptSubmit hook wrote last. The forwarding fix
    // addresses the cause; this guard makes the failure mode survivable if the
    // field ever goes missing again (a host that omits it, a payload change):
    // still invalidate the credits — that is this hook's whole reason to exist
    // and needs no prompt — but leave the arming verdict to prompt-reminder,
    // which has the text. Deciding "not required" from a prompt it cannot see
    // is exactly the bug.
    var s = readState();
    var before = JSON.stringify(s);
    applyPromptStateReset(s, prompt, { skipArming: !prompt });
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
