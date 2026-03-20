#!/usr/bin/env node
/**
 * Claude Flow Hook Handler (Cross-Platform)
 * Dispatches hook events to the appropriate helper modules.
 */

const path = require('path');
const fs = require('fs');

const helpersDir = __dirname;

function safeRequire(modulePath) {
  try {
    if (fs.existsSync(modulePath)) {
      const origLog = console.log;
      const origError = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        const mod = require(modulePath);
        return mod;
      } finally {
        console.log = origLog;
        console.error = origError;
      }
    }
  } catch (e) {
    // silently fail
  }
  return null;
}

const router = safeRequire(path.join(helpersDir, 'router.cjs'));
const session = safeRequire(path.join(helpersDir, 'session.cjs'));
const memory = safeRequire(path.join(helpersDir, 'memory.cjs'));
const intelligence = safeRequire(path.join(helpersDir, 'intelligence.cjs'));

const [,, command, ...args] = process.argv;

// Read stdin — Claude Code sends hook data as JSON via stdin
// Uses a timeout to prevent hanging when stdin is in an ambiguous state
// (not TTY, not a proper pipe) which happens with Claude Code hook invocations.
async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    }, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

async function main() {
  let stdinData = '';
  try { stdinData = await readStdin(); } catch (e) { /* ignore stdin errors */ }

  let hookInput = {};
  if (stdinData.trim()) {
    try { hookInput = JSON.parse(stdinData); } catch (e) { /* ignore parse errors */ }
  }

  // Merge stdin data into prompt resolution: prefer stdin fields, then env vars.
  // NEVER fall back to argv args — shell glob expansion of braces in bash output
  // creates junk files (#1342). Use env vars or stdin only.
  const prompt = hookInput.prompt || hookInput.command || hookInput.toolInput
    || process.env.PROMPT || process.env.TOOL_INPUT_command || '';

const handlers = {
  'route': () => {
    if (intelligence && intelligence.getContext) {
      try {
        const ctx = intelligence.getContext(prompt);
        if (ctx) console.log(ctx);
      } catch (e) { /* non-fatal */ }
    }
    if (router && router.routeTask) {
      const result = router.routeTask(prompt);
      var output = [];
      output.push('[INFO] Routing task: ' + (prompt.substring(0, 80) || '(no prompt)'));
      output.push('');
      output.push('+------------------- Primary Recommendation -------------------+');
      output.push('| Agent: ' + result.agent.padEnd(53) + '|');
      output.push('| Confidence: ' + (result.confidence * 100).toFixed(1) + '%' + ' '.repeat(44) + '|');
      output.push('| Reason: ' + result.reason.substring(0, 53).padEnd(53) + '|');
      output.push('+--------------------------------------------------------------+');
      console.log(output.join('\n'));
    } else {
      console.log('[INFO] Router not available, using default routing');
    }
  },

  'pre-bash': () => {
    var cmd = (hookInput.command || prompt).toLowerCase();
    var dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:'];
    for (var i = 0; i < dangerous.length; i++) {
      if (cmd.includes(dangerous[i])) {
        console.error('[BLOCKED] Dangerous command detected: ' + dangerous[i]);
        process.exit(1);
      }
    }
    console.log('[OK] Command validated');
  },

  'post-edit': () => {
    if (session && session.metric) {
      try { session.metric('edits'); } catch (e) { /* no active session */ }
    }
    if (intelligence && intelligence.recordEdit) {
      try {
        var file = hookInput.file_path || (hookInput.toolInput && hookInput.toolInput.file_path)
          || process.env.TOOL_INPUT_file_path || args[0] || '';
        intelligence.recordEdit(file);
      } catch (e) { /* non-fatal */ }
    }
    console.log('[OK] Edit recorded');
  },

  'session-restore': () => {
    if (session) {
      var existing = session.restore && session.restore();
      if (!existing) {
        session.start && session.start();
      }
    } else {
      console.log('No session to restore');
      console.log('Session started: session-' + Date.now());
    }
    if (intelligence && intelligence.init) {
      try {
        var result = intelligence.init();
        if (result && result.nodes > 0) {
          console.log('[INTELLIGENCE] Loaded ' + result.nodes + ' patterns, ' + result.edges + ' edges');
        }
      } catch (e) { /* non-fatal */ }
    }

    // Auto-index guidance, code map, and patterns on session start
    try {
      var projectDir = path.resolve(path.dirname(helpersDir), '..');
      var cp = require('child_process');

      // Read moflo.yaml auto_index flags (default: both true)
      var autoGuidance = true;
      var autoCodeMap = true;
      var mofloConfigPath = path.join(projectDir, 'moflo.yaml');
      var mofloJsonPath = path.join(projectDir, 'moflo.config.json');

      if (fs.existsSync(mofloConfigPath)) {
        try {
          var content = fs.readFileSync(mofloConfigPath, 'utf-8');
          if (/auto_index:\s*\n\s+guidance:\s*false/i.test(content)) autoGuidance = false;
          if (/auto_index:\s*\n(?:\s+guidance:\s*\w+\n)?\s+code_map:\s*false/i.test(content)) autoCodeMap = false;
        } catch (e) { /* ignore */ }
      } else if (fs.existsSync(mofloJsonPath)) {
        try {
          var config = JSON.parse(fs.readFileSync(mofloJsonPath, 'utf-8'));
          var ai = config.auto_index || config.autoIndex || {};
          if (ai.guidance === false) autoGuidance = false;
          if (ai.code_map === false || ai.codeMap === false) autoCodeMap = false;
        } catch (e) { /* ignore */ }
      }

      // Helper: find a moflo bin script by filename
      function findMofloScript(scriptName) {
        var candidates = [
          path.join(projectDir, 'bin', scriptName),
          path.join(projectDir, 'node_modules', 'moflo', 'bin', scriptName),
        ];
        for (var i = 0; i < candidates.length; i++) {
          if (fs.existsSync(candidates[i])) return candidates[i];
        }
        try {
          var resolved = require.resolve('moflo/bin/' + scriptName, { paths: [projectDir] });
          if (fs.existsSync(resolved)) return resolved;
        } catch (e) { /* not installed */ }
        return null;
      }

      function spawnBackground(script, extraArgs) {
        var args = [script].concat(extraArgs || []);
        cp.spawn('node', args, {
          stdio: 'ignore',
          cwd: projectDir,
          detached: true,
          windowsHide: true
        }).unref();
      }

      // 1. Index guidance docs (with embeddings for semantic search)
      if (autoGuidance) {
        var guidanceScript = findMofloScript('index-guidance.mjs');
        if (guidanceScript) spawnBackground(guidanceScript);
      }

      // 2. Generate code map (structural index of source files)
      if (autoCodeMap) {
        var codeMapScript = findMofloScript('generate-code-map.mjs');
        if (codeMapScript) spawnBackground(codeMapScript);
      }

      // 3. Start learning service (pattern research on codebase)
      var learnScript = findMofloScript('../.claude/helpers/learning-service.mjs');
      if (!learnScript) learnScript = findMofloScript('learning-service.mjs');
      // Also check the .claude/helpers location directly
      if (!learnScript) {
        var localLearn = path.join(projectDir, '.claude', 'helpers', 'learning-service.mjs');
        if (fs.existsSync(localLearn)) learnScript = localLearn;
      }
      // Check inside node_modules/moflo/.claude/helpers
      if (!learnScript) {
        var nmLearn = path.join(projectDir, 'node_modules', 'moflo', '.claude', 'helpers', 'learning-service.mjs');
        if (fs.existsSync(nmLearn)) learnScript = nmLearn;
      }
      if (learnScript) spawnBackground(learnScript);

    } catch (e) { /* non-fatal: session-start indexing is best-effort */ }
  },

  'session-end': () => {
    if (intelligence && intelligence.consolidate) {
      try {
        var result = intelligence.consolidate();
        if (result && result.entries > 0) {
          var msg = '[INTELLIGENCE] Consolidated: ' + result.entries + ' entries, ' + result.edges + ' edges';
          if (result.newEntries > 0) msg += ', ' + result.newEntries + ' new';
          msg += ', PageRank recomputed';
          console.log(msg);
        }
      } catch (e) { /* non-fatal */ }
    }
    if (session && session.end) {
      session.end();
    } else {
      console.log('[OK] Session ended');
    }
  },

  'pre-task': () => {
    if (session && session.metric) {
      try { session.metric('tasks'); } catch (e) { /* no active session */ }
    }
    if (router && router.routeTask && prompt) {
      var result = router.routeTask(prompt);
      console.log('[INFO] Task routed to: ' + result.agent + ' (confidence: ' + result.confidence + ')');
    } else {
      console.log('[OK] Task started');
    }
  },

  'post-task': () => {
    if (intelligence && intelligence.feedback) {
      try {
        intelligence.feedback(true);
      } catch (e) { /* non-fatal */ }
    }
    console.log('[OK] Task completed');
  },

  'compact-manual': () => {
    console.log('PreCompact Guidance:');
    console.log('IMPORTANT: Review CLAUDE.md in project root for:');
    console.log('   - Available agents and concurrent usage patterns');
    console.log('   - Swarm coordination strategies (hierarchical, mesh, adaptive)');
    console.log('   - Critical concurrent execution rules (1 MESSAGE = ALL OPERATIONS)');
    console.log('Ready for compact operation');
  },

  'compact-auto': () => {
    console.log('Auto-Compact Guidance (Context Window Full):');
    console.log('CRITICAL: Before compacting, ensure you understand:');
    console.log('   - All agents available in .claude/agents/ directory');
    console.log('   - Concurrent execution patterns from CLAUDE.md');
    console.log('   - Swarm coordination strategies for complex tasks');
    console.log('Apply GOLDEN RULE: Always batch operations in single messages');
    console.log('Auto-compact proceeding with full agent context');
  },

  'status': () => {
    console.log('[OK] Status check');
  },

  'stats': () => {
    if (intelligence && intelligence.stats) {
      intelligence.stats(args.includes('--json'));
    } else {
      console.log('[WARN] Intelligence module not available. Run session-restore first.');
    }
  },
};

if (command && handlers[command]) {
    try {
      handlers[command]();
    } catch (e) {
      console.log('[WARN] Hook ' + command + ' encountered an error: ' + e.message);
    }
  } else if (command) {
    console.log('[OK] Hook: ' + command);
  } else {
    console.log('Usage: hook-handler.cjs <route|pre-bash|post-edit|session-restore|session-end|pre-task|post-task|compact-manual|compact-auto|status|stats>');
  }
}

main().catch(function(e) {
  console.log('[WARN] Hook handler error: ' + e.message);
}).finally(function() {
  // Ensure clean exit for Claude Code hooks
  process.exit(0);
});
