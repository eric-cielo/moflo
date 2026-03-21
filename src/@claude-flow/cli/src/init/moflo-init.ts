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

  const gates = await confirm({
    message: 'Enable workflow gates (memory-first, task-create-before-agents)?',
    default: true,
  });

  const stopHook = await confirm({
    message: 'Enable session-end hook (saves session state)?',
    default: true,
  });

  return { guidance, guidanceDirs, codeMap, srcDirs, gates, stopHook };
}

/**
 * Get default answers (--yes mode).
 */
function defaultAnswers(root: string): MofloInitAnswers {
  const guidanceDirs = discoverGuidanceDirs(root);
  if (guidanceDirs.length === 0) guidanceDirs.push('.claude/guidance');

  const srcDirs = discoverSrcDirs(root);
  if (srcDirs.length === 0) srcDirs.push('src');

  return { guidance: true, guidanceDirs, codeMap: true, srcDirs, gates: true, stopHook: true };
}

/**
 * Get minimal answers (--minimal mode).
 */
function minimalAnswers(): MofloInitAnswers {
  return { guidance: false, guidanceDirs: [], codeMap: false, srcDirs: [], gates: false, stopHook: false };
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

# Workflow gates (enforced via Claude Code hooks)
gates:
  memory_first: ${gatesEnabled}
  task_create_first: ${gatesEnabled}
  context_tracking: ${gatesEnabled}

# Auto-index on session start
auto_index:
  guidance: ${answers?.guidance ?? true}
  code_map: ${answers?.codeMap ?? true}

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
  const hooks: Record<string, any[]> = {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks pre-edit",
          "timeout": 5000
        }]
      },
      {
        "matcher": "^(Glob|Grep)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-before-scan",
          "timeout": 3000
        }]
      },
      {
        "matcher": "^Read$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-before-read",
          "timeout": 3000
        }]
      },
      {
        "matcher": "^Task$",
        "hooks": [
          {
            "type": "command",
            "command": "npx flo gate check-before-agent",
            "timeout": 3000
          },
          {
            "type": "command",
            "command": "npx flo hooks pre-task",
            "timeout": 5000
          }
        ]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-dangerous-command",
          "timeout": 2000
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks post-edit",
          "timeout": 5000
        }]
      },
      {
        "matcher": "^Task$",
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks post-task",
          "timeout": 5000
        }]
      },
      {
        "matcher": "^TaskCreate$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate record-task-created",
          "timeout": 2000
        }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate check-bash-memory",
          "timeout": 2000
        }]
      },
      {
        "matcher": "^mcp__claude-flow__memory_(search|retrieve)$",
        "hooks": [{
          "type": "command",
          "command": "npx flo gate record-memory-searched",
          "timeout": 2000
        }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx flo gate prompt-reminder",
            "timeout": 2000
          },
          {
            "type": "command",
            "command": "npx flo hooks route",
            "timeout": 5000
          }
        ]
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
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks session-end",
          "timeout": 5000
        }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{
          "type": "command",
          "command": "npx flo gate compact-guidance",
          "timeout": 3000
        }]
      }
    ],
    "Notification": [
      {
        "hooks": [{
          "type": "command",
          "command": "npx flo hooks notification",
          "timeout": 3000
        }]
      }
    ]
  };

  // Merge: preserve existing non-MoFlo hooks, add MoFlo hooks
  existing.hooks = hooks;

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

const MOFLO_MARKER = '<!-- MOFLO:START -->';
const MOFLO_MARKER_END = '<!-- MOFLO:END -->';

