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
import { fileURLToPath } from 'url';

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
 * Discover guidance directories by checking top-level candidates AND walking
 * the project tree for subproject .claude/guidance dirs (monorepo support).
 */
function discoverGuidanceDirs(root: string): string[] {
  const TOP_LEVEL = ['.claude/guidance', 'docs/guides', 'docs', 'architecture', 'adr', '.cursor/rules'];
  const found = TOP_LEVEL.filter(d => fs.existsSync(path.join(root, d)));

  // Walk up to 3 levels deep looking for .claude/guidance in subprojects
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.reports', '.swarm', '.claude-flow', 'packages']);

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        const guidancePath = `${rel}/.claude/guidance`;
        if (fs.existsSync(path.join(root, guidancePath))) {
          // Verify it has .md files
          try {
            const files = fs.readdirSync(path.join(root, guidancePath));
            if (files.some(f => f.endsWith('.md'))) found.push(guidancePath);
          } catch { /* skip unreadable */ }
        } else {
          walk(rel, depth + 1);
        }
      }
    } catch { /* skip unreadable directories */ }
  }

  walk('', 0);
  return found;
}

/**
 * Discover test directories by checking common locations and walking for
 * colocated __tests__ dirs. Returns relative paths.
 */
export function discoverTestDirs(root: string): string[] {
  const TOP_LEVEL = ['tests', 'test', '__tests__', 'spec', 'e2e'];
  const found = TOP_LEVEL.filter(d => fs.existsSync(path.join(root, d)));

  // Walk up to 3 levels deep looking for __tests__ dirs inside src
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.reports', '.swarm', '.claude-flow']);

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.name === '__tests__') {
          found.push(rel);
        } else {
          walk(rel, depth + 1);
        }
      }
    } catch { /* skip unreadable directories */ }
  }

  walk('', 0);
  return found;
}

/**
 * Discover source directories by walking the project tree.
 * Finds directories named 'src' (or top-level 'packages', 'lib', etc.)
 * that contain .ts/.tsx/.js/.jsx files. Skips node_modules, dist, etc.
 */
