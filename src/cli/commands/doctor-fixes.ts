/**
 * Auto-fix dispatch for `flo doctor --fix`.
 *
 * Maps each named HealthCheck to a programmatic fix function (preferred over
 * shell-out where possible). Falls back to running the check's `fix` string
 * if it looks like an `npx`/`npm`/`claude` command.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { output } from '../output.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { repairHookWiring } from '../services/hook-wiring.js';
import { getDaemonLockHolder } from '../services/daemon-lock.js';
import { findProjectRoot } from '../services/project-root.js';
import { legacyMemoryDbPath, legacyMemoryDbBakPath, memoryDbPath, mofloDir } from '../services/moflo-paths.js';
import { findZombieProcesses } from './doctor-zombies.js';
import { inspectMcpConfigs } from './doctor-checks-config.js';
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
 * Migrate `.swarm/` residue to its canonical home and remove the legacy directory.
 *
 * Three categories of artifact:
 *   1. `memory.db` (+ `.bak`)               — stale once `.moflo/moflo.db` exists; delete.
 *   2. `q-learning-model.json` / `model-router-state.json` — live RL state.
 *      Rename into `.moflo/movector/`. If the canonical target already exists
 *      (consumer ran moflo on the new defaults before the auto-fix), the
 *      canonical wins and the `.swarm/` copy is unlinked.
 *   3. `hooks.log` / `background.log`       — diagnostic logs. Relocate to
 *      `.moflo/logs/`; append into the canonical file if it already exists
 *      so we don't drop history. Best-effort — log loss is acceptable.
 *
 * Finally `rmdir .swarm/` if and only if it's empty. Anything we didn't
 * recognise is left in place rather than silently deleted.
 *
 * Cross-platform: uses `fs.rename`/`rmdir` (Node primitives), forward-slash-free
 * joins via `path.join`. Works on Windows + POSIX.
 *
 * Returns true if the directory was fully retired OR if there was nothing to
 * migrate; false if any relocation throws or `.swarm/` survives with unknown
 * contents.
 */
