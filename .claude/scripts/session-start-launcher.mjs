#!/usr/bin/env node
/**
 * Fast session-start launcher — single hook that replaces all SessionStart entries.
 *
 * Spawns background tasks via spawn(detached + unref) and exits immediately.
 *
 * Invoked by: node .claude/scripts/session-start-launcher.mjs
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, mkdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { migrateClaudeFlowToMoflo, migrateMemoryDbToMoflo } from './lib/moflo-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect project root by walking up from cwd to find package.json.
// IMPORTANT: Do NOT use resolve(__dirname, '..') or '../..' — this script lives
// in bin/ during development but gets synced to .claude/scripts/ in consumer
// projects, so __dirname-relative paths break. findProjectRoot() works everywhere.
function findProjectRoot() {
  let dir = process.cwd();
  const root = resolve(dir, '/');
  while (dir !== root) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();

// Visible mutation reporter (#716). Claude Code's SessionStart hook captures
// stdout as `additionalContext`, so each line here surfaces to Claude — and
// through it to the user — explaining what the launcher just changed. Keep
// silent fast-path: only call this when something actually mutated.
//
// `mutationCount` is read by the post-spawn notice writer (#636) so the
// statusline notice + the closing "starting background tasks" line both
// know whether anything actually fired this session.
let mutationCount = 0;
function emitMutation(action, details) {
  mutationCount++;
  try {
    const tail = details ? ` (${details})` : '';
    process.stdout.write(`moflo: ${action}${tail}\n`);
  } catch {
    // Writing must never throw — a broken stdout would block session start.
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Captured inside the upgrade/drift branch so the post-spawn notice writer
// can persist `.moflo/upgrade-notice.json` for the statusline (#636).
let upgradeNoticeContext = null;

// ── 0. LEGACY state migration (#699) ─────────────────────────────────────────
// Consumers upgrading from older moflo builds (inherited from upstream Ruflo)
// get a one-time auto-migration of LEGACY `.claude-flow/` → `.moflo/` so claim
// files, daemon state, metrics, and the version stamp survive the rename.
// The migration helper is idempotent — see bin/lib/moflo-paths.mjs for the
// algorithm. LEGACY: no-ops once `.claude-flow/` is gone.
try {
  const cfMigration = migrateClaudeFlowToMoflo(projectRoot);
  if (cfMigration?.migrated) {
    emitMutation('migrated runtime state to .moflo/', 'from legacy .claude-flow/'); // LEGACY
  }
} catch {
  // Non-fatal — anything left behind by the migration just means it runs
  // again next session. Better to keep launching than to block on it.
}

// ── 0b. LEGACY memory DB relocation (#727) ──────────────────────────────────
// Run BEFORE long-lived sql.js consumers (MCP server, daemon) — see the
// `migrateMemoryDbToMoflo` JSDoc for the copy-verify-delete contract and
// the sql.js write-back hazard.
try {
  const dbMigration = migrateMemoryDbToMoflo(projectRoot);
  if (dbMigration?.migrated) {
    const detail = dbMigration.hnswMoved
      ? '.swarm/memory.db → .moflo/moflo.db (with hnsw.index)'
      : '.swarm/memory.db → .moflo/moflo.db';
    emitMutation('relocated memory db', detail);
    if (dbMigration.reason === 'rename-failed') {
      emitMutation('legacy .swarm/memory.db remains', 'rename to .bak failed — flo doctor will warn');
    }
  }
} catch {
  // Non-fatal — failed migration leaves both DBs in place; next session retries.
}

// ── 1. Helper: fire-and-forget a background process ─────────────────────────
function fireAndForget(cmd, args, label) {
  try {
    const proc = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'ignore',     // Don't hold stdio pipes open
      detached: true,       // New process group
      shell: false,
      windowsHide: true     // No console popup on Windows
    });
    proc.unref();           // Let this process exit without waiting
  } catch {
    // If spawn fails (e.g. node not found), don't block startup
  }
}

// Stop the daemon recorded in `lockFile` (if any) and start a fresh one. Used
// from two recycle paths in this launcher: (a) the version-bump branch when
// installed moflo just changed, and (b) the stale-daemon branch when the
// running daemon predates the current install by a meaningful margin.
//
// Reads the lock, SIGTERMs the recorded PID, removes the lock, and fires a
// `daemon start --quiet` against `node_modules/moflo/bin/cli.js`. Every
// failure mode (no lock, dead PID, missing CLI) is silently absorbed — the
// recycle is best-effort and must never block session start.
function recycleDaemon(lockFile, label) {
  if (!existsSync(lockFile)) return false;
  let stalePid = null;
  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
    if (typeof lock?.pid === 'number' && lock.pid > 0) stalePid = lock.pid;
  } catch { /* malformed lock — fall through to unlink */ }
  if (stalePid !== null) {
    try { process.kill(stalePid, 'SIGTERM'); } catch { /* already dead */ }
  }
  try { unlinkSync(lockFile); } catch { /* non-fatal */ }
  // Respawn only if a live daemon was actually recorded — no point starting
  // one when there wasn't one before.
  if (stalePid !== null) {
    const localCliPath = resolve(projectRoot, 'node_modules/moflo/bin/cli.js');
    if (existsSync(localCliPath)) {
      fireAndForget('node', [localCliPath, 'daemon', 'start', '--quiet'], label);
    }
    return true;
  }
  return false;
}