function discoverSrcDirs(root: string): string[] {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.reports', '.swarm', '.claude-flow']);
  // Top-level candidates that are always source roots if they exist
  const TOP_LEVEL = ['packages', 'lib', 'app', 'apps', 'services', 'server', 'client'];
  const found: string[] = [];

  // Add top-level candidates first
  for (const d of TOP_LEVEL) {
    if (fs.existsSync(path.join(root, d))) found.push(d);
  }

  // Walk up to 3 levels deep looking for 'src' and 'migrations' directories
  const SRC_NAMES = new Set(['src', 'migrations']);
  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (SRC_NAMES.has(entry.name)) {
          // Check it actually has source files
          try {
            const files = fs.readdirSync(path.join(root, rel));
            const hasSource = files.some(f => /\.(ts|tsx|js|jsx)$/.test(f));
            if (hasSource) found.push(rel);
          } catch { /* skip unreadable */ }
        } else {
          walk(rel, depth + 1);
        }
      }
    } catch { /* skip unreadable directories */ }
  }

  walk('', 0);

  // Deduplicate: if 'packages' is found, don't also include 'packages/foo/src'
  // since the code-map walker handles subdirs
  return found.filter(d => {
    return !found.some(other => other !== d && d.startsWith(other + '/'));
  });
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
    message: 'Enable workflow gates (memory-first, task-create-before-agents)?',
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

  const projectName = path.basename(root);
  const guidanceDirs = answers?.guidanceDirs ?? ['.claude/guidance'];
  const srcDirs = answers?.srcDirs ?? ['src'];
  const testDirs = answers?.testDirs ?? ['tests'];
  const gatesEnabled = answers?.gates ?? true;

  // Detect languages
  const extensions = new Set<string>();
  for (const dir of srcDirs) {
    const fullDir = path.join(root, dir);
    if (fs.existsSync(fullDir)) {
      try {
        scanExtensions(fullDir, extensions, 0, 3);
      } catch { /* skip */ }
    }
  }
  const detectedExts = extensions.size > 0
    ? [...extensions].sort()
    : ['.ts', '.tsx', '.js', '.jsx'];

  const yaml = `# MoFlo — Project Configuration
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

# Workflow gates (enforced via Claude Code hooks)
gates:
  memory_first: ${gatesEnabled}
  task_create_first: ${gatesEnabled}
  context_tracking: ${gatesEnabled}

# Auto-index on session start
auto_index:
  guidance: ${answers?.guidance ?? true}
  code_map: ${answers?.codeMap ?? true}
  tests: ${answers?.tests ?? true}

# Memory backend
memory:
  backend: sql.js
  embedding_model: Xenova/all-MiniLM-L6-v2
  namespace: default

# Hook toggles (all on by default — disable to slim down)
hooks:
  pre_edit: true               # Track file edits for learning
  post_edit: true              # Record edit outcomes, train neural patterns
  pre_task: true               # Get agent routing before task spawn
  post_task: true              # Record task results for learning
  gate: ${gatesEnabled}                   # Workflow gate enforcement (memory-first, task-create-first)
  route: true                  # Intelligent task routing on each prompt
  stop_hook: ${answers?.stopHook ?? true}              # Session-end persistence and metric export
  session_restore: true        # Restore session state on start
  notification: true           # Hook into Claude Code notifications

# MCP server options
mcp:
  tool_defer: deferred           # Defer 150+ tool schemas; loaded on demand via ToolSearch
  auto_start: false              # Auto-start MCP server on session begin

# Status line display (shown at bottom of Claude Code)
# mode: "compact" (default), "single-line", or "dashboard" (full multi-line)
status_line:
  enabled: true
  mode: compact
  branding: "MoFlo V4"
  show_git: true
  show_session: true
  show_swarm: true
  show_agentdb: true
  show_mcp: true

# Model preferences (haiku, sonnet, opus)
models:
  default: opus        # Model for general tasks
  research: sonnet     # Model for research/exploration agents
  review: opus         # Model for code review agents
  test: sonnet         # Model for test-writing agents

# Intelligent model routing (auto-selects haiku/sonnet/opus per task)
# When enabled, overrides the static model preferences above
# by analyzing task complexity and routing to the cheapest capable model.
model_routing:
  enabled: false                   # Set to true to enable dynamic routing
  confidence_threshold: 0.85       # Min confidence before escalating to a more capable model
  cost_optimization: true          # Prefer cheaper models when confidence is high
  circuit_breaker: true            # Penalize models that fail repeatedly
  # Per-agent overrides (set to "inherit" to use routing, or a specific model to pin)
  # agent_overrides:
  #   security-architect: opus     # Always use opus for security
  #   researcher: sonnet           # Pin research to sonnet
`;

  fs.writeFileSync(configPath, yaml, 'utf-8');
  return { name: 'moflo.yaml', status: 'created', detail: `Detected: ${srcDirs.join(', ')} | ${detectedExts.join(', ')}` };
}

