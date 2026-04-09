/**
 * MoFlo Project Configuration
 * Reads moflo.yaml from the project root to configure indexing, gates, and behavior.
 */
import * as fs from 'fs';
import * as path from 'path';
let yaml: any;
try {
  yaml = await import('js-yaml');
  if (yaml.default) yaml = yaml.default;
} catch {
  // js-yaml not installed — YAML config files will fall back to JSON parsing
  yaml = null;
}

// ============================================================================
// Types
// ============================================================================

export interface MofloConfig {
  project: {
    name: string;
  };

  guidance: {
    directories: string[];
    namespace: string;
  };

  code_map: {
    directories: string[];
    extensions: string[];
    exclude: string[];
    namespace: string;
  };

  gates: {
    memory_first: boolean;
    task_create_first: boolean;
    context_tracking: boolean;
  };

  auto_index: {
    guidance: boolean;
    code_map: boolean;
  };

  memory: {
    backend: 'sql.js' | 'agentdb' | 'json';
    embedding_model: string;
    namespace: string;
  };

  hooks: {
    pre_edit: boolean;
    post_edit: boolean;
    pre_task: boolean;
    post_task: boolean;
    gate: boolean;
    route: boolean;
    stop_hook: boolean;
    session_restore: boolean;
    notification: boolean;
  };

  models: {
    default: string;
    research: string;
    review: string;
    test: string;
  };

  model_routing: {
    enabled: boolean;
    confidence_threshold: number;
    cost_optimization: boolean;
    circuit_breaker: boolean;
    agent_overrides: Record<string, string>;
  };

  daemon: {
    auto_start: boolean;
  };

  auto_update: {
    enabled: boolean;
    scripts: boolean;
    helpers: boolean;
  };

  epic: {
    admin_merge: boolean;
    default_strategy: 'single-branch' | 'auto-merge';
  };

