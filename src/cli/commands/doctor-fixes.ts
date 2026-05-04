/**
 * Auto-fix dispatch for `flo doctor --fix`.
 *
 * Maps each named HealthCheck to a programmatic fix function (preferred over
 * shell-out where possible). Falls back to running the check's `fix` string
 * if it looks like an `npx`/`npm`/`claude` command.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { output } from '../output.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import { repairHookWiring } from '../services/hook-wiring.js';
import { findZombieProcesses } from './doctor-zombies.js';
import { installClaudeCode, runCommand } from './doctor-checks-runtime.js';
import type { HealthCheck } from './doctor-types.js';

/** Run a shell command as a fix action. Returns true on exit code 0. */
async function runFixCommand(cmd: string): Promise<boolean> {
  try {
    await runCommand(cmd, 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fix missing hook wiring in settings.json by patching in entries for any
 * REQUIRED_HOOK_WIRING patterns that aren't present. Delegates to shared
 * repairHookWiring() to stay DRY with the upgrade path.
 */
async function fixGateHealthHooks(): Promise<boolean> {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;

  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const { repaired } = repairHookWiring(settings);
    if (repaired.length === 0) return true; // nothing to fix

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute the fix for a failed/warned health check.
 * Returns true if the fix succeeded (re-check should pass).
 */
export async function autoFixCheck(check: HealthCheck): Promise<boolean> {
  if (!check.fix) return false;

  // Map checks to programmatic fixes (not just shell commands)
  const fixActions: Record<string, () => Promise<boolean>> = {
    'Memory Database': async () => {
      try {
        const swarmDir = join(process.cwd(), '.swarm');
        if (!existsSync(swarmDir)) mkdirSync(swarmDir, { recursive: true });
        const { initializeMemoryDatabase } = await import('../memory/memory-initializer.js');
        const result = await initializeMemoryDatabase({ force: true, verbose: false });
        return result.success;
      } catch {
        return runFixCommand('npx moflo memory init --force');
      }
    },
    'Embeddings': async () => {
      try {
        const swarmDir = join(process.cwd(), '.swarm');
        if (!existsSync(swarmDir)) mkdirSync(swarmDir, { recursive: true });
        const dbPath = join(swarmDir, 'memory.db');
        if (!existsSync(dbPath)) {
          const { initializeMemoryDatabase } = await import('../memory/memory-initializer.js');
          await initializeMemoryDatabase({ force: true, verbose: false });
        }
        return runFixCommand('npx moflo embeddings init --force');
      } catch {
        return runFixCommand('npx moflo memory init --force');
      }
    },
    'Config File': async () => {
      try {
        const cfDir = join(process.cwd(), '.moflo');
        if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
        return runFixCommand('npx moflo config init');
      } catch {
        return false;
      }
    },
    'Daemon Status': async () => {
      const lockFile = join(process.cwd(), '.moflo', 'daemon.lock');
      const pidFile = join(process.cwd(), '.moflo', 'daemon.pid');
      try {
        if (existsSync(lockFile)) unlinkSync(lockFile);
        if (existsSync(pidFile)) unlinkSync(pidFile);
      } catch { /* best effort */ }
      return runFixCommand('npx moflo daemon start');
    },
    'MCP Servers': async () => {
      return runFixCommand('claude mcp add moflo -- npx -y moflo mcp start');
    },
    'Claude Code CLI': async () => {
      return installClaudeCode();
    },
    'Zombie Processes': async () => {
      const result = await findZombieProcesses(true);
      return result.killed > 0 || result.details.length === 0;
    },
    'Gate Health': async () => {
      return fixGateHealthHooks();
    },
    'Status Line': async () => {
      const settingsPath = join(process.cwd(), '.claude', 'settings.json');
      if (!existsSync(settingsPath)) return false;
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        if (!settings.statusLine) {
          settings.statusLine = {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs" --compact',
          };
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        }
        return true;
      } catch {
        return false;
      }
    },
  };

  const fixFn = fixActions[check.name];
  if (fixFn) {
    try {
      output.writeln(output.dim(`  Fixing: ${check.name}...`));
      const success = await fixFn();
      if (success) {
        output.writeln(output.success(`  Fixed: ${check.name}`));
      } else {
        output.writeln(output.warning(`  Fix attempted but may need manual action: ${check.fix}`));
      }
      return success;
    } catch (e) {
      output.writeln(output.warning(`  Fix failed: ${errorDetail(e)}`));
      return false;
    }
  }

  // Generic: try running the fix command directly if it looks like a shell command
  if (check.fix.startsWith('npx ') || check.fix.startsWith('npm ') || check.fix.startsWith('claude ')) {
    return runFixCommand(check.fix);
  }

  return false;
}
