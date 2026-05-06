/**
 * MoFlo Project Initializer
 *
 * One-stop setup that makes MoFlo work out of the box:
 * 1. Generate moflo.yaml (project config)
 * 2. Set up .claude/settings.json hooks
 * 3. Create .claude/skills/flo/ skill (with /fl alias)
 * 4. Append MoFlo section to CLAUDE.md
 * 5. Initialize memory DB
 * 6. Auto-index guidance + code map
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { locateMofloRootPath } from '../services/moflo-require.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import {
  discoverGuidanceDirs,
  discoverSrcDirs,
  discoverTestDirs,
  detectExtensions,
  renderMofloYaml,
  type MofloYamlConfig,
} from './moflo-yaml-template.js';
import {
  generateClaudeMd as generateMofloSection,
  MARKER_START,
  MARKER_END,
  LEGACY_MARKER_STARTS,
  LEGACY_MARKER_ENDS,
} from './claudemd-generator.js';
import { DEFAULT_INIT_OPTIONS } from './types.js';

export { discoverTestDirs };

// ============================================================================
// Types
// ============================================================================

export interface MofloInitOptions {
  projectRoot: string;
  force?: boolean;
  skipIndex?: boolean;
  interactive?: boolean;
  minimal?: boolean;
}

export interface MofloInitAnswers {
  guidance: boolean;
  guidanceDirs: string[];
  codeMap: boolean;
  srcDirs: string[];
  tests: boolean;
  testDirs: string[];
  gates: boolean;
  stopHook: boolean;
}

export interface MofloInitResult {
  steps: { name: string; status: 'created' | 'updated' | 'skipped' | 'error'; detail?: string }[];
}

// ============================================================================
// Init
// ============================================================================

/**
 * Resolve `<moflo package root>/<rel>`, returning a single-element array if
 * the file/dir exists or empty array otherwise. Wraps `locateMofloRootPath`
 * (which already does the walk-up + cache + existence check) so candidate
 * lists can splat the result and ignore the missing case without a guard.
 *
 * Replaces the fixed-depth `path.join(thisDir, '..', '..', '..', '..', ...)`
 * walks that broke after workspace-collapse epic #586 changed source/dist
 * depths (#781 / #782).
 */
function mofloRootJoin(...segments: string[]): string[] {
  const hit = locateMofloRootPath(segments.join('/'));
  return hit ? [hit] : [];
}

/**
 * Run interactive wizard to collect user preferences.
 */
async function runWizard(root: string): Promise<MofloInitAnswers> {
  const { confirm, input } = await import('../prompt.js');

  // Detect project structure
  const detectedGuidance = discoverGuidanceDirs(root);

  const detectedSrc = discoverSrcDirs(root);

  // Ask questions
  const guidance = await confirm({
    message: detectedGuidance.length > 0
      ? `Found guidance docs in ${detectedGuidance.join(', ')}. Enable guidance indexing?`
      : 'Do you have project guidance/documentation to index?',
    default: true,
  });

  let guidanceDirs = detectedGuidance.length > 0 ? detectedGuidance : ['.claude/guidance'];
  if (guidance) {
    const answer = await input({
      message: 'Guidance directories (comma-separated):',
      default: guidanceDirs.join(', '),
    });
    guidanceDirs = answer.split(',').map((d: string) => d.trim()).filter(Boolean);
  }

  const codeMap = await confirm({
    message: detectedSrc.length > 0
      ? `Found source in ${detectedSrc.join(', ')}. Enable code map for navigation?`
      : 'Enable code map for codebase navigation?',
    default: true,
  });

  let srcDirs = detectedSrc.length > 0 ? detectedSrc : ['src'];
  if (codeMap) {
    const answer = await input({
      message: 'Source directories (comma-separated):',
      default: srcDirs.join(', '),
    });
    srcDirs = answer.split(',').map((d: string) => d.trim()).filter(Boolean);
  }

  // Detect test directories
  const detectedTests = discoverTestDirs(root);

  const tests = await confirm({
    message: detectedTests.length > 0
      ? `Found tests in ${detectedTests.join(', ')}. Enable test file indexing?`
      : 'Enable test file indexing?',
    default: true,
  });

  let testDirs = detectedTests.length > 0 ? detectedTests : ['tests'];
  if (tests) {
    const answer = await input({
      message: 'Test directories (comma-separated):',
      default: testDirs.join(', '),
    });
    testDirs = answer.split(',').map((d: string) => d.trim()).filter(Boolean);
  }

  const gates = await confirm({
    message: 'Enable spell gates (memory-first, task-create-before-agents)?',
    default: true,
  });

  const stopHook = await confirm({
    message: 'Enable session-end hook (saves session state)?',
    default: true,
  });

  return { guidance, guidanceDirs, codeMap, srcDirs, tests, testDirs, gates, stopHook };
}

