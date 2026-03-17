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
  models: {
    default: 'opus',
    review: 'opus',
  },
};

// ============================================================================
// Loader
// ============================================================================

const CONFIG_FILENAME = 'moflo.yaml';

/**
 * Load moflo.yaml from the given directory (or cwd).
 * Returns defaults merged with file contents.
 */
export function loadMofloConfig(projectRoot?: string): MofloConfig {
  const root = projectRoot || process.cwd();
  const configPath = path.join(root, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    // No config file — use defaults with project name from directory
    return {
      ...DEFAULT_CONFIG,
      project: { name: path.basename(root) },
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = yaml.load(content) as Record<string, any> | null;

    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_CONFIG, project: { name: path.basename(root) } };
    }

    // Deep merge with defaults
    return {
      project: {
        name: raw.project?.name || path.basename(root),
      },
      guidance: {
        directories: raw.guidance?.directories || DEFAULT_CONFIG.guidance.directories,
        namespace: raw.guidance?.namespace || DEFAULT_CONFIG.guidance.namespace,
      },
      code_map: {
        directories: raw.code_map?.directories || DEFAULT_CONFIG.code_map.directories,
        extensions: raw.code_map?.extensions || DEFAULT_CONFIG.code_map.extensions,
        exclude: raw.code_map?.exclude || DEFAULT_CONFIG.code_map.exclude,
        namespace: raw.code_map?.namespace || DEFAULT_CONFIG.code_map.namespace,
      },
      gates: {
        memory_first: raw.gates?.memory_first ?? DEFAULT_CONFIG.gates.memory_first,
        task_create_first: raw.gates?.task_create_first ?? DEFAULT_CONFIG.gates.task_create_first,
        context_tracking: raw.gates?.context_tracking ?? DEFAULT_CONFIG.gates.context_tracking,
      },
      auto_index: {
        guidance: raw.auto_index?.guidance ?? DEFAULT_CONFIG.auto_index.guidance,
        code_map: raw.auto_index?.code_map ?? DEFAULT_CONFIG.auto_index.code_map,
      },
      models: {
        default: raw.models?.default || DEFAULT_CONFIG.models.default,
        review: raw.models?.review || DEFAULT_CONFIG.models.review,
      },
    };
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
