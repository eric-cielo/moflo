#!/usr/bin/env node
/**
 * Cross-platform Claude Code hook runner
 * Works on Windows (cmd/powershell) and Linux/WSL (bash)
 *
 * Usage: node .claude/scripts/hooks.mjs <hook-type> [args...]
 *
 * Hook types:
 *   pre-edit --file <path>
 *   post-edit --file <path> --success <bool>
 *   pre-command --command <cmd>
 *   post-command --command <cmd> --success <bool>
 *   pre-task --description <desc>
 *   post-task --task-id <id> --success <bool>
 *   session-start
 *   session-restore --session-id <id>
 *   route --task <prompt>
 *   index-guidance [--file <path>] [--force]
 *   daemon-start
 */

import { spawn } from 'child_process';
import { existsSync, appendFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');
const logFile = resolve(projectRoot, '.swarm/hooks.log');

// Parse command line args
const args = process.argv.slice(2);
const hookType = args[0];

// Simple log function - writes to .swarm/hooks.log
function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] [${hookType || 'unknown'}] ${message}\n`;

  // Always log errors to stderr so they're visible in Claude
  if (level === 'error') {
    console.error(`[hook:${hookType}] ${message}`);
  }

  // Also append to log file for history
  try {
    appendFileSync(logFile, line);
  } catch {
    // Can't write log - that's fine, don't fail
  }
}

// Helper to get arg value
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  // Also check environment variables (Claude sets these)
  const envName = `TOOL_INPUT_${name}`.replace(/-/g, '_');
  return process.env[envName] || process.env[name.toUpperCase()] || null;
}

// Helper to check if arg/flag exists
function hasArg(name) {
  return args.includes(`--${name}`);
}

// Get the local CLI path (preferred - no network/extraction overhead)
function getLocalCliPath() {
  const localCli = resolve(projectRoot, 'node_modules/moflo/src/@claude-flow/cli/bin/cli.js');
  return existsSync(localCli) ? localCli : null;
}

// Check if running on Windows
const isWindows = process.platform === 'win32';

// Run a command and return promise with exit code
function runCommand(cmd, cmdArgs, options = {}) {
  return new Promise((resolve) => {
    let stderr = '';

    // Use windowsHide: true directly - no PowerShell wrapper needed
    // The wrapper can actually cause MORE flashes as PowerShell starts
    const proc = spawn(cmd, cmdArgs, {
      stdio: options.silent ? ['ignore', 'ignore', 'pipe'] : 'inherit',
      shell: false,
      cwd: projectRoot,
      env: { ...process.env, ...options.env },
      detached: options.background || false,
      windowsHide: true  // This is sufficient on Windows when shell: false
    });

    // Capture stderr even in silent mode
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code !== 0 && stderr) {
        log('error', `Command failed (exit ${code}): ${cmd} ${cmdArgs.join(' ')}`);
        if (stderr.trim()) {
          log('error', `  stderr: ${stderr.trim().substring(0, 200)}`);
        }
      }
      resolve(code || 0);
    });

    proc.on('error', (err) => {
      log('error', `Command error: ${cmd} - ${err.message}`);
      resolve(1);
    });
  });
}

// Show Windows toast notification (works on native Windows and WSL)
async function showWindowsToast(title, message) {
  // PowerShell script to show toast notification
  const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $template.GetElementsByTagName('text')
$text.Item(0).AppendChild($template.CreateTextNode('${title.replace(/'/g, "''")}')) | Out-Null
$text.Item(1).AppendChild($template.CreateTextNode('${message.replace(/'/g, "''")}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show($toast)
`.trim();

  // Encode script as base64 for -EncodedCommand (avoids shell escaping issues)
  const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');

  try {
    // Detect environment and use appropriate PowerShell command
    const isWSL = process.platform === 'linux' && existsSync('/proc/version') &&
      (await import('fs')).readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');

    if (process.platform === 'win32') {
      // Native Windows - use powershell with encoded command (avoids cmd.exe escaping issues)
      await runCommand('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript], { silent: true });
      log('debug', 'Toast notification sent via PowerShell');
    } else if (isWSL) {
      // WSL - use powershell.exe to call Windows PowerShell
      await runCommand('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript], { silent: true });
      log('debug', 'Toast notification sent via powershell.exe (WSL)');
    } else {
      // Linux/Mac - no Windows toast available, just log
      log('debug', 'Windows toast not available on this platform');
    }
  } catch (err) {
    // Toast notifications are nice-to-have, don't fail the hook
    log('debug', `Toast notification failed: ${err.message}`);
  }
}

// Run claude-flow CLI command using local installation
async function runClaudeFlow(subcommand, cliArgs = []) {
  const localCli = getLocalCliPath();

  if (localCli) {
    // Use local CLI (fastest, no network/extraction)
    const fullArgs = [localCli, subcommand, ...cliArgs];
    const exitCode = await runCommand('node', fullArgs, { silent: true });

    if (exitCode !== 0) {
      log('warn', `claude-flow ${subcommand} exited with code ${exitCode}`);
    }

    return exitCode;
  } else {
    log('warn', 'Local CLI not found. Install with: npm install @claude-flow/cli');
    return 1;
  }
}

// Main hook dispatcher
async function main() {
  if (!hookType) {
    console.error('Usage: node hooks.mjs <hook-type> [args...]');
    process.exit(1);
  }

  try {
    switch (hookType) {
      case 'pre-edit': {
        const file = getArg('file') || process.env.TOOL_INPUT_file_path;
        if (file) {
          await runClaudeFlow('hooks', ['pre-edit', '--file', file]);
        }
        break;
      }

      case 'post-edit': {
        const file = getArg('file') || process.env.TOOL_INPUT_file_path;
        const success = getArg('success') || process.env.TOOL_SUCCESS || 'true';
        if (file) {
          await runClaudeFlow('hooks', ['post-edit', '--file', file, '--success', success]);

          // Check if this is a guidance file that needs indexing (run in background)
          if (file.includes('.claude/guidance/') || file.includes('.claude/skills/cl/')) {
            runIndexGuidanceBackground(file);
          }
        }
        break;
      }

      case 'pre-command': {
        const command = getArg('command') || process.env.TOOL_INPUT_command;
        if (command) {
          await runClaudeFlow('hooks', ['pre-command', '--command', command]);
        }
        break;
      }

      case 'post-command': {
        const command = getArg('command') || process.env.TOOL_INPUT_command;
        const success = getArg('success') || process.env.TOOL_SUCCESS || 'true';
        if (command) {
          await runClaudeFlow('hooks', ['post-command', '--command', command, '--success', success]);
        }
        break;
      }

      case 'pre-task': {
        const description = getArg('description') || process.env.TOOL_INPUT_prompt;
        if (description) {
          const taskId = `task-${Date.now()}`;
          await runClaudeFlow('hooks', ['pre-task', '--task-id', taskId, '--description', description]);
        }
        break;
      }

      case 'pre-research': {
        // Memory-first gate: remind to search memory before exploring codebase
        // This fires on Glob/Grep to catch research-style queries
        const pattern = process.env.TOOL_INPUT_pattern || getArg('pattern');
        const query = process.env.TOOL_INPUT_query || getArg('query');
        const searchTerm = pattern || query;

        // Only remind if this looks like a research query (not a specific path lookup)
        if (searchTerm && !searchTerm.includes('/') && !searchTerm.match(/\.(ts|tsx|js|json|md)$/)) {
          console.log('[MEMORY GATE] Did you search memory first? Run: memory search --query "[topic]" --namespace guidance');
        }
        break;
      }

      case 'post-task': {
        const taskId = getArg('task-id') || process.env.TOOL_RESULT_agent_id;
        const success = getArg('success') || process.env.TOOL_SUCCESS || 'true';
        if (taskId) {
          await runClaudeFlow('hooks', ['post-task', '--task-id', taskId, '--success', success]);
        }
        break;
      }

      case 'session-start': {
        // All startup tasks run in background (non-blocking)
        // Start daemon quietly in background
        runDaemonStartBackground();
        // Index guidance files in background
        runIndexGuidanceBackground();
        // Generate structural code map in background
        runCodeMapBackground();
        // Run pretrain in background to extract patterns from repository
        runBackgroundPretrain();
        // Force HNSW rebuild to ensure all processes use identical fresh index
        // This fixes agent search result mismatches (0.61 vs 0.81 similarity)
        runHNSWRebuildBackground();
        // Neural patterns now loaded by moflo core routing — no external patching.
        break;
      }

      case 'session-restore': {
        const sessionId = getArg('session-id') || process.env.SESSION_ID;
        if (sessionId) {
          await runClaudeFlow('hooks', ['session-restore', '--session-id', sessionId]);
        }
        break;
      }

      case 'route': {
        const task = getArg('task') || process.env.PROMPT;
        if (task) {
          // Check for /cl command and output gate reminder
          if (task.includes('/cl') || task.match(/^cl\s/)) {
            const hasHelpFlag = task.includes('-h') || task.includes('--help');
            const hasNakedFlag = task.includes('-n') || task.includes('--naked');

            if (!hasHelpFlag && !hasNakedFlag) {
              // Output visible reminder - this appears in Claude's context
              console.log('[SWARM GATE] /cl detected. Required order: TaskList() → TaskCreate() → swarm init → Task(run_in_background)');
              console.log('[SWARM GATE] Do NOT call GitHub/Grep/Read until tasks are created.');
            }
          }
          await runClaudeFlow('hooks', ['route', '--task', task]);
        }
        break;
      }

      case 'index-guidance': {
        const file = getArg('file');
        await runIndexGuidance(file);
        break;
      }

      case 'daemon-start': {
        if (!isDaemonRunning()) {
          await runClaudeFlow('daemon', ['start', '--quiet']);
        } else {
          log('info', 'Daemon already running, skipping start');
        }
        break;
      }

      case 'session-end': {
        // Run ReasoningBank and MicroLoRA training in background on session end
        log('info', 'Session ending - starting background learning...');

        // Run session-end hook (persists state)
        await runClaudeFlow('hooks', ['session-end', '--persist-state', 'true']);

        // Start background training (non-blocking)
        runBackgroundTraining();
        break;
      }


      case 'semantic-search': {
        // Semantic search using embeddings
        const query = getArg('query') || args[1];
        const searchLimit = getArg('limit') || '5';
        const threshold = getArg('threshold') || '0.3';
        const searchScript = resolve(projectRoot, 'bin/semantic-search.mjs');

        if (query && existsSync(searchScript)) {
          const searchArgs = [searchScript, query, '--limit', searchLimit, '--threshold', threshold];
          if (getArg('namespace')) searchArgs.push('--namespace', getArg('namespace'));
          if (hasArg('json')) searchArgs.push('--json');
          // semantic-search.mjs uses better-sqlite3
          await runCommand('node', searchArgs, { silent: false });
        } else if (!query) {
          console.log('Usage: node .claude/scripts/hooks.mjs semantic-search --query "your query"');
        } else {
          log('error', 'Semantic search script not found');
        }
        break;
      }

      case 'notification': {
        // Handle notification hook - show Windows toast if possible
        const message = process.env.NOTIFICATION_MESSAGE || getArg('message') || 'Claude Code needs your attention';
        const title = getArg('title') || 'Claude Code';
        await showWindowsToast(title, message);
        log('info', 'Notification hook triggered');
        break;
      }

      default:
        // Unknown hook type - just pass through to claude-flow
        log('info', `Passing through unknown hook: ${hookType}`);
        await runClaudeFlow('hooks', args);
    }
  } catch (err) {
    // Log the error but don't block Claude
    log('error', `Hook exception: ${err.message}`);
    process.exit(0);
  }

  process.exit(0);
}

// Run the guidance indexer (blocking - used for specific file updates)
async function runIndexGuidance(specificFile = null) {
  const indexCandidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), 'index-guidance.mjs'),
    resolve(projectRoot, '.claude/scripts/index-guidance.mjs'),
  ];
  const indexScript = indexCandidates.find(p => existsSync(p));

  if (indexScript) {
    const indexArgs = specificFile ? ['--file', specificFile] : [];
    if (hasArg('force')) indexArgs.push('--force');
    // index-guidance.mjs uses better-sqlite3
    const code = await runCommand('node', [indexScript, ...indexArgs], { silent: true });
    if (code !== 0) {
      log('warn', `index-guidance.mjs exited with code ${code}`);
    }
    return code;
  }

  log('warn', 'Guidance indexer not found');
  return 0;
}