/**
 * Get default answers (--yes mode).
 */
function defaultAnswers(root: string): MofloInitAnswers {
  const guidanceDirs = discoverGuidanceDirs(root);
  if (guidanceDirs.length === 0) guidanceDirs.push('.claude/guidance');

  const srcDirs = discoverSrcDirs(root);
  if (srcDirs.length === 0) srcDirs.push('src');

  const testDirs = discoverTestDirs(root);
  if (testDirs.length === 0) testDirs.push('tests');

  return { guidance: true, guidanceDirs, codeMap: true, srcDirs, tests: true, testDirs, gates: true, stopHook: true };
}

/**
 * Get minimal answers (--minimal mode).
 */
function minimalAnswers(): MofloInitAnswers {
  return { guidance: false, guidanceDirs: [], codeMap: false, srcDirs: [], tests: false, testDirs: [], gates: false, stopHook: false };
}

export async function initMoflo(options: MofloInitOptions): Promise<MofloInitResult> {
  const { projectRoot, force, interactive, minimal } = options;
  const steps: MofloInitResult['steps'] = [];

  // Collect answers based on mode
  const answers = minimal
    ? minimalAnswers()
    : interactive
      ? await runWizard(projectRoot)
      : defaultAnswers(projectRoot);

  // Step 1: moflo.yaml
  steps.push(generateConfig(projectRoot, force, answers));

  // Step 2: .claude/settings.json hooks
  steps.push(generateHooks(projectRoot, force, answers));

  // Step 3: .claude/skills/flo/ (with /fl alias)
  steps.push(generateSkill(projectRoot, force));

  // Step 4: CLAUDE.md MoFlo section
  steps.push(generateClaudeMd(projectRoot, force));

  // Step 5: .claude/scripts/ from moflo bin/
  steps.push(syncScripts(projectRoot, force));

  // Step 6: .gitignore entries
  steps.push(updateGitignore(projectRoot));

  // Step 7: .claude/guidance/moflo-bootstrap.md (subagent bootstrap protocol)
  steps.push(syncBootstrapGuidance(projectRoot, force));

  // Step 8: Sync ALL shipped guidance docs from moflo to project
  steps.push(...syncAllShippedGuidance(projectRoot, force));

  // Step 9: Install global `flo` shim so bare `flo` command works without npx
  steps.push(installGlobalFloShim(projectRoot));

  return { steps };
}

// ============================================================================
// Step 1: moflo.yaml
// ============================================================================

function generateConfig(root: string, force?: boolean, answers?: MofloInitAnswers): MofloInitResult['steps'][0] {
  const configPath = path.join(root, 'moflo.yaml');

  if (fs.existsSync(configPath) && !force) {
    return { name: 'moflo.yaml', status: 'skipped', detail: 'Already exists (use --force to overwrite)' };
  }

  const srcDirs = answers?.srcDirs ?? ['src'];
  const config: MofloYamlConfig = {
    projectName: path.basename(root),
    guidanceDirs: answers?.guidanceDirs ?? ['.claude/guidance'],
    srcDirs,
    testDirs: answers?.testDirs ?? ['tests'],
    detectedExts: detectExtensions(root, srcDirs),
    guidance: answers?.guidance ?? true,
    codeMap: answers?.codeMap ?? true,
    tests: answers?.tests ?? true,
    gates: answers?.gates ?? true,
    stopHook: answers?.stopHook ?? true,
  };

  fs.writeFileSync(configPath, renderMofloYaml(config), 'utf-8');
  return {
    name: 'moflo.yaml',
    status: 'created',
    detail: `Detected: ${config.srcDirs.join(', ')} | ${config.detectedExts.join(', ')}`,
  };
}

