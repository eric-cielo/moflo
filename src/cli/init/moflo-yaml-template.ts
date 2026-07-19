/**
 * Canonical moflo.yaml renderer.
 *
 * Single source of truth shared by:
 *   - `flo init` (src/cli/init/moflo-init.ts § Step 1)
 *   - Session-start launcher self-heal (bin/session-start-launcher.mjs § 3d-yaml-create)
 *
 * The launcher path keeps consumers visible and tunable: when a project is
 * upgraded to a moflo with new defaults but has no moflo.yaml at all, the
 * sibling `bin/lib/yaml-upgrader.mjs` no-ops (it only appends to existing
 * files). Without this module, the user has no surface to see/edit defaults
 * after an `npm install moflo@*`. See issue #895.
 *
 * Companion: `bin/lib/yaml-upgrader.mjs` keeps EXISTING moflo.yaml files
 * forward-compatible by appending new top-level sections. This module
 * handles the MISSING case.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';

const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.reports',
  '.swarm', '.moflo', 'packages',
]);

const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.cs',
];

// Mirror of `MofloInitAnswers` (defined in moflo-init.ts) plus render-only
// inputs. Kept structural rather than `extends` to avoid a forward-import
// cycle: moflo-init.ts already imports from this file.
export interface MofloYamlConfig {
  projectName: string;
  detectedExts: string[];
  guidanceDirs: string[];
  srcDirs: string[];
  testDirs: string[];
  guidance: boolean;
  codeMap: boolean;
  tests: boolean;
  gates: boolean;
  stopHook: boolean;
}

/**
 * Top-level candidates for source directories. Same list `flo init` uses; the
 * walker also descends to find `src/` and `migrations/` up to 3 levels deep.
 */
const SRC_TOP_LEVEL = ['packages', 'lib', 'app', 'apps', 'services', 'server', 'client'];
const SRC_NAMES = new Set(['src', 'migrations']);

export function discoverGuidanceDirs(root: string): string[] {
  const TOP_LEVEL = ['.claude/guidance', 'docs/guides', 'docs', 'architecture', 'adr', '.cursor/rules'];
  const found = TOP_LEVEL.filter(d => fs.existsSync(path.join(root, d)));

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || WALK_SKIP_DIRS.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        const guidancePath = `${rel}/.claude/guidance`;
        if (fs.existsSync(path.join(root, guidancePath))) {
          try {
            const files = fs.readdirSync(path.join(root, guidancePath));
            if (files.some(f => f.endsWith('.md'))) found.push(guidancePath);
          } catch { /* skip unreadable */ }
        } else {
          walk(rel, depth + 1);
        }
      }
    } catch { /* skip unreadable */ }
  }

  walk('', 0);
  return found;
}

export function discoverTestDirs(root: string): string[] {
  const TOP_LEVEL = ['tests', 'test', '__tests__', 'spec', 'e2e'];
  const found = TOP_LEVEL.filter(d => fs.existsSync(path.join(root, d)));

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || WALK_SKIP_DIRS.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.name === '__tests__') found.push(rel);
        else walk(rel, depth + 1);
      }
    } catch { /* skip unreadable */ }
  }

  walk('', 0);
  return found;
}

export function discoverSrcDirs(root: string): string[] {
  const found: string[] = [];
  for (const d of SRC_TOP_LEVEL) {
    if (fs.existsSync(path.join(root, d))) found.push(d);
  }

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || WALK_SKIP_DIRS.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (SRC_NAMES.has(entry.name)) {
          try {
            const files = fs.readdirSync(path.join(root, rel));
            if (files.some(f => /\.(ts|tsx|js|jsx)$/.test(f))) found.push(rel);
          } catch { /* skip unreadable */ }
        } else {
          walk(rel, depth + 1);
        }
      }
    } catch { /* skip unreadable */ }
  }

  walk('', 0);
  return found;
}

function scanExtensions(dir: string, extensions: Set<string>, depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.slice(0, 100)) {
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
      scanExtensions(path.join(dir, entry.name), extensions, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTENSIONS.includes(ext)) extensions.add(ext);
    }
  }
}

export function detectExtensions(root: string, srcDirs: string[]): string[] {
  const extensions = new Set<string>();
  for (const dir of srcDirs) {
    const fullDir = path.join(root, dir);
    if (fs.existsSync(fullDir)) {
      try { scanExtensions(fullDir, extensions, 0, 3); } catch { /* skip */ }
    }
  }
  return extensions.size > 0 ? [...extensions].sort() : ['.ts', '.tsx', '.js', '.jsx'];
}

