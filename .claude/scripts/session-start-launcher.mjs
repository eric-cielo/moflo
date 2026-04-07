#!/usr/bin/env node
/**
 * Fast session-start launcher — single hook that replaces all SessionStart entries.
 *
 * Spawns background tasks via spawn(detached + unref) and exits immediately.
 *
 * Invoked by: node .claude/scripts/session-start-launcher.mjs
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
  const versionStampPath = resolve(projectRoot, '.claude-flow', 'moflo-version');
  if (autoUpdateConfig.enabled && existsSync(mofloPkgPath)) {
    const installedVersion = JSON.parse(readFileSync(mofloPkgPath, 'utf-8')).version;
    let cachedVersion = '';
    try { cachedVersion = readFileSync(versionStampPath, 'utf-8').trim(); } catch {}

    if (installedVersion !== cachedVersion) {
      const binDir = resolve(projectRoot, 'node_modules/moflo/bin');
      const manifestPath = resolve(projectRoot, '.claude-flow', 'installed-files.json');

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
          resolve(projectRoot, 'node_modules/moflo/src/modules/cli/.claude/helpers'),
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
      if (previousManifest.length > 0) {
        const currentSet = new Set(currentManifest);
        for (const rel of previousManifest) {
          if (!currentSet.has(rel)) {
            const abs = resolve(projectRoot, rel);
            try { if (existsSync(abs)) unlinkSync(abs); } catch { /* non-fatal */ }
          }
        }
      }

      // Write updated manifest + version stamp
      try {
        const cfDir = resolve(projectRoot, '.claude-flow');
        if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
        writeFileSync(manifestPath, JSON.stringify(currentManifest, null, 2));
        writeFileSync(versionStampPath, installedVersion);
      } catch {}
    }
  }
} catch {
  // Non-fatal — scripts will still work, just may be stale
}

// ── 3a. Auto-migrate settings.json (npx flo → node helpers, PATH setup) ────
// Existing users may have stale settings.json with `npx flo` hooks that break
// when npx isn't on PATH. Migrate them to direct `node .claude/helpers/...`
// invocations on every session start so users never get stuck.
try {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    let dirty = false;
    const settings = JSON.parse(raw);

    // 3a-i. Remove stale PATH override (${PATH} isn't expanded by Claude Code,
    // which replaces the inherited PATH and breaks node resolution)
    if (!settings.env) settings.env = {};
    if (settings.env.PATH) {
      delete settings.env.PATH;
      dirty = true;
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

    function migrateHooks(hookGroups) {
      if (!Array.isArray(hookGroups)) return;
      for (const group of hookGroups) {
        if (!Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) {
          if (hook.command && migrationMap.has(hook.command)) {
            hook.command = migrationMap.get(hook.command);
            dirty = true;
          }
        }
      }
    }

    if (settings.hooks) {
      for (const eventName of Object.keys(settings.hooks)) {
        migrateHooks(settings.hooks[eventName]);
      }
    }

    // 3a-iii. Ensure statusLine is wired (statusline.cjs is synced by step 3
    // but settings.json may lack the config block, so the status line never appears)
    if (!settings.statusLine) {
      settings.statusLine = {
        type: 'command',
        command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs" --compact',
      };
      dirty = true;
    }

    if (dirty) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  }
} catch { /* non-fatal — stale hooks won't block session, just emit warnings */ }

// ── 3b. Ensure shipped guidance files exist (even without version change) ──
// Subagents need these files on disk for direct reads without memory search.
try {
  const guidanceDir = resolve(projectRoot, '.claude/guidance');
  const shippedDir = resolve(projectRoot, 'node_modules/moflo/.claude/guidance/shipped');
  if (existsSync(shippedDir)) {
    const shippedFiles = readdirSync(shippedDir).filter(f => f.endsWith('.md'));
    for (const file of shippedFiles) {
      const dest = resolve(guidanceDir, file);
      if (!existsSync(dest)) {
        if (!existsSync(guidanceDir)) mkdirSync(guidanceDir, { recursive: true });
        const header = `<!-- AUTO-GENERATED by moflo session-start. Do not edit — changes will be overwritten. -->\n<!-- Source: node_modules/moflo/.claude/guidance/shipped/${file} -->\n\n`;
        const content = readFileSync(resolve(shippedDir, file), 'utf-8');
        writeFileSync(dest, header + content);
      }
    }
  }
} catch { /* non-fatal */ }

// ── 3c. Clean up double-prefixed guidance files from pre-4.8.45 upgrade ─────
// Before 4.8.45, session-start dynamically prepended "moflo-" to shipped filenames.
// When upgrading to 4.8.45+ (where files already have the prefix), the old in-memory
// code runs once and produces "moflo-moflo-*" duplicates. Remove them here.
try {
  const guidanceDir = resolve(projectRoot, '.claude/guidance');
  if (existsSync(guidanceDir)) {
    for (const file of readdirSync(guidanceDir)) {
      if ((file.startsWith('moflo-moflo-') || file === 'moflo-moflo.md' || file === 'moflo.md') && file.endsWith('.md')) {
        try { unlinkSync(resolve(guidanceDir, file)); } catch { /* non-fatal */ }
      }
    }
  }
} catch { /* non-fatal */ }

// ── 3d. Ensure global `flo` shim exists ─────────────────────────────────────
// Installs a tiny shim into npm's global bin so bare `flo` resolves to the
// local project's node_modules/.bin/flo. Idempotent — skips if already present.
try {
  const shimLib = resolve(projectRoot, 'node_modules/moflo/bin/lib/install-global-shim.mjs');
  const localShimLib = resolve(projectRoot, 'bin/lib/install-global-shim.mjs');
  const shimPath = existsSync(shimLib) ? shimLib : existsSync(localShimLib) ? localShimLib : null;
  if (shimPath) {
    const { installGlobalShim } = await import(`file://${shimPath.replace(/\\/g, '/')}`);
    installGlobalShim({ silent: true });
  }
} catch { /* non-fatal — flo still works via npx */ }

// ── 4. Spawn background tasks ───────────────────────────────────────────────
const localCli = resolve(projectRoot, 'node_modules/moflo/src/modules/cli/bin/cli.js');
const hasLocalCli = existsSync(localCli);

// hooks.mjs session-start (daemon, indexer, pretrain, HNSW, neural patterns)
const hooksScript = resolve(projectRoot, '.claude/scripts/hooks.mjs');
if (existsSync(hooksScript)) {
  fireAndForget('node', [hooksScript, 'session-start'], 'hooks session-start');
}

// Patches are now baked into moflo@4.0.0 source — no runtime patching needed.

// ── 5. Done — exit immediately ──────────────────────────────────────────────
process.exit(0);