// ============================================================================
// Step 2: .claude/settings.json hooks
// ============================================================================

function generateHooks(root: string, force?: boolean, answers?: MofloInitAnswers): MofloInitResult['steps'][0] {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settingsDir = path.dirname(settingsPath);

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  let existing: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }

    // Check if MoFlo hooks already set up
    const settingsStr = JSON.stringify(existing);
    const hasGateHooks = settingsStr.includes('flo gate') || settingsStr.includes('moflo gate');
    if (hasGateHooks && !force) {
      return { name: '.claude/settings.json', status: 'skipped', detail: 'MoFlo hooks already configured' };
    }
  }

  // Build hooks config — all on by default (opinionated pit-of-success)
  // Uses direct node invocation via helper scripts (gate.cjs, gate-hook.mjs,
  // hook-handler.cjs) instead of `npx flo` to avoid 2-5s cold-start per hook.
  const gateHook = (sub: string) => `node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs" ${sub}`;
  const gate = (sub: string) => `node "$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs" ${sub}`;
  const handler = (sub: string) => `node "$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs" ${sub}`;
  const hooks: Record<string, any[]> = {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{ "type": "command", "command": handler('post-edit'), "timeout": 5000 }]
      },
      {
        "matcher": "^(Glob|Grep)$",
        "hooks": [{ "type": "command", "command": gateHook('check-before-scan'), "timeout": 3000 }]
      },
      {
        "matcher": "^Read$",
        "hooks": [{ "type": "command", "command": gateHook('check-before-read'), "timeout": 3000 }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": gateHook('check-dangerous-command'), "timeout": 2000 },
          { "type": "command", "command": gateHook('check-before-pr'), "timeout": 2000 }
        ]
      },
      {
        // #931 — Advisory only; never blocks. TaskCreate REMINDER and the
        // namespace hint moved here from UserPromptSubmit so they emit only
        // when Claude is about to spawn an Agent — saves ~90 tokens × every
        // prompt × every consumer. Routed via gate-hook.mjs so Claude Code's
        // session_id is forwarded as HOOK_SESSION_ID, enabling per-actor
        // single-shot emission (mirror of #879's record-memory-searched fix).
        "matcher": "^Agent$",
        "hooks": [{ "type": "command", "command": gateHook('check-before-agent'), "timeout": 2000 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [
          { "type": "command", "command": handler('post-edit'), "timeout": 5000 },
          { "type": "command", "command": gateHook('reset-edit-gates'), "timeout": 2000 }
        ]
      },
      {
        "matcher": "^Agent$",
        "hooks": [{ "type": "command", "command": handler('post-task'), "timeout": 5000 }]
      },
      {
        "matcher": "^TaskCreate$",
        "hooks": [{ "type": "command", "command": gate('record-task-created'), "timeout": 2000 }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [
          { "type": "command", "command": gateHook('check-bash-memory'), "timeout": 2000 },
          { "type": "command", "command": gateHook('record-test-run'), "timeout": 2000 }
        ]
      },
      {
        "matcher": "^Skill$",
        "hooks": [{ "type": "command", "command": gateHook('record-skill-run'), "timeout": 2000 }]
      },
      {
        // Anchored alternation — Claude Code anchors hook matchers (`^…$` semantics),
        // so a bare `mcp__moflo__memory_` never matches any real MCP tool name and the
        // hook silently no-ops (#929 regression). The explicit suffix list keeps the
        // matcher narrow while catching every memory_* tool we ship.
        // Use gateHook (not gate) so the wrapper forwards Claude Code's session_id as
        // HOOK_SESSION_ID — record-memory-searched needs this to mark the per-actor map
        // (memorySearchedBy[sid]) that check-before-read consults under #838's per-actor gating.
        // Without it, the legacy boolean is set but the per-actor map stays empty, and the gate
        // blocks every Read forever within the turn (issue #879).
        "matcher": "^mcp__moflo__memory_(search|retrieve|list|stats|store)$",
        "hooks": [{ "type": "command", "command": gateHook('record-memory-searched'), "timeout": 3000 }]
      },
      {
        "matcher": "^mcp__moflo__memory_store$",
        "hooks": [{ "type": "command", "command": gate('record-learnings-stored'), "timeout": 2000 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": `node "$CLAUDE_PROJECT_DIR/.claude/helpers/prompt-hook.mjs"`, "timeout": 3000 }
        ]
      },
      {
        // prompt-state-reset is REQUIRED to reset memorySearched/memorySearchedBy on
        // each new prompt and reclassify memoryRequired. Without it, gate state leaks
        // across prompts. Separate hook entry so a prompt-hook.mjs exception doesn't
        // skip the reset. Idempotent state reset only — no emission, no
        // interactionCount increment (#931 dedupe).
        "hooks": [
          { "type": "command", "command": gateHook('prompt-state-reset'), "timeout": 3000 }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "node \"$CLAUDE_PROJECT_DIR/.claude/helpers/subagent-start.cjs\"",
          "timeout": 2000
        }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/scripts/session-start-launcher.mjs\"",
            "timeout": 3000
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": handler('session-end'), "timeout": 5000 }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{ "type": "command", "command": gate('compact-guidance'), "timeout": 3000 }]
      }
    ],
    "Notification": [
      {
        "hooks": [{ "type": "command", "command": handler('notification'), "timeout": 3000 }]
      }
    ]
  };

  // Merge: preserve existing non-MoFlo hooks, add MoFlo hooks
  existing.hooks = hooks;

  // Ensure statusLine is always present (required for dashboard display).
  // The executor.ts / settings-generator.ts code path adds this, but
  // moflo-init.ts uses its own generateHooks() which was missing it.
  if (!existing.statusLine) {
    existing.statusLine = {
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs"',
    };
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
  return { name: '.claude/settings.json', status: existing.hooks ? 'updated' : 'created', detail: '14 hooks configured (gates, lifecycle, routing, session)' };
}

// ============================================================================
// Step 3: .claude/skills/flo/ skill (with /fl alias)
// ============================================================================

function generateSkill(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const skillDir = path.join(root, '.claude', 'skills', 'flo');
  const skillFile = path.join(skillDir, 'SKILL.md');
  const aliasDir = path.join(root, '.claude', 'skills', 'fl');
  const aliasFile = path.join(aliasDir, 'SKILL.md');

  if (fs.existsSync(skillFile) && !force) {
    return { name: '.claude/skills/flo/', status: 'skipped', detail: 'Already exists' };
  }

  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  // Copy static SKILL.md from moflo package instead of generating it
  let skillContent = '';

  const staticSkillCandidates = [
    // Installed via npm (most common)
    path.join(root, 'node_modules', 'moflo', '.claude', 'skills', 'flo', 'SKILL.md'),
    // Anchor on moflo's own package root — covers both `node_modules/moflo/`
    // and the dev source tree without depending on a fixed `..` depth (#782).
    ...mofloRootJoin('.claude', 'skills', 'flo', 'SKILL.md'),
  ];
  for (const candidate of staticSkillCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        skillContent = fs.readFileSync(candidate, 'utf-8');
        break;
      }
    } catch { /* skip inaccessible paths */ }
  }

  if (!skillContent) {
    return { name: '.claude/skills/flo/', status: 'error', detail: 'Could not find SKILL.md in moflo package' };
  }

  fs.writeFileSync(skillFile, skillContent, 'utf-8');

  // Create /fl alias (same content)
  if (!fs.existsSync(aliasDir)) {
    fs.mkdirSync(aliasDir, { recursive: true });
  }
  fs.writeFileSync(aliasFile, skillContent.replace('name: flo', 'name: fl'), 'utf-8');

  // Clean up old /mf skill directory if it exists
  const oldSkillDir = path.join(root, '.claude', 'skills', 'mf');
  if (fs.existsSync(oldSkillDir)) {
    fs.rmSync(oldSkillDir, { recursive: true });
  }

  return { name: '.claude/skills/flo/', status: 'created', detail: '/flo skill ready (alias: /fl)' };
}