// ── 2. Reset workflow state for new session ──────────────────────────────────
const stateDir = resolve(projectRoot, '.claude');
const stateFile = resolve(stateDir, 'workflow-state.json');
try {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({
    tasksCreated: false,
    taskCount: 0,
    memorySearched: false,
    sessionStart: new Date().toISOString()
  }, null, 2));
} catch {
  // Non-fatal - workflow gate will use defaults
}

// ── 3. Auto-sync scripts and helpers on version change ───────────────────────
// Controlled by `auto_update.enabled` in moflo.yaml (default: true).
// When moflo is upgraded (npm install), scripts and helpers may be stale.
// Detect version change and sync from source before running hooks.
let autoUpdateConfig = { enabled: true, scripts: true, helpers: true };
try {
  const mofloYaml = resolve(projectRoot, 'moflo.yaml');
  if (existsSync(mofloYaml)) {
    const yamlContent = readFileSync(mofloYaml, 'utf-8');
    // Simple YAML parsing for auto_update block (avoids js-yaml dependency)
    const enabledMatch = yamlContent.match(/auto_update:\s*\n\s+enabled:\s*(true|false)/);
    const scriptsMatch = yamlContent.match(/auto_update:\s*\n(?:\s+\w+:.*\n)*?\s+scripts:\s*(true|false)/);
    const helpersMatch = yamlContent.match(/auto_update:\s*\n(?:\s+\w+:.*\n)*?\s+helpers:\s*(true|false)/);
    if (enabledMatch) autoUpdateConfig.enabled = enabledMatch[1] === 'true';
    if (scriptsMatch) autoUpdateConfig.scripts = scriptsMatch[1] === 'true';
    if (helpersMatch) autoUpdateConfig.helpers = helpersMatch[1] === 'true';
  }
} catch { /* non-fatal — use defaults (all true) */ }

