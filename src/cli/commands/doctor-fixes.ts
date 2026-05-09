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
import { getDaemonLockHolder } from '../services/daemon-lock.js';
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
 * Fix Gate Health failures: bin/.claude-helpers gate.cjs drift AND missing
 * settings.json hook wiring. The check has three independent failure modes
 * and the prior fix only handled hook wiring — leaving bin/helper drift
 * unresolved while still claiming success (the "Auto-fixed 1 issue" lie that
 * surfaced when #920 mirrored the docs-only PR exemption into only one of
 * the two gate.cjs files).
 *
 * Sync direction is decided by which source file is "ahead" of its installed
 * counterpart in `node_modules/moflo/`:
 *   - If only source `bin/gate.cjs` differs from installed bin → mirror bin → helper.
 *   - If only source `.claude/helpers/gate.cjs` differs from installed helper → mirror helper → bin.
 *   - If both are ahead with different content (genuine ambiguity) → bail
 *     and let the caller report failure; refuse to silently pick a side.
 *   - If `node_modules/moflo/` is missing entirely (consumer never installed,
 *     unusual layout) → bail.
 */
async function fixGateHealthHooks(): Promise<boolean> {
  const cwd = process.cwd();
  let driftFixed = true; // true means "no drift to fix or drift resolved"

  const binGate = join(cwd, 'bin', 'gate.cjs');
  const helperGate = join(cwd, '.claude', 'helpers', 'gate.cjs');
  const installedBin = join(cwd, 'node_modules', 'moflo', 'bin', 'gate.cjs');
  const installedHelper = join(cwd, 'node_modules', 'moflo', '.claude', 'helpers', 'gate.cjs');

  if (existsSync(binGate) && existsSync(helperGate)) {
    try {
      const binContent = readFileSync(binGate, 'utf8');
      const helperContent = readFileSync(helperGate, 'utf8');
      if (binContent !== helperContent) {
        const installedBinContent = existsSync(installedBin) ? readFileSync(installedBin, 'utf8') : null;
        const installedHelperContent = existsSync(installedHelper) ? readFileSync(installedHelper, 'utf8') : null;
        const binAhead = installedBinContent !== null && binContent !== installedBinContent;
        const helperAhead = installedHelperContent !== null && helperContent !== installedHelperContent;

        if (binAhead && !helperAhead) {
          writeFileSync(helperGate, binContent, 'utf-8');
        } else if (helperAhead && !binAhead) {
          writeFileSync(binGate, helperContent, 'utf-8');
        } else {
          // Both ahead with different content, OR neither ahead (no install
          // to anchor on). Refuse to pick a side — surface the failure.
          driftFixed = false;
        }
      }
    } catch {
      driftFixed = false;
    }
  }

  // Hook-wiring repair (separate failure mode that this fixer also owns).
  const settingsPath = join(cwd, '.claude', 'settings.json');
  let wiringFixed = true;
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const { repaired } = repairHookWiring(settings);
      if (repaired.length > 0) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    } catch {
      wiringFixed = false;
    }
  }

  return driftFixed && wiringFixed;
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
    // moflo.yaml auto-create. The session-start launcher already runs
    // `ensureMofloYamlExists` (see bin/session-start-launcher.mjs § 3d-yaml-create,
    // #895) but it can miss when the launcher itself was old at upgrade time —
    // user reported moflo.yaml absent after npm-installing past 4.9.2. Mirror
    // the same canonical create here so doctor --fix (and the /healer skill
    // wrapping it) self-heal on the spot instead of waiting for the next
    // SessionStart firing.
    'moflo.yaml': async () => {
      try {
        const { ensureMofloYamlExists } = await import('../init/moflo-yaml-template.js');
        const result = ensureMofloYamlExists(process.cwd());
        return result.created || existsSync(join(process.cwd(), 'moflo.yaml'));
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
    'Embedding hygiene': async () => {
      // The session-start launcher already runs the same migration BEFORE
      // daemon/MCP boot — that's where consumer autoheal happens. Running
      // it here mid-session is unsafe because any long-lived moflo writer
      // (daemon, MCP server) holds its own sql.js in-memory snapshot from
      // before we'd repair, and on its next flush dumps the stale buffer
      // back to disk, clobbering the repair. Pre-#1046 we shelled out to
      // `npx moflo embeddings init` here and falsely reported success
      // when the writeback clobber was about to undo it.
      // `getDaemonLockHolder` validates both PID liveness AND
      // that the process is actually a moflo daemon (Windows PID
      // recycling is real — see daemon-lock.ts:isDaemonProcess).
      if (getDaemonLockHolder(process.cwd()) !== null) {
        output.writeln(output.dim(
          '  Embedding hygiene is repaired automatically by the session-start launcher.',
        ));
        output.writeln(output.dim(
          '  Restart Claude Code (or run `flo daemon stop` first) to apply.',
        ));
        return false;
      }
      // No daemon — safe to run the migration in-process. In-process is
      // preferred over `runFixCommand` because the migration's TTY/stderr
      // progress UI is then visible to the user, and any thrown error
      // surfaces in the autoFixCheck try/catch instead of being swallowed
      // by a child-process exit code.
      try {
        const { runEmbeddingsMigrationIfNeeded } = await import('../services/embeddings-migration.js');
        return await runEmbeddingsMigrationIfNeeded();
      } catch (e) {
        output.writeln(output.warning(`  Embeddings migration failed: ${errorDetail(e)}`));
        return false;
      }
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