  status_line: {
    enabled: boolean;
    branding: string;
    show_git: boolean;
    show_model: boolean;
    show_session: boolean;
    show_intelligence: boolean;
    show_swarm: boolean;
    show_hooks: boolean;
    show_mcp: boolean;
    show_security: boolean;
    show_adrs: boolean;
    show_agentdb: boolean;
    show_tests: boolean;
    mode: 'single-line' | 'dashboard';
  };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: MofloConfig = {
  project: {
    name: '',
  },
  guidance: {
    directories: ['.claude/guidance', 'docs/guides'],
    namespace: 'guidance',
  },
  code_map: {
    directories: ['src', 'packages', 'lib', 'app'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'],
    exclude: ['node_modules', 'dist', '.next', 'coverage', 'build', '__pycache__', 'target', '.git'],
    namespace: 'code-map',
  },
  gates: {
    memory_first: true,
    task_create_first: true,
    context_tracking: true,
  },
  auto_index: {
    guidance: true,
    code_map: true,
  },
  memory: {
    backend: 'sql.js',
    embedding_model: 'Xenova/all-MiniLM-L6-v2',
    namespace: 'default',
  },
  hooks: {
    pre_edit: true,
    post_edit: true,
    pre_task: true,
    post_task: true,
    gate: true,
    route: true,
    stop_hook: true,
    session_restore: true,
    notification: true,
  },
  models: {
    default: 'opus',
    research: 'sonnet',
    review: 'opus',
    test: 'sonnet',
  },
  model_routing: {
    enabled: false,
    confidence_threshold: 0.85,
    cost_optimization: true,
    circuit_breaker: true,
    agent_overrides: {},
  },
  daemon: {
    auto_start: true,
  },
  auto_update: {
    enabled: true,
    scripts: true,
    helpers: true,
  },
  epic: {
    admin_merge: true,
    default_strategy: 'single-branch',
  },
  status_line: {
    enabled: true,
    branding: 'Moflo V4',
    show_git: true,
    show_model: true,
    show_session: true,
    show_intelligence: true,
    show_swarm: true,
    show_hooks: true,
    show_mcp: true,
    show_security: true,
    show_adrs: true,
    show_agentdb: true,
    show_tests: true,
    mode: 'single-line',
  },
};

// ============================================================================
// Loader
// ============================================================================

const CONFIG_FILES = ['moflo.yaml', 'moflo.config.json'] as const;

/**
 * Find and load config file from project root.
 * Tries moflo.yaml first, then moflo.config.json.
 */
function findConfigFile(root: string): { path: string; format: 'yaml' | 'json' } | null {
  for (const filename of CONFIG_FILES) {
    const configPath = path.join(root, filename);
    if (fs.existsSync(configPath)) {
      return { path: configPath, format: filename.endsWith('.json') ? 'json' : 'yaml' };
    }
  }
  return null;
}

/**
 * Parse raw config object into typed config, merging with defaults.
 */
function mergeConfig(raw: Record<string, any>, root: string): MofloConfig {
  return {
    project: {
      name: raw.project?.name || path.basename(root),
    },
    guidance: {
      directories: raw.guidance?.directories || DEFAULT_CONFIG.guidance.directories,
      namespace: raw.guidance?.namespace || DEFAULT_CONFIG.guidance.namespace,
    },
    code_map: {
      directories: raw.code_map?.directories || raw.codeMap?.directories || DEFAULT_CONFIG.code_map.directories,
      extensions: raw.code_map?.extensions || raw.codeMap?.extensions || DEFAULT_CONFIG.code_map.extensions,
      exclude: raw.code_map?.exclude || raw.codeMap?.exclude || DEFAULT_CONFIG.code_map.exclude,
      namespace: raw.code_map?.namespace || raw.codeMap?.namespace || DEFAULT_CONFIG.code_map.namespace,
    },
    gates: {
      memory_first: raw.gates?.memory_first ?? DEFAULT_CONFIG.gates.memory_first,
      task_create_first: raw.gates?.task_create_first ?? DEFAULT_CONFIG.gates.task_create_first,
      context_tracking: raw.gates?.context_tracking ?? DEFAULT_CONFIG.gates.context_tracking,
    },
    auto_index: {
      guidance: raw.auto_index?.guidance ?? raw.autoIndex?.guidance ?? DEFAULT_CONFIG.auto_index.guidance,
      code_map: raw.auto_index?.code_map ?? raw.autoIndex?.code_map ?? DEFAULT_CONFIG.auto_index.code_map,
    },
    memory: {
      backend: raw.memory?.backend || DEFAULT_CONFIG.memory.backend,
      embedding_model: raw.memory?.embedding_model || raw.memory?.embeddingModel || DEFAULT_CONFIG.memory.embedding_model,
      namespace: raw.memory?.namespace || DEFAULT_CONFIG.memory.namespace,
    },
    hooks: {
      pre_edit: raw.hooks?.pre_edit ?? raw.hooks?.preEdit ?? DEFAULT_CONFIG.hooks.pre_edit,
      post_edit: raw.hooks?.post_edit ?? raw.hooks?.postEdit ?? DEFAULT_CONFIG.hooks.post_edit,
      pre_task: raw.hooks?.pre_task ?? raw.hooks?.preTask ?? DEFAULT_CONFIG.hooks.pre_task,
      post_task: raw.hooks?.post_task ?? raw.hooks?.postTask ?? DEFAULT_CONFIG.hooks.post_task,
      gate: raw.hooks?.gate ?? DEFAULT_CONFIG.hooks.gate,
      route: raw.hooks?.route ?? DEFAULT_CONFIG.hooks.route,
      stop_hook: raw.hooks?.stop_hook ?? raw.hooks?.stopHook ?? DEFAULT_CONFIG.hooks.stop_hook,
      session_restore: raw.hooks?.session_restore ?? raw.hooks?.sessionRestore ?? DEFAULT_CONFIG.hooks.session_restore,
      notification: raw.hooks?.notification ?? DEFAULT_CONFIG.hooks.notification,
    },
    models: {
      default: raw.models?.default || DEFAULT_CONFIG.models.default,
      research: raw.models?.research || DEFAULT_CONFIG.models.research,
      review: raw.models?.review || DEFAULT_CONFIG.models.review,
      test: raw.models?.test || DEFAULT_CONFIG.models.test,
    },
    model_routing: {
      enabled: raw.model_routing?.enabled ?? raw.modelRouting?.enabled ?? DEFAULT_CONFIG.model_routing.enabled,
      confidence_threshold: raw.model_routing?.confidence_threshold ?? raw.modelRouting?.confidenceThreshold ?? DEFAULT_CONFIG.model_routing.confidence_threshold,
      cost_optimization: raw.model_routing?.cost_optimization ?? raw.modelRouting?.costOptimization ?? DEFAULT_CONFIG.model_routing.cost_optimization,
      circuit_breaker: raw.model_routing?.circuit_breaker ?? raw.modelRouting?.circuitBreaker ?? DEFAULT_CONFIG.model_routing.circuit_breaker,
      agent_overrides: raw.model_routing?.agent_overrides ?? raw.modelRouting?.agentOverrides ?? DEFAULT_CONFIG.model_routing.agent_overrides,
    },
    daemon: {
      auto_start: raw.daemon?.auto_start ?? raw.daemon?.autoStart ?? DEFAULT_CONFIG.daemon.auto_start,
    },
    auto_update: {
      enabled: raw.auto_update?.enabled ?? raw.autoUpdate?.enabled ?? DEFAULT_CONFIG.auto_update.enabled,
      scripts: raw.auto_update?.scripts ?? raw.autoUpdate?.scripts ?? DEFAULT_CONFIG.auto_update.scripts,
      helpers: raw.auto_update?.helpers ?? raw.autoUpdate?.helpers ?? DEFAULT_CONFIG.auto_update.helpers,
    },
    epic: {
      admin_merge: raw.epic?.admin_merge ?? raw.epic?.adminMerge ?? DEFAULT_CONFIG.epic.admin_merge,
      default_strategy: raw.epic?.default_strategy ?? raw.epic?.defaultStrategy ?? DEFAULT_CONFIG.epic.default_strategy,
    },
    status_line: {
      enabled: raw.status_line?.enabled ?? raw.statusLine?.enabled ?? DEFAULT_CONFIG.status_line.enabled,
      branding: raw.status_line?.branding ?? raw.statusLine?.branding ?? DEFAULT_CONFIG.status_line.branding,
      show_git: raw.status_line?.show_git ?? raw.statusLine?.showGit ?? DEFAULT_CONFIG.status_line.show_git,
      show_model: raw.status_line?.show_model ?? raw.statusLine?.showModel ?? DEFAULT_CONFIG.status_line.show_model,
      show_session: raw.status_line?.show_session ?? raw.statusLine?.showSession ?? DEFAULT_CONFIG.status_line.show_session,
      show_intelligence: raw.status_line?.show_intelligence ?? raw.statusLine?.showIntelligence ?? DEFAULT_CONFIG.status_line.show_intelligence,
      show_swarm: raw.status_line?.show_swarm ?? raw.statusLine?.showSwarm ?? DEFAULT_CONFIG.status_line.show_swarm,
      show_hooks: raw.status_line?.show_hooks ?? raw.statusLine?.showHooks ?? DEFAULT_CONFIG.status_line.show_hooks,
      show_mcp: raw.status_line?.show_mcp ?? raw.statusLine?.showMcp ?? DEFAULT_CONFIG.status_line.show_mcp,
      show_security: raw.status_line?.show_security ?? raw.statusLine?.showSecurity ?? DEFAULT_CONFIG.status_line.show_security,
      show_adrs: raw.status_line?.show_adrs ?? raw.statusLine?.showAdrs ?? DEFAULT_CONFIG.status_line.show_adrs,
      show_agentdb: raw.status_line?.show_agentdb ?? raw.statusLine?.showAgentdb ?? DEFAULT_CONFIG.status_line.show_agentdb,
      show_tests: raw.status_line?.show_tests ?? raw.statusLine?.showTests ?? DEFAULT_CONFIG.status_line.show_tests,
      mode: raw.status_line?.mode ?? raw.statusLine?.mode ?? DEFAULT_CONFIG.status_line.mode,
    },
  };
}

/**
 * Load moflo config from the given directory (or cwd).
 * Tries moflo.yaml first, then moflo.config.json.
 * Returns defaults merged with file contents.
 */
export function loadMofloConfig(projectRoot?: string): MofloConfig {
  const root = projectRoot || process.cwd();
  const configFile = findConfigFile(root);

  if (!configFile) {
    return { ...DEFAULT_CONFIG, project: { name: path.basename(root) } };
  }

  try {
    const content = fs.readFileSync(configFile.path, 'utf-8');
    let raw: Record<string, any>;
    if (configFile.format === 'json') {
      raw = JSON.parse(content);
    } else if (yaml) {
      raw = yaml.load(content) as Record<string, any>;
    } else {
      // js-yaml not available — cannot parse YAML config
      throw new Error('js-yaml is required to parse moflo.yaml. Install it: npm install js-yaml');
    }

    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_CONFIG, project: { name: path.basename(root) } };
    }

    return mergeConfig(raw, root);
  } catch {
    return { ...DEFAULT_CONFIG, project: { name: path.basename(root) } };
  }
}