async function fixSwarmLegacyResidue(): Promise<boolean> {
  const root = findProjectRoot();
  const swarmDir = join(root, '.swarm');
  if (!existsSync(swarmDir)) return true;

  const canonicalDb = memoryDbPath(root);
  const moflo = mofloDir(root);
  const movectorDir = join(moflo, 'movector');
  const logsDir = join(moflo, 'logs');

  let allMigrated = true;

  // (1) memory.db + .bak — both are migration artifacts of the launcher's
  // copy-verify-rename step; if the canonical isn't yet in place neither
  // source is safe to delete. The launcher creates the `.bak` only AFTER
  // canonical exists, so this guard is conservative but correct.
  const legacyDbPaths: Array<[string, string]> = [
    ['memory.db', legacyMemoryDbPath(root)],
    ['memory.db.bak', legacyMemoryDbBakPath(root)],
  ];
  for (const [name, src] of legacyDbPaths) {
    if (!existsSync(src)) continue;
    if (!existsSync(canonicalDb)) {
      output.writeln(output.warning(
        `  Skipping ${name}: .moflo/moflo.db absent — run \`flo memory init\` first.`,
      ));
      allMigrated = false;
      continue;
    }
    try {
      unlinkSync(src);
    } catch (e) {
      output.writeln(output.warning(`  Failed to delete ${name}: ${errorDetail(e)}`));
      allMigrated = false;
    }
  }

  // (2) router state + neural state JSONs — rename into .moflo/{movector,neural,swarm,memory}/.
  //
  // q-learning-model.json + model-router-state.json: shipped at #727.
  // lora-weights.json + moe-weights.json: writer relocation in #1168
  //   (lora-adapter.ts, moe-router.ts).
  // ewc-fisher.json + sona-patterns.json: writer relocation in #1168
  //   (ewc-consolidation.ts, sona-optimizer.ts).
  // state.json + code-map-hash.txt: writer relocation in #1168
  //   (commands/swarm.ts, commands/memory.ts).
  const neuralDir = join(moflo, 'neural');
  const swarmStateDir = join(moflo, 'swarm');
  const memoryStateDir = join(moflo, 'memory');
  const stateFiles = [
    { name: 'q-learning-model.json', dest: movectorDir },
    { name: 'model-router-state.json', dest: movectorDir },
    { name: 'lora-weights.json', dest: movectorDir },
    { name: 'moe-weights.json', dest: movectorDir },
    { name: 'ewc-fisher.json', dest: neuralDir },
    { name: 'sona-patterns.json', dest: neuralDir },
    { name: 'state.json', dest: swarmStateDir },
    { name: 'code-map-hash.txt', dest: memoryStateDir },
  ];
  for (const { name, dest } of stateFiles) {
    const src = join(swarmDir, name);
    if (!existsSync(src)) continue;
    const target = join(dest, name);
    try {
      mkdirSync(dest, { recursive: true });
      if (existsSync(target)) {
        // Canonical already populated by a fresh save on the new defaults.
        // Keep the canonical, drop the legacy copy.
        unlinkSync(src);
      } else {
        renameSync(src, target);
      }
    } catch (e) {
      output.writeln(output.warning(`  Failed to relocate ${name}: ${errorDetail(e)}`));
      allMigrated = false;
    }
  }

  // (3) logs — best-effort move. Append into canonical if it already exists
  // (don't drop history). Hook + background logs are bounded to kilobytes in
  // practice so the read-into-memory cost is acceptable.
  const logFiles = ['hooks.log', 'background.log'];
  for (const name of logFiles) {
    const src = join(swarmDir, name);
    if (!existsSync(src)) continue;
    const target = join(logsDir, name);
    try {
      mkdirSync(logsDir, { recursive: true });
      if (existsSync(target)) {
        appendFileSync(target, readFileSync(src));
        unlinkSync(src);
      } else {
        renameSync(src, target);
      }
    } catch (e) {
      output.writeln(output.warning(`  Failed to relocate ${name}: ${errorDetail(e)}`));
      allMigrated = false;
    }
  }

  // (4) rmdir .swarm/ if it's empty. Anything left is unrecognised — leave it
  // for the user to inspect rather than silently delete.
  try {
    const remaining = readdirSync(swarmDir);
    if (remaining.length === 0) {
      rmdirSync(swarmDir);
    } else {
      output.writeln(output.dim(
        `  .swarm/ kept (${remaining.length} unrecognised entr${remaining.length === 1 ? 'y' : 'ies'}): ${remaining.join(', ')}`,
      ));
      allMigrated = false;
    }
  } catch (e) {
    output.writeln(output.warning(`  Failed to remove .swarm/: ${errorDetail(e)}`));
    allMigrated = false;
  }

  return allMigrated;
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
      // Canonical DB lives at `.moflo/moflo.db`; `initializeMemoryDatabase`
      // creates the parent dir itself. The pre-#1168 fix also `mkdirSync`'d
      // `.swarm/` — vestigial residue that fought the 'Swarm Residue' fix in
      // the same healer pass. Removed.
      try {
        const { initializeMemoryDatabase } = await import('../memory/memory-initializer.js');
        const result = await initializeMemoryDatabase({ force: true, verbose: false });
        return result.success;
      } catch {
        return runFixCommand('npx moflo memory init --force');
      }
    },
    'Embeddings': async () => {
      // Same fix as Memory Database — ensure the canonical DB exists, then
      // populate embeddings. Pre-#1168 wrote to `.swarm/memory.db` directly,
      // contradicting the post-#727 layout; that branch is removed.
      try {
        if (!existsSync(memoryDbPath(findProjectRoot()))) {
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
    // #1150 — SIGTERM the lock-holder BEFORE unlinking the lock. The old
    // shape (`unlink lock; daemon start`) is the bug that produced orphan
    // daemon accumulation: if the lock-holder PID was still alive, the
    // unlink left it running and the respawn produced a second same-project
    // daemon. Mirrors the 'Daemon Version Skew' / 'Daemon Identity Match'
    // shape which got this right.
    //
    // Also reaps any same-project orphans whose PIDs aren't recorded in the
    // lock — those are the daemons that survived prior buggy fixes.
    'Daemon Status': async () => {
      const cwd = process.cwd();
      const { getDaemonLockPayload, reapSameProjectOrphans } = await import('../services/daemon-lock.js');
      const payload = getDaemonLockPayload(cwd);
      if (payload?.pid && payload.pid > 0) {
        try { process.kill(payload.pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      // Wipe other same-project daemons that the lock doesn't account for.
      reapSameProjectOrphans(cwd);
      const lockFile = join(cwd, '.moflo', 'daemon.lock');
      const pidFile = join(cwd, '.moflo', 'daemon.pid');
      try {
        if (existsSync(lockFile)) unlinkSync(lockFile);
        if (existsSync(pidFile)) unlinkSync(pidFile);
      } catch { /* best effort */ }
      return runFixCommand('npx moflo daemon start');
    },
    // Epic #1054.S5 / #1059 — SIGTERM the stale daemon and let the launcher's
    // existing respawn path (mirrored as `npx moflo daemon start`) pick up the
    // installed-version code. Mirrors `recycleDaemon` in
    // bin/session-start-launcher.mjs so the auto-fix matches the launcher's
    // behavior exactly.
    'Daemon Version Skew': async () => {
      const cwd = process.cwd();
      const { getDaemonLockPayload } = await import('../services/daemon-lock.js');
      const payload = getDaemonLockPayload(cwd);
      if (payload?.pid && payload.pid > 0) {
        try { process.kill(payload.pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      const lockFile = join(cwd, '.moflo', 'daemon.lock');
      try { if (existsSync(lockFile)) unlinkSync(lockFile); } catch { /* ok */ }
      return runFixCommand('npx moflo daemon start');
    },
    // #1150 — terminate same-project orphan daemons. Keep the lock-holder
    // alive if it shows up in the scan (it's the canonical daemon). If the
    // lock-holder is missing/stale, kill all candidates and let the next
    // session-start respawn a clean one. The pre-computed `pids` list is
    // threaded into `reapSameProjectOrphans` so we don't re-run the
    // OS process scan inside it.
    'Daemon Orphan': async () => {
      const cwd = process.cwd();
      const { findProjectDaemonPids, getDaemonLockHolder, reapSameProjectOrphans } =
        await import('../services/daemon-lock.js');
      const pids = findProjectDaemonPids(cwd);
      if (pids.length <= 1) return true; // already healthy

      const lockHolder = getDaemonLockHolder(cwd);
      if (lockHolder != null && pids.includes(lockHolder)) {
        const { survived } = reapSameProjectOrphans(cwd, process.pid, lockHolder, pids);
        return survived.length === 0;
      }

      // No identifiable canonical daemon — kill them all, clear the lock,
      // respawn fresh.
      const { survived } = reapSameProjectOrphans(cwd, process.pid, undefined, pids);
      const lockFile = join(cwd, '.moflo', 'daemon.lock');
      try { if (existsSync(lockFile)) unlinkSync(lockFile); } catch { /* ok */ }
      if (survived.length > 0) return false;
      return runFixCommand('npx moflo daemon start');
    },
    // #1145 — daemon claims a different projectRoot than ours (or has no
    // port in its lock so we can't verify). Same recycle pattern as version
    // skew: SIGTERM the local daemon, clear the lock, respawn. Then the new
    // daemon binds the per-project deterministic port and stamps it into
    // the lock — clients can discover it without guessing.
    'Daemon Identity Match': async () => {
      const cwd = process.cwd();
      const { getDaemonLockPayload } = await import('../services/daemon-lock.js');
      const payload = getDaemonLockPayload(cwd);
      if (payload?.pid && payload.pid > 0) {
        try { process.kill(payload.pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      const lockFile = join(cwd, '.moflo', 'daemon.lock');
      try { if (existsSync(lockFile)) unlinkSync(lockFile); } catch { /* ok */ }
      return runFixCommand('npx moflo daemon start');
    },
    'Embedding Coverage Truth': async () => {
      // Same as the existing Embeddings fix — rebuild the cache by re-running
      // the embeddings pipeline. Routes through `npx moflo` so the consumer
      // CLI resolution stays consistent across platforms (see
      // feedback_cross_platform_mandatory).
      return runFixCommand('npx moflo embeddings init --force');
    },
    'MCP Servers': async () => {
      // #1126: distinguish "malformed JSON" from "moflo missing from valid
      // config". The previous fix always ran `claude mcp add` — a no-op when
      // the project-local `.mcp.json` was unparseable, because the command
      // doesn't touch malformed project files.
      const projectRoot = findProjectRoot();
      const inspection = inspectMcpConfigs(projectRoot);

      if (inspection.status === 'malformed' && inspection.path) {
        try {
          // Filesystem-safe timestamp: Date.now() is a digit-only integer so
          // no `:` escape needed (per dogfooding.md § 6 cross-platform primitives).
          const backupPath = `${inspection.path}.malformed-${Date.now()}`;
          // The backup is a brand-new file at a unique timestamped path with
          // no concurrent readers — a plain writeFileSync is enough; the
          // atomic ceremony is only worth its cost when replacing a file a
          // running process might re-open mid-write.
          writeFileSync(backupPath, readFileSync(inspection.path, 'utf8'), 'utf-8');

          const { generateMCPJson } = await import('../init/mcp-generator.js');
          const { DEFAULT_INIT_OPTIONS } = await import('../init/types.js');
          const regenerated = generateMCPJson({ ...DEFAULT_INIT_OPTIONS, targetDir: projectRoot });

          // Confirm the regenerated content parses before clobbering the
          // (broken) original — refuse to repair if our own generator emits
          // unparseable JSON for any reason (defense in depth against a future
          // generator regression silently emitting bad escapes again).
          JSON.parse(regenerated);
          // Atomic swap so a concurrent reader (e.g. Claude Code re-scanning
          // .mcp.json during the fix) never sees a truncated file. The
          // Windows-AV-lock verify window inside atomicWriteFileSync (#1015)
          // gates the rename until the new bytes are readable.
          atomicWriteFileSync(inspection.path, regenerated);

          output.writeln(output.dim(`  Regenerated ${inspection.path}; backup at ${backupPath}.`));
          return true;
        } catch (e) {
          output.writeln(output.warning(`  Regeneration failed: ${errorDetail(e)}`));
          return false;
        }
      }

      // Valid config exists but moflo isn't registered — fall back to the
      // claude-cli flow. This is the original behavior for the
      // valid_no_moflo / not_found states.
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
    // Refresh the consumer's CLAUDE.md MoFlo block in place using the
    // shared `applyInjectionReplacement` service. Idempotent: a re-run sees
    // `state === 'in-sync'` and the autoFix dispatcher skips this entry.
    'CLAUDE.md Injection Drift': async () => {
      const projectRoot = findProjectRoot();
      const claudeMdPath = join(projectRoot, 'CLAUDE.md');
      try {
        const { generateClaudeMd } = await import('../init/claudemd-generator.js');
        const { applyInjectionReplacement } = await import('../services/claudemd-injection.js');
        const canonical = generateClaudeMd({});
        const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : null;
        const result = applyInjectionReplacement(existing, canonical);
        if (!result.changed || !result.contents) return false;
        // atomicWriteFileSync guards against a concurrent reader (Claude Code
        // re-scanning CLAUDE.md mid-fix) seeing a truncated file.
        atomicWriteFileSync(claudeMdPath, result.contents);
        return true;
      } catch (e) {
        output.writeln(output.warning(`  CLAUDE.md repair failed: ${errorDetail(e)}`));
        return false;
      }
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
    // Tiered recovery for `.moflo/moflo.db` corruption (REINDEX → VACUUM
    // INTO → row-level salvage). The TS service stops the daemon
    // automatically (cross-platform via `process.kill('SIGTERM')`) so the
    // atomic swap doesn't race a live writer; we restart it via the
    // existing `npx moflo daemon start` shorthand after. The MCP server,
    // started by Claude Code outside our process tree, isn't stopped here —
    // explicit user guidance covers that case at the end.
    'Memory DB Integrity': async () => {
      try {
        const { repairMemoryDbIntegrity } = await import('../services/memory-db-integrity-repair.js');
        const result = await repairMemoryDbIntegrity(process.cwd());
        if (result.repaired) {
          const tierLabel =
            result.tier === 'reindex' ? 'REINDEX (index rebuild)'
            : result.tier === 'vacuum' ? 'VACUUM INTO (fresh-file rebuild)'
            : result.tier === 'salvage' ? 'row-level salvage'
            : 'repaired';
          output.writeln(output.dim(`  Recovered via ${tierLabel}.`));
          if (result.corruptBackup) {
            output.writeln(output.dim(`  Pre-repair backup retained: ${result.corruptBackup}`));
          }
          if (result.lossStats) {
            for (const [tbl, s] of Object.entries(result.lossStats)) {
              if (s.read > 0) {
                const lost = Math.max(0, s.read - s.written);
                if (lost > 0) {
                  output.writeln(output.warning(
                    `  ${tbl}: ${s.written}/${s.read} rows preserved (lost ${lost} across ${s.errors} unreadable chunk(s))`,
                  ));
                }
              }
            }
            output.writeln(output.dim(
              '  Embeddings for lost rows will be regenerated on next index pass — run `npx moflo embeddings init` to force.',
            ));
          }
          // Restart the daemon if we stopped it. The launcher's own
          // section-4 spawn handles this on next session-start, but a
          // mid-session healer call shouldn't leave the daemon down.
          if (result.daemonStopped) {
            output.writeln(output.dim('  Restarting daemon...'));
            await runFixCommand('npx moflo daemon start');
          }
          // Cross-platform note for the MCP server (out-of-tree, can't
          // SIGTERM). On Windows the swap would have failed if MCP was
          // holding the file; on POSIX the swap succeeds but MCP keeps
          // reading the stale inode until restart. Either way: restart
          // Claude Code to fully apply.
          output.writeln(output.dim(
            '  Restart Claude Code so the MCP server re-opens the recovered DB.',
          ));
          return true;
        }
        if (result.persistent) {
          output.writeln(output.warning(
            '  Corruption survived every recovery tier. Manual options: ' +
            '`npx moflo memory rebuild-index` (destructive) or restore from a known-good backup.',
          ));
        }
        return false;
      } catch (e) {
        output.writeln(output.warning(`  Repair failed: ${errorDetail(e)}`));
        return false;
      }
    },
    // Migrate `.swarm/` residue (legacy memory.db, RL state JSONs, hook/bg logs)
    // into their canonical `.moflo/` homes and rmdir the directory once empty.
    // See `fixSwarmLegacyResidue` for the per-artifact policy.
    'Swarm Residue': async () => {
      return fixSwarmLegacyResidue();
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