// Spawn a background process that's truly windowless on Windows
function spawnWindowless(cmd, args, description) {
  const proc = spawn(cmd, args, {
    cwd: projectRoot,
    stdio: 'ignore',
    detached: true,
    shell: false,
    windowsHide: true
  });

  proc.unref();
  log('info', `Started ${description} (PID: ${proc.pid})`);
  return proc;
}

// Resolve a moflo npm bin script, falling back to local .claude/scripts/ copy
function resolveBinOrLocal(binName, localScript) {
  // 1. npm bin from moflo package (always up to date with published version)
  const mofloScript = resolve(projectRoot, 'node_modules/moflo/bin', localScript);
  if (existsSync(mofloScript)) return mofloScript;

  // 2. npm bin from .bin (symlinked by npm install)
  const npmBin = resolve(projectRoot, 'node_modules/.bin', binName);
  if (existsSync(npmBin)) return npmBin;

  // 3. Local .claude/scripts/ copy (may be stale but better than nothing)
  const localPath = resolve(projectRoot, '.claude/scripts', localScript);
  if (existsSync(localPath)) return localPath;

  return null;
}

// Run the guidance indexer in background (non-blocking - used for session start and file changes)
function runIndexGuidanceBackground(specificFile = null) {
  const indexScript = resolveBinOrLocal('flo-index', 'index-guidance.mjs');

  if (!indexScript) {
    log('warn', 'Guidance indexer not found (checked npm bin + .claude/scripts/)');
    return;
  }

  const indexArgs = [indexScript];
  if (specificFile) indexArgs.push('--file', specificFile);

  const desc = specificFile ? `background indexing file: ${specificFile}` : 'background indexing (full)';
  spawnWindowless('node', indexArgs, desc);
}

