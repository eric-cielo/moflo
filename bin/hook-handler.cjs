#!/usr/bin/env node
'use strict';
var fs = require('fs');
var path = require('path');

var PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
var METRICS_FILE = path.join(PROJECT_DIR, '.claude-flow', 'metrics', 'learning.json');
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
    case 'session-end': {
      // Kill tracked background processes via shared sync helper
      try {
        var cleanup = require('./lib/registry-cleanup.cjs');
        var killed = cleanup.killTrackedSync(PROJECT_DIR);
        if (killed > 0) console.log('[CLEANUP] Killed ' + killed + ' background process(es)');
      } catch (e) { /* non-fatal: cleanup module not available */ }
      console.log('[OK] Session ended');
      break;
    }
    case 'notification':
      // Silent — just acknowledge
      break;
    default:
      if (command) console.log('[OK] Hook: ' + command);
      break;
  }
});
