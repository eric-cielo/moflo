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
import { generateClaudeMd as generateMofloSection } from './claudemd-generator.js';
import { applyInjectionReplacement } from '../services/claudemd-injection.js';
import { loadShippedScripts } from './shipped-scripts.js';
import { DEFAULT_INIT_OPTIONS } from './types.js';
import { generateSettings } from './settings-generator.js';
import {
  applyWholesaleRegeneration,
  computeHookBlockDrift,
  isHookBlockLocked,
} from '../services/hook-block-hash.js';
import { rewriteIncorrectHookWiring } from '../services/hook-wiring.js';

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

  // Step 7: Sync ALL shipped guidance docs from moflo to project (includes
  // moflo-subagents.md — no separate rename to moflo-bootstrap.md, see #939)
  steps.push(...syncAllShippedGuidance(projectRoot, force));

  // Step 8: Install global `flo` shim so bare `flo` command works without npx
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

// #1227 — `flo init` was the surgical patcher that silently nuked user-owned
// hooks (project-analysis-gate.cjs, e2e-gate.cjs) AND moflo entries in legacy
// slots (swarm_init/hive-mind_init in PreToolUse, auto-memory-hook in SessionEnd).
// The old generateHooks had three structural defects:
//   (1) Its "already configured" guard scanned for the literal substring
//       `'flo gate'` / `'moflo gate'` — modern moflo commands are
//       `node ".../helpers/gate.cjs ..."` so the substring NEVER matched and
//       the guard always fell through to the wipe path.
//   (2) `existing.hooks = hooks` was a wholesale overwrite — the comment claimed
//       "preserve existing non-MoFlo hooks" but the code did the opposite.
//   (3) Its inlined canonical block had drifted from settings-generator.ts /
//       hook-block-hash.ts (no swarm_init, no hive-mind_init, no Stop
//       auto-memory-hook, SessionStart launcher timeout 3000 not 5000).
//
// New shape: one canonical source. For missing settings.json, write
// generateSettings(DEFAULT_INIT_OPTIONS). For existing, run the same wholesale
// regen the session-start launcher uses — applyWholesaleRegeneration preserves
// user-owned entries via the #1180 basename guard AND relocates moflo entries
// from legacy slots (SessionEnd → Stop, PreToolUse swarm_init → PostToolUse,
// etc.). rewriteIncorrectHookWiring runs first so command-string rewrites
// (#879 / #931) are healed before the structural pass hashes the block.
function generateHooks(root: string, force?: boolean, _answers?: MofloInitAnswers): MofloInitResult['steps'][0] {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settingsDir = path.dirname(settingsPath);

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // No settings.json yet — write the canonical default and return.
  if (!fs.existsSync(settingsPath)) {
    const fresh = generateSettings({ ...DEFAULT_INIT_OPTIONS, targetDir: root, force: true });
    fs.writeFileSync(settingsPath, JSON.stringify(fresh, null, 2), 'utf-8');
    return { name: '.claude/settings.json', status: 'created', detail: 'canonical hooks block written' };
  }

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // Corrupt — rewrite from canonical (force-overwrites; user can revert).
    const fresh = generateSettings({ ...DEFAULT_INIT_OPTIONS, targetDir: root, force: true });
    fs.writeFileSync(settingsPath, JSON.stringify(fresh, null, 2), 'utf-8');
    return { name: '.claude/settings.json', status: 'updated', detail: 'rewrote unparseable settings.json from canonical' };
  }

  // Respect the explicit opt-out — same sentinel the launcher honours.
  if (isHookBlockLocked(existing) && !force) {
    return { name: '.claude/settings.json', status: 'skipped', detail: 'moflo.hooks.locked=true (explicit opt-out)' };
  }

  // Pass 1: in-place command + matcher rewrites (#879, #929, #931, #1171,
  // auto-meditate rebrand). These never delete anything; they fix commands
  // that exist but point at the wrong helper/subcommand.
  const { rewrites } = rewriteIncorrectHookWiring(existing);
  const rewroteCommands = rewrites.reduce((n, r) => n + r.count, 0);

  // Pass 2: structural wholesale regen. Preserves user-owned entries via the
  // #1180 basename guard (any command not pointing at a moflo-shipped helper
  // is grafted back in); relocates moflo entries from legacy event/matcher
  // slots to the current canonical shape.
  const report = computeHookBlockDrift((existing.hooks ?? {}) as Record<string, unknown>);
  let added = 0;
  let removed = 0;
  let preserved = 0;
  if (report.drifted) {
    const extraCount = report.extra.length;
    const result = applyWholesaleRegeneration(existing, report);
    added = result.added;
    removed = result.removed;
    // applyWholesaleRegeneration computes `removed = extra - customisations`,
    // so `preserved` is the complement — the number of user-owned entries
    // grafted back into the fresh tree.
    preserved = extraCount - removed;
  }

  // Ensure statusLine + permissions/env/attribution scaffold is present —
  // mirrors the existing moflo-init.ts UX but no longer overwrites user
  // values that are already set.
  const canonical = generateSettings({ ...DEFAULT_INIT_OPTIONS, targetDir: root, force: true }) as Record<string, unknown>;
  const scaffoldKeys = ['statusLine', 'permissions', 'env', 'attribution'] as const;
  const scaffoldAdded: string[] = [];
  for (const key of scaffoldKeys) {
    if (existing[key] == null && canonical[key] != null) {
      existing[key] = canonical[key];
      scaffoldAdded.push(key);
    }
  }

  const dirty = rewroteCommands > 0 || added > 0 || removed > 0 || scaffoldAdded.length > 0;
  if (!dirty) {
    return { name: '.claude/settings.json', status: 'skipped', detail: 'already at canonical reference' };
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');

  // Surface deletions, preserved customisations, and rewrites so nothing is
  // silent — direct response to #1227's "no notice was printed" complaint.
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} canonical`);
  if (removed > 0) parts.push(`-${removed} stale moflo`);
  if (preserved > 0) parts.push(`✓${preserved} preserved`);
  if (rewroteCommands > 0) parts.push(`↻${rewroteCommands} rewrites`);
  if (scaffoldAdded.length > 0) parts.push(`+scaffold (${scaffoldAdded.join(',')})`);
  return { name: '.claude/settings.json', status: 'updated', detail: parts.join(', ') };
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
  const existed = fs.existsSync(claudeMdPath);
  const existing = existed ? fs.readFileSync(claudeMdPath, 'utf-8') : null;

  // Single source of truth: claudemd-generator.ts owns the section content,
  // claudemd-injection.ts owns the marker-replace logic. Replaces in place
  // when a marker pair (current or legacy) already exists; otherwise creates
  // a fresh CLAUDE.md or appends to a non-moflo one.
  const canonical = generateMofloSection(DEFAULT_INIT_OPTIONS);
  const result = applyInjectionReplacement(existing, canonical);
  if (result.contents !== null && (result.changed || !existed)) {
    fs.writeFileSync(claudeMdPath, result.contents, 'utf-8');
  }

  return {
    name: 'CLAUDE.md',
    status: existed ? 'updated' : 'created',
    detail: 'MoFlo section injected (~22 lines)',
  };
}

// ============================================================================
// Step 5: .claude/scripts/ — sync from moflo bin/
// These scripts are used by session-start hooks for indexing, code map, etc.
// Always overwrite to keep them in sync with the installed moflo version.
// ============================================================================

// The script sync list is read from the canonical manifest
// bin/lib/shipped-scripts.json (#1191) — single source of truth shared with the
// launcher, the post-install bootstrap, and executor.ts. No more hand-mirrored
// arrays that drift (which #1184 hit across all four sites).

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

  let scriptFiles: string[];
  try {
    scriptFiles = loadShippedScripts(path.join(binDir, 'lib')).scriptFiles;
  } catch (err) {
    return { name: '.claude/scripts/', status: 'skipped', detail: `shipped-scripts manifest unreadable: ${errorDetail(err)}` };
  }

  let copied = 0;
  for (const name of scriptFiles) {
    const srcPath = path.join(binDir, name);
    const destPath = path.join(scriptsDir, name);

    if (!fs.existsSync(srcPath)) continue;

    // Always overwrite scripts to keep in sync (they're derived, not user-edited)
    if (!fs.existsSync(destPath) || force || isStale(srcPath, destPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied++;
    }
  }

  // Sync bin/lib/ and bin/migrations/ recursively. The top-level scripts
  // import `./lib/moflo-resolve.mjs` etc., so omitting these subtrees leaves
  // every synced script unable to load (#1090). The upgrade path in
  // executor.ts and the post-install bootstrap both sync these trees — init
  // had drifted out of step.
  copied += syncTree(path.join(binDir, 'lib'), path.join(scriptsDir, 'lib'), force);
  copied += syncTree(path.join(binDir, 'migrations'), path.join(scriptsDir, 'migrations'), force);

  if (copied === 0) {
    return { name: '.claude/scripts/', status: 'skipped', detail: 'Scripts already up to date' };
  }
  return { name: '.claude/scripts/', status: 'updated', detail: `${copied} scripts synced from moflo` };
}

function syncTree(srcRoot: string, destRoot: string, force?: boolean): number {
  if (!fs.existsSync(srcRoot)) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcRoot, { recursive: true, withFileTypes: true }) as fs.Dirent[];
  } catch {
    return 0;
  }
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as fs.Dirent & { parentPath?: string }).parentPath
      ?? (entry as fs.Dirent & { path?: string }).path
      ?? srcRoot;
    const absSrc = path.join(parent, entry.name);
    const rel = path.relative(srcRoot, absSrc).split(path.sep).join('/');
    const absDest = path.join(destRoot, rel);
    try {
      fs.mkdirSync(path.dirname(absDest), { recursive: true });
      if (!fs.existsSync(absDest) || force || isStale(absSrc, absDest)) {
        fs.copyFileSync(absSrc, absDest);
        copied++;
      }
    } catch {
      // Non-fatal — skip individual file on error
    }
  }
  return copied;
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

export function updateGitignore(root: string): MofloInitResult['steps'][0] {
  const gitignorePath = path.join(root, '.gitignore');
  // Script ignore patterns from the canonical manifest (#1191); a broken/absent
  // manifest just omits them — gitignore is non-critical (scripts are derived).
  let scriptIgnorePatterns: string[] = [];
  try {
    scriptIgnorePatterns = loadShippedScripts().scriptFiles.map(name => `/.claude/scripts/${name}`);
  } catch { /* manifest unreadable — omit (non-critical) */ }
  const entries = [
    '.claude-epic/',
    '.moflo/',
    '.swarm/',
    '.claude/settings.local.json',
    '.claude/scheduled_tasks.lock',
    '**/workflow-state.json',
    // Leading `/` anchors to gitignore root — bare `.claude/guidance/` once
    // swallowed shipped/internal subdirs and broke `npm pack`
    // (guidance-gitignore-shipped-trap).
    '/.claude/guidance/moflo-*.md',
    ...scriptIgnorePatterns,
  ];

  // Treat `/.foo` and `.foo` as the same rule when checking for prior presence
  // — both forms anchor at gitignore root, so a consumer who wrote either
  // shouldn't get a duplicate appended.
  const normalize = (s: string) => s.replace(/^\//, '');

  if (!fs.existsSync(gitignorePath)) {
    const defaultEntries = ['node_modules/', 'dist/', '.env', '.env.*', ''];
    const content = '# Dependencies\n' + defaultEntries.join('\n') + '\n# MoFlo state\n' + entries.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf-8');
    return { name: '.gitignore', status: 'created', detail: 'Created with node_modules, .env, and MoFlo entries' };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const existingLines = new Set(
    existing.split(/\r?\n/).map(l => normalize(l.trim())).filter(l => l && !l.startsWith('#')),
  );
  const toAdd = entries.filter(e => !existingLines.has(normalize(e)));

  if (toAdd.length === 0) {
    return { name: '.gitignore', status: 'skipped', detail: 'Entries already present' };
  }

  const sep = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, sep + '\n# MoFlo state (gitignored)\n' + toAdd.join('\n') + '\n');
  return { name: '.gitignore', status: 'updated', detail: `Added: ${toAdd.join(', ')}` };
}

// ============================================================================
// Step 7: Sync ALL shipped guidance docs
// Discovers all .md files in moflo/.claude/guidance/shipped/ and copies them
// to project .claude/guidance/ (including moflo-subagents.md — see #939, prior
// versions renamed it to moflo-bootstrap.md, creating a structural duplicate).
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

  // Discover all shipped .md files dynamically — including moflo-subagents.md
  // (#939: prior versions renamed it to moflo-bootstrap.md as a separate step,
  // which left two copies of the same content on consumer disk).
  const files = fs.readdirSync(shippedDir).filter(f => f.endsWith('.md'));

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