// Run structural code map generator in background (non-blocking)
function runCodeMapBackground() {
  const codeMapScript = resolveBinOrLocal('flo-codemap', 'generate-code-map.mjs');

  if (!codeMapScript) {
    log('warn', 'Code map generator not found (checked npm bin + .claude/scripts/)');
    return;
  }

  spawnWindowless('node', [codeMapScript], 'background code map generation');
}

// Run ReasoningBank + MicroLoRA training + EWC++ consolidation in background (non-blocking)
function runBackgroundTraining() {
  const localCli = getLocalCliPath();
  if (!localCli) {
    log('warn', 'Local CLI not found, skipping background training');
    return;
  }

  // Pattern types to train with MicroLoRA
  const patternTypes = ['coordination', 'routing', 'debugging'];

  for (const ptype of patternTypes) {
    spawnWindowless('node', [localCli, 'neural', 'train', '--pattern-type', ptype, '--epochs', '2'], `MicroLoRA training: ${ptype}`);
  }

  // Run pretrain to update ReasoningBank
  spawnWindowless('node', [localCli, 'hooks', 'pretrain'], 'ReasoningBank pretrain');

  // Run EWC++ memory consolidation (prevents catastrophic forgetting)
  spawnWindowless('node', [localCli, 'hooks', 'worker', 'dispatch', '--trigger', 'consolidate', '--background'], 'EWC++ consolidation');

  // Run neural optimize (Int8 quantization, memory compression)
  spawnWindowless('node', [localCli, 'neural', 'optimize'], 'neural optimize');
}