try {
  const mofloPkgPath = resolve(projectRoot, 'node_modules/moflo/package.json');
  const versionStampPath = resolve(projectRoot, '.moflo', 'moflo-version');
  if (autoUpdateConfig.enabled && existsSync(mofloPkgPath)) {
    const installedVersion = JSON.parse(readFileSync(mofloPkgPath, 'utf-8')).version;
    let cachedVersion = '';
    try { cachedVersion = readFileSync(versionStampPath, 'utf-8').trim(); } catch {}

    // Drift healing: re-sync if any previously-installed file is missing, even
    // when version stamp matches. Guards against out-of-band deletions (manual
    // rm, botched merges, dedup commits, etc.) that would otherwise silently
    // leave .claude/scripts/ incomplete until the next moflo upgrade.
    const manifestPath = resolve(projectRoot, '.moflo', 'installed-files.json');
    let manifestDrifted = false;
    try {
      const prev = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (Array.isArray(prev)) {
        manifestDrifted = prev.some(f => !existsSync(resolve(projectRoot, f)));
      }
    } catch { /* no manifest yet — version check handles first install */ }

    if (installedVersion !== cachedVersion || manifestDrifted) {
      if (installedVersion !== cachedVersion) {
        upgradeNoticeContext = {
          kind: 'upgrade',
          from: cachedVersion || null,
          to: installedVersion,
        };
        emitMutation(
          'upgraded',
          cachedVersion ? `${cachedVersion} → ${installedVersion}` : `installed ${installedVersion}`,
        );
      } else {
        upgradeNoticeContext = {
          kind: 'repair',
          from: installedVersion,
          to: installedVersion,
        };
        emitMutation('repaired stale install', 'manifest drift detected');
      }
      const binDir = resolve(projectRoot, 'node_modules/moflo/bin');

      // ── Manifest-based auto-update ──────────────────────────────────────
      //
      // IMPORTANT: Every file moflo installs into the destination project
      // MUST be recorded in `currentManifest` via syncFile() or a manual
      // push. On upgrade, files in the OLD manifest but NOT in the new one
      // are deleted — this is how we clean up files from prior versions
      // without accidentally deleting user-created or runtime files.
      //
      // When adding/removing files from the sync lists below:
      //  1. Use syncFile() for copied files (it records automatically)
      //  2. Push to currentManifest manually for generated files
      //  3. That's it — cleanup is automatic on the next upgrade
      // ────────────────────────────────────────────────────────────────────

      // Load the previous manifest so we can diff after syncing
      let previousManifest = [];
      try { previousManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { /* ok */ }

      // Track every file we install this round
      const currentManifest = [];

      /** Copy src → dest if src exists, record in manifest. */
      function syncFile(src, dest, manifestKey) {
        if (existsSync(src)) {
          try { copyFileSync(src, dest); currentManifest.push(manifestKey); } catch { /* non-fatal */ }
        }
      }

      // Version changed — sync scripts from bin/
      if (autoUpdateConfig.scripts) {
        const scriptsDir = resolve(projectRoot, '.claude/scripts');
        const scriptFiles = [
          'hooks.mjs', 'session-start-launcher.mjs', 'index-guidance.mjs',
          'build-embeddings.mjs', 'generate-code-map.mjs', 'semantic-search.mjs',
          'index-tests.mjs', 'index-patterns.mjs', 'index-all.mjs',
          'setup-project.mjs',
        ];
        for (const file of scriptFiles) {
          syncFile(resolve(binDir, file), resolve(scriptsDir, file), `.claude/scripts/${file}`);
        }

        // Sync lib/ subdirectory (process-manager.mjs, registry-cleanup.cjs, etc.)
        // hooks.mjs imports ./lib/process-manager.mjs — without this, session-start
        // silently fails and the daemon, indexer, and pretrain never run.
        const libSrcDir = resolve(binDir, 'lib');
        const libDestDir = resolve(scriptsDir, 'lib');
        if (existsSync(libSrcDir)) {
          if (!existsSync(libDestDir)) mkdirSync(libDestDir, { recursive: true });
          for (const file of readdirSync(libSrcDir)) {
            syncFile(resolve(libSrcDir, file), resolve(libDestDir, file), `.claude/scripts/lib/${file}`);
          }
        }
      }

      // Sync helpers from bin/ and source .claude/helpers/
      if (autoUpdateConfig.helpers) {
        const helpersDir = resolve(projectRoot, '.claude/helpers');
        if (!existsSync(helpersDir)) mkdirSync(helpersDir, { recursive: true });

        // Gate and hook helpers — shipped as static files in bin/
        const binHelperFiles = [
          'gate.cjs', 'gate-hook.mjs', 'prompt-hook.mjs', 'hook-handler.cjs',
        ];
        for (const file of binHelperFiles) {
          syncFile(resolve(binDir, file), resolve(helpersDir, file), `.claude/helpers/${file}`);
        }

        // Other helpers from .claude/helpers/ and CLI .claude/helpers/
        const helperSources = [
          resolve(projectRoot, 'node_modules/moflo/.claude/helpers'),
          resolve(projectRoot, 'node_modules/moflo/src/cli/.claude/helpers'),
        ];
        const sourceHelperFiles = [
          'auto-memory-hook.mjs', 'statusline.cjs', 'intelligence.cjs', 'subagent-start.cjs', 'pre-commit', 'post-commit',
        ];
        for (const file of sourceHelperFiles) {
          const dest = resolve(helpersDir, file);
          for (const srcDir of helperSources) {
            const src = resolve(srcDir, file);
            if (existsSync(src)) {
              try { copyFileSync(src, dest); currentManifest.push(`.claude/helpers/${file}`); } catch { /* non-fatal */ }
              break; // first source wins
            }
          }
        }
      }

      // Sync all shipped guidance files from node_modules/moflo/.claude/guidance/shipped/
      const guidanceDir = resolve(projectRoot, '.claude/guidance');
      const shippedDir = resolve(projectRoot, 'node_modules/moflo/.claude/guidance/shipped');
      if (existsSync(shippedDir)) {
        try {
          if (!existsSync(guidanceDir)) mkdirSync(guidanceDir, { recursive: true });
          const shippedFiles = readdirSync(shippedDir).filter(f => f.endsWith('.md'));
          for (const file of shippedFiles) {
            const src = resolve(shippedDir, file);
            const dest = resolve(guidanceDir, file);
            const header = `<!-- AUTO-GENERATED by moflo session-start. Do not edit — changes will be overwritten. -->\n<!-- Source: node_modules/moflo/.claude/guidance/shipped/${file} -->\n\n`;
            const content = readFileSync(src, 'utf-8');
            writeFileSync(dest, header + content);
            currentManifest.push(`.claude/guidance/${file}`);
          }
        } catch { /* non-fatal */ }
      }

      // ── Clean up files we installed previously but no longer ship ──
      // Only remove files that are in the OLD manifest but NOT in the new one.
      // This ensures we never delete user-created or runtime-generated files.
      let removedFiles = 0;
      if (previousManifest.length > 0) {
        const currentSet = new Set(currentManifest);
        for (const rel of previousManifest) {
          if (!currentSet.has(rel)) {
            const abs = resolve(projectRoot, rel);
            try {
              if (existsSync(abs)) {
                unlinkSync(abs);
                removedFiles++;
              }
            } catch { /* non-fatal */ }
          }
        }
      }
      if (removedFiles > 0) {
        emitMutation('cleaned up retired files', `${removedFiles} removed`);
      }

      // Recycle the running daemon — its in-process module cache holds the
      // previous moflo image. After an upgrade that cache is stale, which
      // shows up as warnings from removed code paths (e.g. the
      // `[neural-tools] @moflo/embeddings not resolvable` spam from #639,
      // emitted by pre-#592 collapse code that no longer exists in source)
      // and means freshly-disabled workers keep running.
      //
      // `daemon.autoStart` only governs the cold-start case (no daemon
      // existed); here a daemon was actually running, so replacing it with a
      // current-code copy is the desired behaviour regardless of that flag.
      try {
        if (recycleDaemon(resolve(projectRoot, '.moflo', 'daemon.lock'), 'daemon-recycle')) {
          emitMutation('recycled daemon', 'load fresh moflo code');
        }
      } catch { /* non-fatal — daemon recycle is best-effort */ }

      // Write updated manifest + version stamp
      try {
        const cfDir = resolve(projectRoot, '.moflo');
        if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(currentManifest, null, 2));
        writeFileSync(versionStampPath, installedVersion);
      } catch {}
    }
  }
} catch {
  // Non-fatal — scripts will still work, just may be stale
}

