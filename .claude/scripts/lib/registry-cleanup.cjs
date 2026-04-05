/**
 * Synchronous cleanup of the ProcessManager background-pids registry.
 *
 * Safe to call from CJS hooks that run under process.exit() — no async,
 * no ESM imports, pure fs + process.kill.
 *
 * Used by: .claude/helpers/hook-handler.cjs, bin/hook-handler.cjs (session-end)
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

/**
 * Kill all tracked background processes and clear the registry.
 * @param {string} projectDir - absolute path to the project root
 * @returns {number} count of processes killed
 */
function killTrackedSync(projectDir) {
  var pidFile = path.join(projectDir, '.claude-flow', 'background-pids.json');
  var lockFile = path.join(projectDir, '.claude-flow', 'spawn.lock');
  var killed = 0;

  try {
    if (fs.existsSync(pidFile)) {
      var entries = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
      if (!Array.isArray(entries)) entries = [];
      for (var i = 0; i < entries.length; i++) {
        try { process.kill(entries[i].pid, 0); } catch (e) { continue; }
        try {
          if (process.platform === 'win32') {
            childProcess.execFileSync('taskkill', ['/F', '/PID', String(entries[i].pid)], { windowsHide: true });
          } else {
            process.kill(entries[i].pid, 'SIGTERM');
          }
          killed++;
        } catch (e) { /* ok */ }
      }
      fs.writeFileSync(pidFile, '[]');
    }
  } catch (e) { /* non-fatal */ }

  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (e) { /* ok */ }

  return killed;
}

module.exports = { killTrackedSync };