// Check if daemon is already running via PID file.
// Returns true if a live daemon process exists, false otherwise.
function isDaemonRunning() {
  const pidFile = resolve(projectRoot, '.claude-flow', 'daemon.pid');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid && !isNaN(pid)) {
        process.kill(pid, 0); // signal 0 = check if process exists, doesn't kill
        return true;
      }
    } catch {
      // Process doesn't exist — stale PID file
    }
  }
  return false;
}

// Run daemon start in background (non-blocking) — skip if already running
function runDaemonStartBackground() {
  const localCli = getLocalCliPath();
  if (!localCli) {
    log('warn', 'Local CLI not found, skipping daemon start');
    return;
  }

  if (isDaemonRunning()) {
    log('info', 'Daemon already running, skipping start');
    return;
  }

  spawnWindowless('node', [localCli, 'daemon', 'start', '--quiet'], 'daemon');
}

// Run pretrain in background on session start (non-blocking)
function runBackgroundPretrain() {
  const localCli = getLocalCliPath();
  if (!localCli) {
    log('warn', 'Local CLI not found, skipping background pretrain');
    return;
  }

  spawnWindowless('node', [localCli, 'hooks', 'pretrain'], 'background pretrain');
}

// Force HNSW rebuild in background to ensure all processes use identical fresh index
// This fixes the issue where spawned agents return different search results than CLI/MCP
function runHNSWRebuildBackground() {
  const localCli = getLocalCliPath();
  if (!localCli) {
    log('warn', 'Local CLI not found, skipping HNSW rebuild');
    return;
  }

  spawnWindowless('node', [localCli, 'memory', 'rebuild', '--force'], 'HNSW rebuild');
}

// Neural pattern application — now handled by moflo core routing (learned patterns
// loaded from routing-outcomes.json by hooks-tools.ts getSemanticRouter).
// No external patch script needed.

main().catch((err) => {
  log('error', `Unhandled exception: ${err.message}`);
  process.exit(0);
});