// ============================================================================
// Step 4: CLAUDE.md MoFlo section
// ============================================================================

function generateClaudeMd(root: string, _force?: boolean): MofloInitResult['steps'][0] {
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  let existing = '';

  if (fs.existsSync(claudeMdPath)) {
    existing = fs.readFileSync(claudeMdPath, 'utf-8');

    // Strip current or legacy MoFlo block so we can re-inject the latest content.
    const allStartMarkers = [MARKER_START, ...LEGACY_MARKER_STARTS];
    const allEndMarkers = [MARKER_END, ...LEGACY_MARKER_ENDS];

    for (let i = 0; i < allStartMarkers.length; i++) {
      if (existing.includes(allStartMarkers[i])) {
        const startIdx = existing.indexOf(allStartMarkers[i]);
        const endIdx = existing.indexOf(allEndMarkers[i]);
        if (endIdx > startIdx) {
          existing = existing.substring(0, startIdx) + existing.substring(endIdx + allEndMarkers[i].length);
        }
      }
    }
  }

  // Single source of truth: claudemd-generator.ts owns the section content.
  const canonical = generateMofloSection(DEFAULT_INIT_OPTIONS);
  const finalContent = existing.trimEnd() + '\n\n' + canonical;
  fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');

  return {
    name: 'CLAUDE.md',
    status: existing ? 'updated' : 'created',
    detail: 'MoFlo section injected (~22 lines)',
  };
}