// ── 3a-pre. Recycle daemons started before the current moflo install ────────
// The version-bump block above only fires when `installedVersion !== cachedVersion`.
// That misses the common case where a user upgraded moflo, ran ONE session
// (which bumped the stamp + recycled the daemon), then on a subsequent session
// the version stamp matches but the daemon they started long-ago is still
// holding stale module cache from a pre-collapse moflo image. The
// `[neural-tools] @moflo/embeddings not resolvable` spam (#639) is the
// observable symptom of exactly this: a daemon running pre-#592 code that no
// longer exists in source, calling a require helper that prints the warning
// every time `neural_predict` / `neural_patterns` fires.
//
// Fix: compare the daemon-lock's `startedAt` against `node_modules/moflo/`'s
// install mtime. If the daemon predates the current install, recycle it. The
// install mtime is a stable proxy because npm rewrites the package.json on
// every `npm install`, even when the resolved version is unchanged.
//
// Margin absorbs clock skew between npm's mtime write and the daemon-lock
// `startedAt` clock — within this window the daemon is likely the post-install
// daemon, not a stale predecessor.
const STALE_DAEMON_MTIME_SKEW_MS = 5_000;
try {
  const mofloPkgPathForRecycle = resolve(projectRoot, 'node_modules/moflo/package.json');
  const lockFile = resolve(projectRoot, '.moflo', 'daemon.lock');
  // Cheap stat first — if the daemon-lock or package.json is gone we're done.
  // statSync throws ENOENT on a missing file; the outer catch absorbs it.
  const installedAt = statSync(mofloPkgPathForRecycle).mtimeMs;
  const lockMtime = statSync(lockFile).mtimeMs;
  // Quick reject: if the lock file itself is younger than the install, the
  // daemon was started after install — no read of lock contents needed.
  if (installedAt - lockMtime > STALE_DAEMON_MTIME_SKEW_MS) {
    let daemonStartedAt = 0;
    try {
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      if (typeof lock?.startedAt === 'number') daemonStartedAt = lock.startedAt;
    } catch { /* corrupt lock — fall through, recycleDaemon will unlink it */ }
    if (daemonStartedAt > 0 && (installedAt - daemonStartedAt) > STALE_DAEMON_MTIME_SKEW_MS) {
      if (recycleDaemon(lockFile, 'daemon-stale-recycle')) {
        emitMutation('recycled stale daemon', 'predates current install');
      }
    }
  }
} catch { /* non-fatal — best-effort stale-daemon detection */ }