function generateClaudeMd(root: string, force?: boolean): MofloInitResult['steps'][0] {
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  let existing = '';

  if (fs.existsSync(claudeMdPath)) {
    existing = fs.readFileSync(claudeMdPath, 'utf-8');

    // Check if MoFlo section already exists
    if (existing.includes(MOFLO_MARKER)) {
      if (!force) {
        return { name: 'CLAUDE.md', status: 'skipped', detail: 'MoFlo section already present' };
      }
      // Remove existing MoFlo section for replacement
      const startIdx = existing.indexOf(MOFLO_MARKER);
      const endIdx = existing.indexOf(MOFLO_MARKER_END);
      if (endIdx > startIdx) {
        existing = existing.substring(0, startIdx) + existing.substring(endIdx + MOFLO_MARKER_END.length);
      }
    }
  }

  const mofloSection = `
${MOFLO_MARKER}
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development workflows.

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call for every new user prompt MUST be a memory search. Do this BEFORE Glob, Grep, Read, or any file exploration.

\`\`\`
mcp__claude-flow__memory_search  — query: "<task description>", namespace: "guidance" or "patterns" or "knowledge" or "code-map"
\`\`\`

For codebase navigation, search the \`code-map\` namespace first. For patterns and domain knowledge, search \`patterns\`, \`knowledge\`, and \`guidance\`.
When the user asks you to remember something, store it: \`memory store --namespace knowledge --key "[topic]" --value "[what to remember]"\`

### Workflow Gates (enforced automatically)

These are enforced by hooks — you cannot bypass them:
- **Memory-first**: Must search memory before Glob/Grep/Read on guidance files
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool
- **Context tracking**: Session tracked as FRESH → MODERATE → DEPLETED → CRITICAL

### /flo Skill — Issue Execution

Use \`/flo <issue-number>\` (or \`/fl\`) to execute GitHub issues through the full workflow:
Research → Enhance → Implement → Test → Simplify → PR

### MCP Tools Reference

| Tool | Purpose |
|------|---------|
| \`mcp__claude-flow__memory_search\` | Semantic search across indexed knowledge |
| \`mcp__claude-flow__memory_store\` | Store patterns and decisions |
| \`mcp__claude-flow__hooks_route\` | Route task to optimal agent type |
| \`mcp__claude-flow__hooks_pre-task\` | Record task start |
| \`mcp__claude-flow__hooks_post-task\` | Record task completion for learning |

### Agent Icon Mapping

| Icon | Agent Type | Use For |
|------|------------|---------|
| 🔍 | Explore | Research, codebase exploration |
| 📐 | Plan | Architecture, design |
| ⚙️ | General | General coding tasks |
| 🧪 | Test | Writing tests |
| 🔬 | Analyzer | Code review, analysis |
| 🔧 | Backend | API implementation |

### Non-Trivial Task Workflow

For any task beyond a single-line fix:
1. Search memory first (mandatory gate)
2. Create tasks with TaskCreate (mandatory gate)
3. Spawn agents in waves (Explore first, then Implement + Test)
4. Update task status as you go
5. Store learnings after completion
${MOFLO_MARKER_END}
`;

  const finalContent = existing.trimEnd() + '\n' + mofloSection;
  fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');

  return {
    name: 'CLAUDE.md',
    status: existing ? 'updated' : 'created',
    detail: 'MoFlo workflow section appended',
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
  const entries = ['.claude-orc/', '.swarm/', '.moflo/'];

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
    path.join(root, 'node_modules', 'moflo', '.claude', 'guidance', 'agent-bootstrap.md'),
    // When running from moflo repo itself
    ...(sourceDir ? [path.join(sourceDir, '..', '..', '..', '..', '.claude', 'guidance', 'agent-bootstrap.md')] : []),
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
  const header = `<!-- AUTO-GENERATED by moflo init. Do not edit — changes will be overwritten on next init. -->\n<!-- Source: moflo/.claude/guidance/agent-bootstrap.md -->\n<!-- To customize, create .claude/guidance/agent-bootstrap.md for project-specific rules. -->\n\n`;

  fs.mkdirSync(guidanceDir, { recursive: true });
  fs.writeFileSync(targetFile, header + content, 'utf-8');

  return {
    name: 'guidance/moflo-bootstrap.md',
    status: fs.existsSync(targetFile) ? 'updated' : 'created',
    detail: 'Subagent bootstrap protocol'
  };
}