export function defaultMofloYamlConfig(root: string): MofloYamlConfig {
  const guidanceDirs = discoverGuidanceDirs(root);
  if (guidanceDirs.length === 0) guidanceDirs.push('.claude/guidance');

  const srcDirs = discoverSrcDirs(root);
  if (srcDirs.length === 0) srcDirs.push('src');

  const testDirs = discoverTestDirs(root);
  if (testDirs.length === 0) testDirs.push('tests');

  return {
    projectName: path.basename(root),
    guidanceDirs,
    srcDirs,
    testDirs,
    detectedExts: detectExtensions(root, srcDirs),
    guidance: true,
    codeMap: true,
    tests: true,
    gates: true,
    stopHook: true,
  };
}

export function renderMofloYaml(config: MofloYamlConfig): string {
  const { projectName, guidanceDirs, srcDirs, testDirs, detectedExts, guidance, codeMap, tests, gates, stopHook } = config;
  return `# MoFlo — Project Configuration
# Generated by: moflo init
# Docs: https://github.com/eric-cielo/moflo

project:
  name: "${projectName}"

# Guidance/knowledge docs to index for semantic search
guidance:
  directories:
${guidanceDirs.map(d => `    - ${d}`).join('\n')}
  namespace: guidance

# Source directories for code navigation map
code_map:
  directories:
${srcDirs.map(d => `    - ${d}`).join('\n')}
  extensions: [${detectedExts.map(e => `"${e}"`).join(', ')}]
  exclude: [node_modules, dist, .next, coverage, build, __pycache__, target, .git]
  namespace: code-map

# Test file discovery and indexing
tests:
  directories:
${testDirs.map(d => `    - ${d}`).join('\n')}
  patterns: ["*.test.*", "*.spec.*", "*.test-*"]
  extensions: [".ts", ".tsx", ".js", ".jsx"]
  exclude: [node_modules, coverage, dist]
  namespace: tests

# Spell gates (enforced via Claude Code hooks)
gates:
  memory_first: ${gates}
  task_create_first: ${gates}
  context_tracking: ${gates}
  verify_before_done: false   # Epic #1269: require /verify before 'gh pr create' (opt-in; independent of the toggle above)

# Auto-index on session start
auto_index:
  guidance: ${guidance}
  code_map: ${codeMap}
  tests: ${tests}

# Passive session-continuity — pick up where you left off across sessions.
# capture: silently record a compact "where you left off" digest at turn-end.
# inject:  surface the single most-relevant recent digest at session-start
#          (relevance-gated by branch / changed files / recency, so an unrelated
#          session shows nothing). Add "<private>" to a message to skip capturing
#          that session. Set either to false to opt out.
session_continuity:
  capture: true
  inject: true
  max_age_hours: 72            # ignore digests older than this when injecting

# Auto-meditate (#1198) — the automatic counterpart to /meditate. When enabled,
# moflo recognizes durable lessons in the LIVE session (a tiny answer-first note
# on course-corrections / errors / decisions) and distills them into long-term
# memory at the next session-start via a cheap headless Haiku pass — deduped.
# Ships ON; set false to opt out.
auto_meditate:
  enabled: true

# Spec-Driven Development (Epic #1269) — spec -> plan -> implement -> verify.
# When default is true, every /flo run uses the SDD cycle unless --no-sdd.
sdd:
  default: false

# Auto-merge the PR at the end of a full /flo run once preconditions are met (#1285).
# When auto is true, a full /flo run awaits required checks + MERGEABLE state then
# merges and deletes the branch, instead of stopping at "PR opened". Opt-in;
# override per-run with --merge / --no-merge.
merge:
  auto: false

# Memory backend
memory:
  backend: node-sqlite
  embedding_model: Xenova/all-MiniLM-L6-v2
  namespace: default

# Hook toggles (all on by default — disable to slim down)
hooks:
  pre_edit: true               # Track file edits for learning
  post_edit: true              # Record edit outcomes, train neural patterns
  pre_task: true               # Get agent routing before task spawn
  post_task: true              # Record task results for learning
  gate: ${gates}                   # Spell gate enforcement (memory-first, task-create-first)
  route: true                  # Intelligent task routing on each prompt
  stop_hook: ${stopHook}              # Session-end persistence and metric export
  session_restore: true        # Restore session state on start
  notification: true           # Hook into Claude Code notifications

# MCP server options
mcp:
  tool_defer: deferred           # Defer 150+ tool schemas; loaded on demand via ToolSearch
  auto_start: false              # Auto-start MCP server on session begin

# Spell step sandboxing (OS-level process isolation for bash steps)
# Platform support: macOS (sandbox-exec), Linux/WSL (bwrap). Windows has no OS sandbox.
# Tiers:
#   auto          — Use best available sandbox for this platform (recommended when enabled)
#   denylist-only — Layer 1 only: block catastrophic commands, no OS isolation
#   full          — Require full OS isolation; throws if the sandbox tool is unavailable
sandbox:
  enabled: false                 # Set to true to wrap bash steps in an OS sandbox
  tier: auto                     # auto | denylist-only | full

# Status line display (shown at bottom of Claude Code)
# mode: "compact" (default), "single-line", or "dashboard" (full multi-line)
status_line:
  enabled: true
  mode: compact
  branding: "MoFlo V4"
  show_git: true
  show_session: true
  show_swarm: true
  show_mcp: true

# Model preferences (haiku, sonnet, opus)
# These are static fallbacks. When model_routing.enabled is true (default),
# the dynamic router takes precedence based on task complexity.
models:
  default: opus        # Model for general tasks (kept high for unknowns)
  research: sonnet     # Model for research/exploration agents
  review: sonnet       # Code review never needs opus reasoning
  test: sonnet         # Model for test-writing agents

# Intelligent model routing (auto-selects haiku/sonnet/opus per task)
# When enabled, overrides the static model preferences above
# by analyzing task complexity and routing to the cheapest capable model.
model_routing:
  enabled: true                    # Set to false to pin to the static models above
  confidence_threshold: 0.85       # Min confidence before escalating to a more capable model
  cost_optimization: true          # Prefer cheaper models when confidence is high
  circuit_breaker: true            # Penalize models that fail repeatedly
  # Per-agent overrides (set to "inherit" to use routing, or a specific model to pin)
  # agent_overrides:
  #   security-architect: opus     # Always use opus for security
  #   researcher: sonnet           # Pin research to sonnet
`;
}

