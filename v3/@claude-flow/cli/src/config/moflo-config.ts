/**
 * MoFlo Project Configuration
 * Reads moflo.yaml from the project root to configure indexing, gates, and behavior.
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

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
    gate: boolean;
    stop_hook: boolean;
    session_restore: boolean;
  };

  models: {
    default: string;
    review: string;
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
    gate: true,
    stop_hook: true,
    session_restore: true,
  },
  models: {
    default: 'opus',
    review: 'opus',
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
      gate: raw.hooks?.gate ?? DEFAULT_CONFIG.hooks.gate,
      stop_hook: raw.hooks?.stop_hook ?? raw.hooks?.stopHook ?? DEFAULT_CONFIG.hooks.stop_hook,
      session_restore: raw.hooks?.session_restore ?? raw.hooks?.sessionRestore ?? DEFAULT_CONFIG.hooks.session_restore,
    },
    models: {
      default: raw.models?.default || DEFAULT_CONFIG.models.default,
      review: raw.models?.review || DEFAULT_CONFIG.models.review,
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
    const raw = configFile.format === 'json'
      ? JSON.parse(content)
      : yaml.load(content) as Record<string, any>;

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

# Workflow gates (enforced via Claude Code hooks)
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

# Hook toggles
hooks:
  pre_edit: true               # Track file edits
  gate: true                   # Workflow gate enforcement
  stop_hook: true              # Session-end persistence
  session_restore: true        # Restore session state on start

# Model preferences
models:
  default: opus
  review: opus
`;

  return config;
}

/**
 * Write the generated config to moflo.yaml.
 */
export function writeMofloConfig(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const configPath = path.join(root, CONFIG_FILENAME);
  const content = generateMofloConfig(root);
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}
