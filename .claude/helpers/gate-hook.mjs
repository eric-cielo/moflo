#!/usr/bin/env node
import { execFileSync } from 'child_process';
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
// per-actor (#838) — each spawned subagent gets its own session_id, so a
// shared workflow-state.json no longer lets one subagent's directive be
// silently satisfied by the parent's earlier search.
if (typeof hookContext.session_id === 'string' && hookContext.session_id) {
  env.HOOK_SESSION_ID = hookContext.session_id;
}
// #1332: structured tool inputs are forwarded as JSON, not dropped.
//
// This previously forwarded ONLY string values, so any object-valued input was
// invisible to gate.cjs. That blocked the verify-before-done gate from reading
// `/verify`'s per-criterion verdict, which #1328 stores in memory_store's
// `metadata` — an object. Parsing the verdict out of the prose `value` string
// instead would re-create exactly the free-text dependency #1328 removed.
//
// Cross-platform (Rule #1): Windows caps a single environment variable at
// ~32KB and the whole block at ~32K wide chars, and exceeding it fails the
// spawn rather than truncating. Newly-forwarded values are therefore skipped
// when oversized, not clipped — a truncated JSON blob would parse as malformed
// on the far side and read as a corrupt record rather than an absent one.
// `metadata` is capped at 64KB by memory_store, so a real verdict never nears
// this. STRING values keep their previous uncapped behaviour byte-for-byte:
// gate.cjs reads TOOL_INPUT_command, and dropping an oversized heredoc command
// would silently stop check-dangerous-command from firing on the exact inputs
// most worth checking.
var MAX_STRUCTURED_LEN = 16384;
if (hookContext.tool_input && typeof hookContext.tool_input === 'object') {
  Object.keys(hookContext.tool_input).forEach(function(key) {
    var raw = hookContext.tool_input[key];
    if (typeof raw === 'string') {
      env['TOOL_INPUT_' + key] = raw;
      return;
    }
    var val;
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      val = String(raw);
    } else if (raw && typeof raw === 'object') {
      try { val = JSON.stringify(raw); } catch (e) { return; }
    } else {
      return; // null/undefined/function — nothing meaningful to forward
    }
    if (val.length > MAX_STRUCTURED_LEN) return;
    env['TOOL_INPUT_' + key] = val;
  });
}

// #1322: forward the parts of tool_response that actually exist, so a gate can
// observe an OUTCOME rather than only the intent it was handed.
//
// Claude Code's PostToolUse payload carries NO exit status — probed on v2.1.220,
// tool_response for a Bash call is {stdout, stderr, interrupted, isImage,
// noOutputExpected}. PostToolUse also does not fire at all when the command
// exits non-zero, so the only case a gate can still be fooled by is an exit code
// MASKED by a pipe or `|| true`, where the response looks clean. The runner's
// own output is the sole remaining signal; record-test-run reads it in gate.cjs.
//
// Tail, not head. Every test runner prints its pass/fail summary LAST, so
// clipping the front of a long log would discard the exact lines this exists to
// read. Bounds are deliberately tight — Windows caps the whole environment
// block at ~32K wide chars and fails the spawn rather than truncating, and
// TOOL_INPUT_command is already forwarded uncapped alongside these.
var MAX_RESPONSE_STDOUT = 4096;
var MAX_RESPONSE_STDERR = 2048;
function tailOf(value, max) {
  return value.length > max ? value.slice(value.length - max) : value;
}
if (hookContext.tool_response && typeof hookContext.tool_response === 'object') {
  var resp = hookContext.tool_response;
  if (typeof resp.stdout === 'string' && resp.stdout) {
    env.TOOL_RESPONSE_stdout = tailOf(resp.stdout, MAX_RESPONSE_STDOUT);
  }
  if (typeof resp.stderr === 'string' && resp.stderr) {
    env.TOOL_RESPONSE_stderr = tailOf(resp.stderr, MAX_RESPONSE_STDERR);
  }
  // Boolean — the string-typed forwarding above would drop it silently.
  if (typeof resp.interrupted === 'boolean') {
    env.TOOL_RESPONSE_interrupted = String(resp.interrupted);
  }
}

// Run gate.cjs with the enriched environment
var projectDir = (env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/^\/([a-z])\//i, '$1:/');
var gateScript = resolve(projectDir, '.claude/helpers/gate.cjs');
try {
  var output = execFileSync('node', [gateScript, command], {
    env: env, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  if (output.trim()) process.stdout.write(output);
  process.exit(0);
} catch (err) {
  // gate.cjs exit(2) = block, exit(1) = also block attempt — translate both to exit(2)
  if (err.stderr) process.stderr.write(err.stderr);
  if (err.stdout) process.stderr.write(err.stdout);
  process.exit(err.status === 2 || err.status === 1 ? 2 : 0);
}