// ── 3a. Auto-migrate settings.json (npx flo → node helpers, PATH setup) ────
// Existing users may have stale settings.json with `npx flo` hooks that break
// when npx isn't on PATH. Migrate them to direct `node .claude/helpers/...`
// invocations on every session start so users never get stuck.
try {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    let dirty = false;
    const settingsChanges = [];
    const settings = JSON.parse(raw);

    // 3a-i. Remove stale PATH override (${PATH} isn't expanded by Claude Code,
    // which replaces the inherited PATH and breaks node resolution)
    if (!settings.env) settings.env = {};
    if (settings.env.PATH) {
      delete settings.env.PATH;
      dirty = true;
      settingsChanges.push('removed stale PATH override');
    }

    // 3a-ii. Replace npx flo hook commands with direct node helper invocations
    const hookMigrations = [
      // PreToolUse
      { from: 'npx flo hooks pre-edit',             to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs" post-edit' },
      { from: 'npx flo gate check-before-scan',     to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-scan' },
      { from: 'npx flo gate check-before-read',     to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-read' },
      { from: 'npx flo gate check-dangerous-command', to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-dangerous-command' },
      { from: 'npx flo gate check-before-pr',       to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-before-pr' },
      // PostToolUse
      { from: 'npx flo hooks post-edit',            to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs" post-edit' },
      { from: 'npx flo hooks post-task',            to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs" post-task' },
      { from: 'npx flo gate record-task-created',   to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-task-created' },
      { from: 'npx flo gate check-bash-memory',     to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" check-bash-memory' },
      { from: 'npx flo gate record-memory-searched', to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-memory-searched' },
      { from: 'npx flo gate check-task-transition', to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" check-task-transition' },
      { from: 'npx flo gate record-learnings-stored', to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" record-learnings-stored' },
      // UserPromptSubmit
      { from: 'npx flo gate prompt-reminder',       to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/prompt-hook.mjs"' },
      { from: 'npx flo hooks route',                to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/prompt-hook.mjs"' },
      // Stop
      { from: 'npx flo hooks session-end',          to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs" session-end' },
      // PreCompact
      { from: 'npx flo gate compact-guidance',      to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" compact-guidance' },
      // Notification
      { from: 'npx flo hooks notification',         to: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs" notification' },
    ];

    const migrationMap = new Map(hookMigrations.map(m => [m.from, m.to]));

    let migratedHookCount = 0;
    function migrateHooks(hookGroups) {
      if (!Array.isArray(hookGroups)) return;
      for (const group of hookGroups) {
        if (!Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) {
          if (hook.command && migrationMap.has(hook.command)) {
            hook.command = migrationMap.get(hook.command);
            dirty = true;
            migratedHookCount++;
          }
        }
      }
    }

    if (settings.hooks) {
      for (const eventName of Object.keys(settings.hooks)) {
        migrateHooks(settings.hooks[eventName]);
      }
    }
    if (migratedHookCount > 0) {
      settingsChanges.push(`rewrote ${plural(migratedHookCount, 'npx hook command')}`);
    }

    // 3a-iii. Ensure statusLine is wired (statusline.cjs is synced by step 3
    // but settings.json may lack the config block, so the status line never appears)
    if (!settings.statusLine) {
      settings.statusLine = {
        type: 'command',
        command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs" --compact',
      };
      dirty = true;
      settingsChanges.push('added statusLine');
    }

    // 3a-iv. Repair missing required hook wirings (same logic as doctor --fix
    // and moflo upgrade — shared via hook-wiring.js to stay DRY)
    try {
      const hwPaths = [
        resolve(projectRoot, 'node_modules/moflo/dist/src/cli/services/hook-wiring.js'),
        resolve(projectRoot, 'dist/src/cli/services/hook-wiring.js'),
      ];
      const hwPath = hwPaths.find(p => existsSync(p));
      if (hwPath) {
        const { repairHookWiring } = await import(`file://${hwPath.replace(/\\/g, '/')}`);
        const { repaired } = repairHookWiring(settings);
        if (repaired.length > 0) {
          dirty = true;
          settingsChanges.push(`repaired ${plural(repaired.length, 'hook wiring')}`);
        }
      }
    } catch { /* non-fatal — doctor can still fix later */ }

    if (dirty) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      emitMutation('updated .claude/settings.json', settingsChanges.join(', '));
    }
  }
} catch { /* non-fatal — stale hooks won't block session, just emit warnings */ }

// ── 3b. Ensure shipped guidance files exist (even without version change) ──
// Subagents need these files on disk for direct reads without memory search.
try {
  const guidanceDir = resolve(projectRoot, '.claude/guidance');
  const shippedDir = resolve(projectRoot, 'node_modules/moflo/.claude/guidance/shipped');
  if (existsSync(shippedDir)) {
    let restoredGuidance = 0;
    const shippedFiles = readdirSync(shippedDir).filter(f => f.endsWith('.md'));
    for (const file of shippedFiles) {
      const dest = resolve(guidanceDir, file);
      if (!existsSync(dest)) {
        if (!existsSync(guidanceDir)) mkdirSync(guidanceDir, { recursive: true });
        const header = `<!-- AUTO-GENERATED by moflo session-start. Do not edit — changes will be overwritten. -->\n<!-- Source: node_modules/moflo/.claude/guidance/shipped/${file} -->\n\n`;
        const content = readFileSync(resolve(shippedDir, file), 'utf-8');
        writeFileSync(dest, header + content);
        restoredGuidance++;
      }
    }
    if (restoredGuidance > 0) {
      emitMutation('restored missing guidance files', `${restoredGuidance} restored`);
    }
  }
} catch { /* non-fatal */ }

// ── 3b-714. Retire legacy `.swarm/vector-stats.json` parallel write (#714) ─
// `.moflo/vector-stats.json` is canonical post-#699; pre-#714 builds also
// wrote a copy under `.swarm/` for a "legacy compatibility" reader that no
// longer exists. The leftover file can only ever be stale, so delete it on
// session start. Unconditional unlinkSync — ENOENT (the hot path) lands in
// catch and stays silent, while a successful unlink reaches the emit on the
// rare cleanup path (#716). Avoids an extra existsSync stat per session.
try {
  unlinkSync(resolve(projectRoot, '.swarm', 'vector-stats.json'));
  emitMutation('removed legacy .swarm/vector-stats.json');
} catch { /* non-fatal — ENOENT once removed, EACCES on Windows AV holds */ }

// ── 3c. Clean up double-prefixed guidance files from pre-4.8.45 upgrade ─────
// Before 4.8.45, session-start dynamically prepended "moflo-" to shipped filenames.
// When upgrading to 4.8.45+ (where files already have the prefix), the old in-memory
// code runs once and produces "moflo-moflo-*" duplicates. Remove them here.
try {
  const guidanceDir = resolve(projectRoot, '.claude/guidance');
  if (existsSync(guidanceDir)) {
    let removedDoubles = 0;
    for (const file of readdirSync(guidanceDir)) {
      if ((file.startsWith('moflo-moflo-') || file === 'moflo-moflo.md' || file === 'moflo.md') && file.endsWith('.md')) {
        try {
          unlinkSync(resolve(guidanceDir, file));
          removedDoubles++;
        } catch { /* non-fatal */ }
      }
    }
    if (removedDoubles > 0) {
      emitMutation('removed legacy double-prefixed guidance files', `${removedDoubles} removed`);
    }
  }
} catch { /* non-fatal */ }

// ── 3d-yaml. Append missing top-level sections to moflo.yaml ───────────────
// Users must never be required to re-run `moflo init` after a version bump.
// When moflo ships a new top-level config section (e.g. sandbox:), append it
// with defaults + comments if the user's yaml doesn't already have it.
// Fully idempotent and never touches user-set values.
// See: .claude/guidance/internal/upgrade-contract.md
try {
  const upgraderPaths = [
    resolve(projectRoot, 'node_modules/moflo/bin/lib/yaml-upgrader.mjs'),
    resolve(projectRoot, 'bin/lib/yaml-upgrader.mjs'),
  ];
  const upgraderPath = upgraderPaths.find((p) => existsSync(p));
  const mofloYaml = resolve(projectRoot, 'moflo.yaml');
  if (upgraderPath && existsSync(mofloYaml)) {
    const { ensureYamlSections } = await import(`file://${upgraderPath.replace(/\\/g, '/')}`);
    const appended = ensureYamlSections(mofloYaml);
    if (Array.isArray(appended) && appended.length > 0) {
      emitMutation(
        'updated moflo.yaml',
        `appended ${plural(appended.length, 'section')}: ${appended.join(', ')}`,
      );
    }
  }
} catch { /* non-fatal — yaml stays as-is, user can still edit manually */ }

// ── 3d. Ensure global `flo` shim exists ─────────────────────────────────────
// Installs a tiny shim into npm's global bin so bare `flo` resolves to the
// local project's node_modules/.bin/flo. Idempotent — skips if already present.
try {
  const shimLib = resolve(projectRoot, 'node_modules/moflo/bin/lib/install-global-shim.mjs');
  const localShimLib = resolve(projectRoot, 'bin/lib/install-global-shim.mjs');
  const shimPath = existsSync(shimLib) ? shimLib : existsSync(localShimLib) ? localShimLib : null;
  if (shimPath) {
    const { installGlobalShim } = await import(`file://${shimPath.replace(/\\/g, '/')}`);
    const shimResult = installGlobalShim({ silent: true });
    if (shimResult?.installed) {
      emitMutation('installed global flo shim', 'bare `flo` now resolves to project install');
    }
  }
} catch { /* non-fatal — flo still works via npx */ }

// ── 3e. Foreground embeddings migration (visible UX) ───────────────────────
// Run the embeddings-version migration synchronously with piped stdio BEFORE
// we fire off background tasks, so the UpgradeRenderer's TTY bar / non-TTY
// status lines reach the user. Returns fast when no DB exists, the schema
// predates v3, or the stored version is already current — so the happy-path
// cost on every session start is a few ms of probe work.
//
// `onMigrationStart` / `onMigrationComplete` write to stdout because Claude
// Code's SessionStart hook captures stdout as `additionalContext` (a system
// reminder Claude sees and can surface to the user). The renderer keeps using
// stderr for the rich TTY bar — both paths fire so terminal-attached users
// AND Claude both get a visible signal that memory was being migrated (#639).
try {
  const migrationPaths = [
    resolve(projectRoot, 'node_modules/moflo/dist/src/cli/services/embeddings-migration.js'),
    resolve(projectRoot, 'dist/src/cli/services/embeddings-migration.js'),
  ];
  const migrationPath = migrationPaths.find((p) => existsSync(p));
  if (migrationPath) {
    const mod = await import(`file://${migrationPath.replace(/\\/g, '/')}`);
    if (typeof mod.runEmbeddingsMigrationIfNeeded === 'function') {
      await mod.runEmbeddingsMigrationIfNeeded({
        out: process.stderr,
        isTTY: Boolean(process.stderr.isTTY),
        onMigrationStart: () => {
          emitMutation('re-indexing memory store', 'this may take 30-60s on first run after upgrade');
        },
        onMigrationComplete: (rowsEmbedded) => {
          emitMutation('memory re-indexed', `${plural(rowsEmbedded, 'row')} re-embedded — search is back`);
        },
      });
    }
  }
} catch (err) {
  // Non-fatal — a failed/aborted migration must not block session start. The
  // driver persists its cursor so the next session picks up where we left off.
  try {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`embeddings migration check skipped: ${msg}\n`);
  } catch { /* writing the failure itself must not throw */ }
}

// ── 3f. Persist upgrade notice for statusline (#636) ────────────────────────
// When this session bumped the version stamp or repaired manifest drift, write
// a transient `.moflo/upgrade-notice.json` so the statusline can show a
// leading user-visible segment (`📦 vX → vY (N changes)`). The file expires
// via TTL — statusline silently ignores it after `expiresAt`. The next
// upgrade overwrites the file, so no manual cleanup is needed.
//
// Stdout emits go to Claude's `additionalContext` (collapsed by default in
// the system reminder); this notice surfaces the same information directly
// in the user's UI. Together they close the "Claude appears hung and CPU
// spikes" gap from #629 — the user always knows when an upgrade procedure
// just ran.
const UPGRADE_NOTICE_TTL_MS = 60 * 60 * 1000; // 1 hour
if (upgradeNoticeContext && mutationCount > 0) {
  try {
    const cfDir = resolve(projectRoot, '.moflo');
    if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
    const now = Date.now();
    const notice = {
      kind: upgradeNoticeContext.kind,
      from: upgradeNoticeContext.from,
      to: upgradeNoticeContext.to,
      at: new Date(now).toISOString(),
      expiresAt: new Date(now + UPGRADE_NOTICE_TTL_MS).toISOString(),
      changes: mutationCount,
    };
    writeFileSync(
      resolve(cfDir, 'upgrade-notice.json'),
      JSON.stringify(notice, null, 2),
    );
  } catch { /* non-fatal — statusline just won't show the segment */ }
}

// Bypasses emitMutation — framing, not a mutation, so it must not inflate the count.
if (mutationCount > 0) {
  try {
    process.stdout.write(
      'moflo: starting background tasks (daemon, indexer, pretrain — CPU may briefly spike)\n',
    );
  } catch { /* non-fatal */ }
}

// ── 4. Spawn background tasks ───────────────────────────────────────────────
const localCli = resolve(projectRoot, 'node_modules/moflo/bin/cli.js');
const hasLocalCli = existsSync(localCli);

// hooks.mjs session-start (daemon, indexer, pretrain, HNSW, neural patterns)
const hooksScript = resolve(projectRoot, '.claude/scripts/hooks.mjs');
if (existsSync(hooksScript)) {
  fireAndForget('node', [hooksScript, 'session-start'], 'hooks session-start');
}

// Patches are now baked into moflo@4.0.0 source — no runtime patching needed.

// ── 5. Done — exit immediately ──────────────────────────────────────────────
process.exit(0);