function scanExtensions(dir: string, extensions: Set<string>, depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.slice(0, 100)) {
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
      scanExtensions(path.join(dir, entry.name), extensions, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.cs'].includes(ext)) {
        extensions.add(ext);
      }
    }
  }
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
        "hooks": [{ "type": "command", "command": gateHook('check-dangerous-command'), "timeout": 2000 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{ "type": "command", "command": handler('post-edit'), "timeout": 5000 }]
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
        "hooks": [{ "type": "command", "command": gateHook('check-bash-memory'), "timeout": 2000 }]
      },
      {
        "matcher": "mcp__moflo__memory_",
        "hooks": [{ "type": "command", "command": gate('record-memory-searched'), "timeout": 3000 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": `node "$CLAUDE_PROJECT_DIR/.claude/helpers/prompt-hook.mjs"`, "timeout": 3000 }
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

  // Resolve this file's directory in ESM-safe way
  let thisDir: string;
  try {
    thisDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Fallback for CJS or environments where import.meta.url is unavailable
    thisDir = typeof __dirname !== 'undefined' ? __dirname : '';
  }

  const staticSkillCandidates = [
    // Installed via npm (most common)
    path.join(root, 'node_modules', 'moflo', '.claude', 'skills', 'flo', 'SKILL.md'),
    // Running from moflo repo itself (dev)
    ...(thisDir ? [path.join(thisDir, '..', '..', '..', '..', '.claude', 'skills', 'flo', 'SKILL.md')] : []),
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

// Markers for idempotent CLAUDE.md injection — keep in sync with claudemd-generator.ts
const MOFLO_MARKER = '<!-- MOFLO:INJECTED:START -->';
const MOFLO_MARKER_END = '<!-- MOFLO:INJECTED:END -->';
// Also detect legacy markers so we can replace them
const LEGACY_MARKERS = ['<!-- MOFLO:START -->', '<!-- MOFLO:SUBAGENT-PROTOCOL:START -->'];
const LEGACY_MARKERS_END = ['<!-- MOFLO:END -->', '<!-- MOFLO:SUBAGENT-PROTOCOL:END -->'];

function generateClaudeMd(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  let existing = '';

  if (fs.existsSync(claudeMdPath)) {
    existing = fs.readFileSync(claudeMdPath, 'utf-8');

    // Check for current or legacy markers
    const allStartMarkers = [MOFLO_MARKER, ...LEGACY_MARKERS];
    const allEndMarkers = [MOFLO_MARKER_END, ...LEGACY_MARKERS_END];

    for (let i = 0; i < allStartMarkers.length; i++) {
      if (existing.includes(allStartMarkers[i])) {
        // Always strip the existing section so we can re-inject the latest version.
        // This ensures CLAUDE.md stays current when moflo updates its injected content.
        const startIdx = existing.indexOf(allStartMarkers[i]);
        const endIdx = existing.indexOf(allEndMarkers[i]);
        if (endIdx > startIdx) {
          existing = existing.substring(0, startIdx) + existing.substring(endIdx + allEndMarkers[i].length);
        }
      }
    }
  }

  // Minimal injection — just enough for Claude to work with moflo.
  // All detailed docs live in .claude/guidance/shipped/moflo-core-guidance.md.
  const mofloSection = `
${MOFLO_MARKER}
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development workflows.

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call for every new user prompt MUST be a memory search. Do this BEFORE Glob, Grep, Read, or any file exploration.

\`\`\`
mcp__moflo__memory_search — query: "<task description>", namespace: "guidance" or "patterns" or "code-map"
\`\`\`

Search \`guidance\` and \`patterns\` namespaces on every prompt. Search \`code-map\` when navigating the codebase.
When the user asks you to remember something: \`mcp__moflo__memory_store\` with namespace \`knowledge\`.

### Workflow Gates (enforced automatically)

- **Memory-first**: Must search memory before Glob/Grep/Read
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool
- **Task Icons**: \`TaskCreate\` MUST use ICON+[Role] format — see \`.claude/guidance/moflo-task-icons.md\`

### MCP Tools (preferred over CLI)

| Tool | Purpose |
|------|---------|
| \`mcp__moflo__memory_search\` | Semantic search across indexed knowledge |
| \`mcp__moflo__memory_store\` | Store patterns and decisions |
| \`mcp__moflo__hooks_route\` | Route task to optimal agent type |
| \`mcp__moflo__hooks_pre-task\` | Record task start |
| \`mcp__moflo__hooks_post-task\` | Record task completion for learning |

### CLI Fallback

\`\`\`bash
flo-search "[query]" --namespace guidance   # Semantic search
flo doctor --fix                             # Health check
\`\`\`

### Full Reference

For CLI commands, hooks, agents, swarm config, memory commands, and moflo.yaml options, see:
\`.claude/guidance/shipped/moflo-core-guidance.md\`
${MOFLO_MARKER_END}
`;

  const finalContent = existing.trimEnd() + '\n' + mofloSection;
  fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');

  return {
    name: 'CLAUDE.md',
    status: existing ? 'updated' : 'created',
    detail: 'MoFlo section injected (~35 lines)',
  };
}

// ============================================================================
// Step 5: .claude/scripts/ — sync from moflo bin/
// These scripts are used by session-start hooks for indexing, code map, etc.
// Always overwrite to keep them in sync with the installed moflo version.
// ============================================================================

const SCRIPT_MAP: Record<string, string> = {
  'hooks.mjs': 'hooks.mjs',
  'session-start-launcher.mjs': 'session-start-launcher.mjs',
  'index-guidance.mjs': 'index-guidance.mjs',
  'build-embeddings.mjs': 'build-embeddings.mjs',
  'generate-code-map.mjs': 'generate-code-map.mjs',
  'semantic-search.mjs': 'semantic-search.mjs',
  'index-tests.mjs': 'index-tests.mjs',
};

function syncScripts(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const scriptsDir = path.join(root, '.claude', 'scripts');
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }

  // Find moflo bin/ directory
  let syncThisDir: string;
  try {
    syncThisDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    syncThisDir = typeof __dirname !== 'undefined' ? __dirname : '';
  }

  const candidates = [
    path.join(root, 'node_modules', 'moflo', 'bin'),
    // When running from moflo repo itself
    ...(syncThisDir ? [path.join(syncThisDir, '..', '..', '..', '..', 'bin')] : []),
  ];
  const binDir = candidates.find(d => { try { return fs.existsSync(d); } catch { return false; } });

  if (!binDir) {
    return { name: '.claude/scripts/', status: 'skipped', detail: 'moflo bin/ not found' };
  }

  let copied = 0;
  for (const [dest, src] of Object.entries(SCRIPT_MAP)) {
    const srcPath = path.join(binDir, src);
    const destPath = path.join(scriptsDir, dest);

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
  const entries = ['.claude-epic/', '.swarm/', '.moflo/'];

  if (!fs.existsSync(gitignorePath)) {
    // Create .gitignore with common defaults + MoFlo entries
    const defaultEntries = ['node_modules/', 'dist/', '.env', '.env.*', ''];
    const content = '# Dependencies\n' + defaultEntries.join('\n') + '\n# MoFlo state\n' + entries.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf-8');
    return { name: '.gitignore', status: 'created', detail: 'Created with node_modules, .env, and MoFlo entries' };
  }

  const existing = fs.readFileSync(gitignorePath, 'utf-8');
  const toAdd = entries.filter(e => !existing.includes(e));

  if (toAdd.length === 0) {
    return { name: '.gitignore', status: 'skipped', detail: 'Entries already present' };
  }

  fs.appendFileSync(gitignorePath, '\n# MoFlo state (gitignored)\n' + toAdd.join('\n') + '\n');
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

  // Find the source bootstrap file from the moflo package
  let sourceDir: string;
  try {
    sourceDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    sourceDir = typeof __dirname !== 'undefined' ? __dirname : '';
  }

  const candidates = [
    path.join(root, 'node_modules', 'moflo', '.claude', 'guidance', 'shipped', 'moflo-subagents.md'),
    // When running from moflo repo itself
    ...(sourceDir ? [path.join(sourceDir, '..', '..', '..', '..', '.claude', 'guidance', 'shipped', 'moflo-subagents.md')] : []),
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

  let sourceDir: string;
  try {
    sourceDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    sourceDir = typeof __dirname !== 'undefined' ? __dirname : '';
  }

  // Find the shipped guidance directory
  const shippedCandidates = [
    path.join(root, 'node_modules', 'moflo', '.claude', 'guidance', 'shipped'),
    ...(sourceDir ? [path.join(sourceDir, '..', '..', '..', '..', '.claude', 'guidance', 'shipped')] : []),
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
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'global flo shim', status: 'error', detail: msg };
  }
}