/**
 * Generate a moflo.yaml config file by scanning the project.
 * Detects which directories exist and populates accordingly.
 */
export function generateMofloConfig(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const projectName = path.basename(root);

  // Detect guidance directories
  const guidanceCandidates = ['.claude/guidance', 'docs/guides', 'docs', '.docs'];
  const guidanceDirs = guidanceCandidates.filter(d => fs.existsSync(path.join(root, d)));
  if (guidanceDirs.length === 0) guidanceDirs.push('.claude/guidance');

  // Detect source directories
  const srcCandidates = ['src', 'packages', 'lib', 'app', 'apps', 'services', 'modules'];
  const srcDirs = srcCandidates.filter(d => fs.existsSync(path.join(root, d)));
  if (srcDirs.length === 0) srcDirs.push('src');

  // Detect language by file extensions present
  const extensions = new Set<string>();
  for (const dir of srcDirs) {
    const fullDir = path.join(root, dir);
    if (fs.existsSync(fullDir)) {
      try {
        const sample = fs.readdirSync(fullDir, { recursive: true }) as string[];
        for (const f of sample.slice(0, 500)) {
          const ext = path.extname(String(f));
          if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb'].includes(ext)) {
            extensions.add(ext);
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  }
  const detectedExtensions = extensions.size > 0 ? [...extensions] : ['.ts', '.tsx', '.js', '.jsx'];

  const config = `# MoFlo — Project Configuration
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
  extensions: [${detectedExtensions.map(e => `"${e}"`).join(', ')}]
  exclude: [node_modules, dist, .next, coverage, build, __pycache__, target, .git]
  namespace: code-map

# Spell gates (enforced via Claude Code hooks)
gates:
  memory_first: true          # Search memory before Glob/Grep
  task_create_first: true     # TaskCreate before Agent tool
  context_tracking: true      # Track context bracket (FRESH/MODERATE/DEPLETED/CRITICAL)

# Auto-index on session start
auto_index:
  guidance: true
  code_map: true

# Memory backend
memory:
  backend: sql.js              # sql.js (WASM, no native deps) | agentdb | json
  embedding_model: Xenova/all-MiniLM-L6-v2
  namespace: default

# Hook toggles (all on by default — disable to slim down)
hooks:
  pre_edit: true               # Track file edits for learning
  post_edit: true              # Record edit outcomes, train neural patterns
  pre_task: true               # Get agent routing before task spawn
  post_task: true              # Record task results for learning
  gate: true                   # Spell gate enforcement (memory-first, task-create-first)
  route: true                  # Intelligent task routing on each prompt
  stop_hook: true              # Session-end persistence and metric export
  session_restore: true        # Restore session state on start
  notification: true           # Hook into Claude Code notifications

# Worker daemon (background indexing, optimization, test gap detection)
daemon:
  auto_start: true              # Start daemon automatically on CLI/MCP init (set false to disable)

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
  # agent_overrides:
  #   security-architect: opus     # Always use opus for security
  #   researcher: sonnet           # Pin research to sonnet

# Auto-update on session start (syncs scripts and helpers when moflo version changes)
auto_update:
  enabled: true                  # Master toggle for version-change auto-sync
  scripts: true                  # Sync .claude/scripts/ from moflo bin/
  helpers: true                  # Sync .claude/helpers/ from moflo source

# Epic processing (flo epic run)
epic:
  admin_merge: true              # Use --admin flag on gh pr merge (bypasses branch protection)
  default_strategy: single-branch  # single-branch (one PR) or auto-merge (per-story PRs)

# Status line items (show/hide individual sections)
status_line:
  enabled: true
  branding: "Moflo V4"            # Text shown in status bar
  show_git: true                  # Git branch, changes, ahead/behind
  show_model: true                # Current model name
  show_session: true              # Session duration
  show_intelligence: true         # Intelligence % indicator
  show_swarm: true                # Active swarm agents count
  show_hooks: true                # Enabled hooks count
  show_mcp: true                  # MCP server count
  show_security: true             # CVE/security status (dashboard only)
  show_adrs: true                 # ADR compliance (dashboard only)
  show_agentdb: true              # AgentDB vectors/size (dashboard only)
  show_tests: true                # Test file count (dashboard only)
  mode: single-line              # single-line (default) or dashboard (multi-line)
`;

  return config;
}

/**
 * Write the generated config to moflo.yaml.
 */
export function writeMofloConfig(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const configPath = path.join(root, CONFIG_FILES[0]);
  const content = generateMofloConfig(root);
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}
