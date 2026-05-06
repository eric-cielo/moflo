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

// #931 — Namespace hint classification moved into gate.cjs (computed by
// prompt-reminder, stored on workflow-state.json, emitted once by
// check-before-agent at Agent-spawn time). No per-prompt token leak now.

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

var parts = [restartNotice, output.trim()].filter(Boolean);
if (parts.length) process.stdout.write(parts.join('\n\n') + '\n');
process.exit(0);