export interface EnsureResult {
  created: boolean;
  path: string;
  detail?: string;
}

export function ensureMofloYamlExists(root: string): EnsureResult {
  const configPath = path.join(root, 'moflo.yaml');
  if (fs.existsSync(configPath)) {
    return { created: false, path: configPath };
  }

  const config = defaultMofloYamlConfig(root);
  // atomicWriteFileSync writes a tmp sidecar then renames — concurrent
  // SessionStart launchers race to last-writer-wins. We layer a "never
  // overwrite" invariant on top: re-check existence right before the
  // rename so the loser of the race observes the winner's file and skips.
  if (fs.existsSync(configPath)) {
    return { created: false, path: configPath };
  }
  atomicWriteFileSync(configPath, renderMofloYaml(config));

  return {
    created: true,
    path: configPath,
    detail: `${config.srcDirs.join(', ')} | ${config.detectedExts.join(', ')}`,
  };
}

/**
 * Top-level sections every shipped moflo.yaml must define. Mirrors the keys
 * `renderMofloYaml` emits — kept in sync via the test
 * `init-moflo-yaml-template.test.ts § renderMofloYaml`.
 */
export const REQUIRED_TOP_LEVEL_SECTIONS = [
  'project',
  'guidance',
  'code_map',
  'tests',
  'gates',
  'auto_index',
  'session_continuity',
  'auto_meditate',
  'sdd',
  'merge',
  'memory',
  'hooks',
  'mcp',
  'sandbox',
  'status_line',
  'models',
  'model_routing',
] as const;

// Precompiled at module load — validateMofloYaml can run from doctor probes
// or session-start hot paths, neither of which should rebuild N regexes per call.
const SECTION_REGEXES: ReadonlyArray<[string, RegExp]> = REQUIRED_TOP_LEVEL_SECTIONS.map(
  (section) => [section, new RegExp(`^${section}\\s*:`, 'm')] as const,
);

export interface YamlValidationIssue {
  kind: 'missing-section' | 'parse-error' | 'unreadable' | 'empty';
  detail: string;
}

export interface YamlValidationResult {
  exists: boolean;
  valid: boolean;
  issues: YamlValidationIssue[];
  missingSections: string[];
}

/**
 * Lightweight compliance check for a moflo.yaml on disk. Avoids pulling a
 * full YAML parser dependency — matches the regex-based approach already
 * used by `doctor.ts § checkTestDirs` and `bin/lib/yaml-upgrader.mjs`.
 * Never throws — the doctor probe and session-start self-heal both expect
 * a verdict even when the file is corrupt.
 */
export function validateMofloYaml(yamlPath: string): YamlValidationResult {
  const result: YamlValidationResult = {
    exists: false,
    valid: false,
    issues: [],
    missingSections: [],
  };

  if (!fs.existsSync(yamlPath)) {
    result.issues.push({ kind: 'parse-error', detail: 'moflo.yaml does not exist' });
    return result;
  }
  result.exists = true;

  let content: string;
  try {
    content = fs.readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    result.issues.push({ kind: 'unreadable', detail: (err as Error).message ?? String(err) });
    return result;
  }

  if (content.trim().length === 0) {
    result.issues.push({ kind: 'empty', detail: 'file is empty' });
    return result;
  }

  for (const [section, re] of SECTION_REGEXES) {
    if (!re.test(content)) result.missingSections.push(section);
  }
  if (result.missingSections.length > 0) {
    result.issues.push({
      kind: 'missing-section',
      detail: `missing top-level sections: ${result.missingSections.join(', ')}`,
    });
  }

  result.valid = result.issues.length === 0;
  return result;
}