// ============================================================================
// Step 5: .claude/scripts/ — sync from moflo bin/
// These scripts are used by session-start hooks for indexing, code map, etc.
// Always overwrite to keep them in sync with the installed moflo version.
// ============================================================================

// Must mirror UPGRADE_SCRIPT_MAP in src/cli/init/executor.ts and the
// scriptFiles array in bin/session-start-launcher.mjs — first-init drops any
// script missing here, and the launcher's manifest cleanup later treats it as
// orphan residue and deletes it (#777, feedback_scriptfiles_sync.md).
const SCRIPT_MAP: string[] = [
  'hooks.mjs',
  'session-start-launcher.mjs',
  'index-guidance.mjs',
  'build-embeddings.mjs',
  'generate-code-map.mjs',
  'semantic-search.mjs',
  'index-tests.mjs',
  'index-patterns.mjs',
  'index-all.mjs',
  'setup-project.mjs',
  'run-migrations.mjs',
];

function syncScripts(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const scriptsDir = path.join(root, '.claude', 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }

  // Find moflo bin/ directory
  const candidates = [
    path.join(root, 'node_modules', 'moflo', 'bin'),
    // Anchor on moflo's own package root (covers dev + installed; #782).
    ...mofloRootJoin('bin'),
  ];
  const binDir = candidates.find(d => { try { return fs.existsSync(d); } catch { return false; } });

  if (!binDir) {
    return { name: '.claude/scripts/', status: 'skipped', detail: 'moflo bin/ not found' };
  }

  let copied = 0;
  for (const name of SCRIPT_MAP) {
    const srcPath = path.join(binDir, name);
    const destPath = path.join(scriptsDir, name);

    if (!fs.existsSync(srcPath)) continue;

    // Always overwrite scripts to keep in sync (they're derived, not user-edited)
    if (!fs.existsSync(destPath) || force || isStale(srcPath, destPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied++;
    }
  }

  if (copied === 0) {
    return { name: '.claude/scripts/', status: 'skipped', detail: 'Scripts already up to date' };
  }
  return { name: '.claude/scripts/', status: 'updated', detail: `${copied} scripts synced from moflo` };
}

function isStale(srcPath: string, destPath: string): boolean {
  try {
    return fs.statSync(srcPath).mtimeMs > fs.statSync(destPath).mtimeMs;
  } catch {
    return true;
  }
}

// ============================================================================
// Step 6: .gitignore
// ============================================================================

function updateGitignore(root: string): MofloInitResult['steps'][0] {
  const gitignorePath = path.join(root, '.gitignore');
  const entries = [
    '.claude-epic/',
    '.moflo/',
    '.swarm/',
    '.moflo/',
    '.claude/settings.local.json',
    '.claude/scheduled_tasks.lock',
    '**/workflow-state.json',
  ];

  if (!fs.existsSync(gitignorePath)) {
    const defaultEntries = ['node_modules/', 'dist/', '.env', '.env.*', ''];
    const content = '# Dependencies\n' + defaultEntries.join('\n') + '\n# MoFlo state\n' + entries.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf-8');
    return { name: '.gitignore', status: 'created', detail: 'Created with node_modules, .env, and MoFlo entries' };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const existingLines = new Set(
    existing.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')),
  );
  const toAdd = entries.filter(e => !existingLines.has(e));

  if (toAdd.length === 0) {
    return { name: '.gitignore', status: 'skipped', detail: 'Entries already present' };
  }

  const sep = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, sep + '\n# MoFlo state (gitignored)\n' + toAdd.join('\n') + '\n');
  return { name: '.gitignore', status: 'updated', detail: `Added: ${toAdd.join(', ')}` };
}

// ============================================================================
// Step 7: .claude/guidance/moflo-bootstrap.md
// Copies the agent bootstrap guidance to the project so subagents can read it
// from disk without requiring memory search.
// ============================================================================

function syncBootstrapGuidance(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const guidanceDir = path.join(root, '.claude', 'guidance');
  const targetFile = path.join(guidanceDir, 'moflo-bootstrap.md');

  const candidates = [
    path.join(root, 'node_modules', 'moflo', '.claude', 'guidance', 'shipped', 'moflo-subagents.md'),
    // Anchor on moflo's own package root (covers dev + installed; #782).
    ...mofloRootJoin('.claude', 'guidance', 'shipped', 'moflo-subagents.md'),
  ];
  const sourceFile = candidates.find(f => { try { return fs.existsSync(f); } catch { return false; } });

  if (!sourceFile) {
    return { name: 'guidance/moflo-bootstrap.md', status: 'skipped', detail: 'Source bootstrap not found' };
  }

  // Check if target exists and is up to date
  if (fs.existsSync(targetFile) && !force) {
    if (!isStale(sourceFile, targetFile)) {
      return { name: 'guidance/moflo-bootstrap.md', status: 'skipped', detail: 'Already up to date' };
    }
  }

  // Read source and prepend header
  const content = fs.readFileSync(sourceFile, 'utf-8');
  const header = `<!-- AUTO-GENERATED by moflo init. Do not edit — changes will be overwritten on next init. -->\n<!-- Source: moflo/.claude/guidance/shipped/moflo-subagents.md -->\n<!-- To customize, create your own project-specific guidance in .claude/guidance/. -->\n\n`;

  fs.mkdirSync(guidanceDir, { recursive: true });
  fs.writeFileSync(targetFile, header + content, 'utf-8');

  return {
    name: 'guidance/moflo-bootstrap.md',
    status: fs.existsSync(targetFile) ? 'updated' : 'created',
    detail: 'Subagent bootstrap protocol'
  };
}

// ============================================================================
// Step 8: Sync ALL shipped guidance docs
// Discovers all .md files in moflo/.claude/guidance/shipped/ and copies them
// to project .claude/guidance/. Skips moflo-subagents.md (handled by Step 7).
// ============================================================================

function syncAllShippedGuidance(root: string, force?: boolean): MofloInitResult['steps'][0][] {
  const guidanceDir = path.join(root, '.claude', 'guidance');

  // Find the shipped guidance directory
  const shippedCandidates = [
    path.join(root, 'node_modules', 'moflo', '.claude', 'guidance', 'shipped'),
    // Anchor on moflo's own package root (covers dev + installed; #782).
    ...mofloRootJoin('.claude', 'guidance', 'shipped'),
  ];
  const shippedDir = shippedCandidates.find(d => { try { return fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch { return false; } });

  if (!shippedDir) {
    return [{ name: 'guidance/shipped/*', status: 'skipped', detail: 'Shipped guidance directory not found' }];
  }

  // Discover all .md files, skip moflo-subagents.md (synced separately as moflo-bootstrap.md)
  const files = fs.readdirSync(shippedDir).filter(f => f.endsWith('.md') && f !== 'moflo-subagents.md');

  if (files.length === 0) {
    return [{ name: 'guidance/shipped/*', status: 'skipped', detail: 'No shipped guidance files found' }];
  }

  const results: MofloInitResult['steps'][0][] = [];

  for (const filename of files) {
    const sourceFile = path.join(shippedDir, filename);
    const targetFile = path.join(guidanceDir, filename);

    if (fs.existsSync(targetFile) && !force) {
      if (!isStale(sourceFile, targetFile)) {
        results.push({ name: `guidance/${filename}`, status: 'skipped', detail: 'Already up to date' });
        continue;
      }
    }

    const content = fs.readFileSync(sourceFile, 'utf-8');
    const header = `<!-- AUTO-GENERATED by moflo init. Do not edit — changes will be overwritten on next init. -->\n<!-- Source: moflo/.claude/guidance/shipped/${filename} -->\n\n`;

    fs.mkdirSync(guidanceDir, { recursive: true });
    fs.writeFileSync(targetFile, header + content, 'utf-8');

    results.push({
      name: `guidance/${filename}`,
      status: 'updated',
      detail: `Shipped guidance synced`,
    });
  }

  return results;
}

// ============================================================================
// Step 9: Install global `flo` CLI shim
// Places a tiny shim in npm's global bin directory so bare `flo` works
// everywhere without npx. The shim walks up from cwd to find and exec the
// local project's node_modules/.bin/flo — correct version always runs.
// ============================================================================

function installGlobalFloShim(root: string): MofloInitResult['steps'][0] {
  try {
    const shimLibCandidates = [
      path.join(root, 'node_modules', 'moflo', 'bin', 'lib', 'install-global-shim.mjs'),
      path.join(root, 'bin', 'lib', 'install-global-shim.mjs'),
    ];
    const shimLib = shimLibCandidates.find(p => fs.existsSync(p));

    if (!shimLib) {
      return { name: 'global flo shim', status: 'skipped', detail: 'Shim installer not found' };
    }

    // Dynamic import of the ESM shim installer
    // We use a sync approach: spawn a child process to run the installer
    const result = execSync(
      `node -e "import('file://${shimLib.replace(/\\/g, '/')}').then(m => { const r = m.installGlobalShim(); console.log(JSON.stringify(r)); })"`,
      { encoding: 'utf8', timeout: 10000 },
    ).trim();

    const parsed = JSON.parse(result);
    if (parsed.installed) {
      return { name: 'global flo shim', status: 'created', detail: `Installed to ${parsed.path}` };
    } else if (parsed.skipped) {
      return { name: 'global flo shim', status: 'skipped', detail: parsed.error || 'Already installed' };
    }
    return { name: 'global flo shim', status: 'skipped', detail: 'Already up to date' };
  } catch (err: unknown) {
    const msg = errorDetail(err);
    return { name: 'global flo shim', status: 'error', detail: msg };
  }
}
