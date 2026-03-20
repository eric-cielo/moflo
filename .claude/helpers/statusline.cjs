#!/usr/bin/env node
/**
 * Moflo V4 Statusline Generator (Optimized)
 * Displays real-time V3 implementation progress and system status
 *
 * Usage: node statusline.cjs [--json] [--compact]
 *
 * Performance notes:
 * - Single git execSync call (combines branch + status + upstream)
 * - No recursive file reading (only stat/readdir, never read test contents)
 * - No ps aux calls (uses process.memoryUsage() + file-based metrics)
 * - Strict 2s timeout on all execSync calls
 * - Shared settings cache across functions
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Configuration
const CONFIG = {
  maxAgents: 15,
};

const CWD = process.cwd();

// Load status_line config from moflo.yaml (show/hide individual items)
function loadStatusLineConfig() {
  const defaults = {
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
  };

  // Try moflo.yaml
  const yamlPath = path.join(CWD, 'moflo.yaml');
  if (fs.existsSync(yamlPath)) {
    try {
      const content = fs.readFileSync(yamlPath, 'utf-8');
      // Parse status_line block with simple regex
      const block = content.match(/status_line:\s*\n((?:\s+\w+:.*\n?)+)/);
      if (block) {
        const lines = block[1].split('\n');
        for (const line of lines) {
          const m = line.match(/^\s+(\w+):\s*(.+)/);
          if (!m) continue;
          const [, key, val] = m;
          const v = val.trim().replace(/^["']|["']$/g, '');
          if (key === 'enabled') defaults.enabled = v !== 'false';
          else if (key === 'branding') defaults.branding = v;
          else if (key === 'mode') defaults.mode = v;
          else if (key.startsWith('show_')) defaults[key] = v !== 'false';
        }
      }
    } catch { /* ignore */ }
  }

  // Try moflo.config.json
  const jsonPath = path.join(CWD, 'moflo.config.json');
  if (!fs.existsSync(yamlPath) && fs.existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const sl = raw.status_line || raw.statusLine || {};
      for (const key of Object.keys(defaults)) {
        if (sl[key] !== undefined) defaults[key] = sl[key];
        // Also check camelCase variants
        const camel = key.replace(/_(\w)/g, (_, c) => c.toUpperCase());
        if (sl[camel] !== undefined) defaults[key] = sl[camel];
      }
    } catch { /* ignore */ }
  }

  return defaults;
}

const SL_CONFIG = loadStatusLineConfig();

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  blue: '\x1b[0;34m',
  purple: '\x1b[0;35m',
  cyan: '\x1b[0;36m',
  brightRed: '\x1b[1;31m',
  brightGreen: '\x1b[1;32m',
  brightYellow: '\x1b[1;33m',
  brightBlue: '\x1b[1;34m',
  brightPurple: '\x1b[1;35m',
  brightCyan: '\x1b[1;36m',
  brightWhite: '\x1b[1;37m',
};

// Safe execSync with strict timeout (returns empty string on failure)
function safeExec(cmd, timeoutMs = 2000) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

// Safe JSON file reader (returns null on failure)
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

// Safe file stat (returns null on failure)
function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch { /* ignore */ }
  return null;
}

// Shared settings cache — read once, used by multiple functions
let _settingsCache = undefined;
function getSettings() {
  if (_settingsCache !== undefined) return _settingsCache;
  _settingsCache = readJSON(path.join(CWD, '.claude', 'settings.json'))
                || readJSON(path.join(CWD, '.claude', 'settings.local.json'))
                || null;
  return _settingsCache;
}

// ─── Data Collection (all pure-Node.js or single-exec) ──────────

// Get all git info in ONE shell call
function getGitInfo() {
  const result = {
    name: 'user', gitBranch: '', modified: 0, untracked: 0,
    staged: 0, ahead: 0, behind: 0,
  };

  // Individual git calls (cross-platform — sh -c fails on Windows)
  result.name = safeExec('git config user.name', 2000) || 'user';
  result.gitBranch = safeExec('git branch --show-current', 2000) || '';

  // Parse porcelain status
  const statusRaw = safeExec('git status --porcelain', 2000);
  if (statusRaw) {
    for (const line of statusRaw.split('\n')) {
      if (!line || line.length < 2) continue;
      const x = line[0], y = line[1];
      if (x === '?' && y === '?') { result.untracked++; continue; }
      if (x !== ' ' && x !== '?') result.staged++;
      if (y !== ' ' && y !== '?') result.modified++;
    }
  }

  {

    // Parse ahead/behind
    const ab = (safeExec('git rev-list --left-right --count HEAD...@{upstream}', 2000) || '0 0').split(/\s+/);
    result.ahead = parseInt(ab[0]) || 0;
    result.behind = parseInt(ab[1]) || 0;
  }

  return result;
}

// Detect model name from Claude config (pure file reads, no exec)
function getModelName() {
  try {
    const claudeConfig = readJSON(path.join(os.homedir(), '.claude.json'));
    if (claudeConfig?.projects) {
      for (const [projectPath, projectConfig] of Object.entries(claudeConfig.projects)) {
        if (CWD === projectPath || CWD.startsWith(projectPath + '/')) {
          const usage = projectConfig.lastModelUsage;
          if (usage) {
            const ids = Object.keys(usage);
            if (ids.length > 0) {
              let modelId = ids[ids.length - 1];
              let latest = 0;
              for (const id of ids) {
                const ts = usage[id]?.lastUsedAt ? new Date(usage[id].lastUsedAt).getTime() : 0;
                if (ts > latest) { latest = ts; modelId = id; }
              }
              if (modelId.includes('opus')) return 'Opus 4.6';
              if (modelId.includes('sonnet')) return 'Sonnet 4.6';
              if (modelId.includes('haiku')) return 'Haiku 4.5';
              return modelId.split('-').slice(1, 3).join(' ');
            }
          }
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // Fallback: settings.json model field
  const settings = getSettings();
  if (settings?.model) {
    const m = settings.model;
    if (m.includes('opus')) return 'Opus 4.6';
    if (m.includes('sonnet')) return 'Sonnet 4.6';
    if (m.includes('haiku')) return 'Haiku 4.5';
  }
  return 'Claude Code';
}

// Get learning stats from memory database (pure stat calls)
function getLearningStats() {
  const memoryPaths = [
    path.join(CWD, '.swarm', 'memory.db'),
    path.join(CWD, '.claude-flow', 'memory.db'),
    path.join(CWD, '.claude', 'memory.db'),
    path.join(CWD, 'data', 'memory.db'),
    path.join(CWD, '.agentdb', 'memory.db'),
  ];

  for (const dbPath of memoryPaths) {
    const stat = safeStat(dbPath);
    if (stat) {
      const sizeKB = stat.size / 1024;
      const patterns = Math.floor(sizeKB / 2);
      return {
        patterns,
        sessions: Math.max(1, Math.floor(patterns / 10)),
      };
    }
  }

  // Check session files count
  let sessions = 0;
  try {
    const sessDir = path.join(CWD, '.claude', 'sessions');
    if (fs.existsSync(sessDir)) {
      sessions = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).length;
    }
  } catch { /* ignore */ }

  return { patterns: 0, sessions };
}

// V3 progress from metrics files (pure file reads)
function getV3Progress() {
  const learning = getLearningStats();
  const totalDomains = 5;

  const dddData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'ddd-progress.json'));
  let dddProgress = dddData?.progress || 0;
  let domainsCompleted = Math.min(5, Math.floor(dddProgress / 20));

  if (dddProgress === 0 && learning.patterns > 0) {
    if (learning.patterns >= 500) domainsCompleted = 5;
    else if (learning.patterns >= 200) domainsCompleted = 4;
    else if (learning.patterns >= 100) domainsCompleted = 3;
    else if (learning.patterns >= 50) domainsCompleted = 2;
    else if (learning.patterns >= 10) domainsCompleted = 1;
    dddProgress = Math.floor((domainsCompleted / totalDomains) * 100);
  }

  return {
    domainsCompleted, totalDomains, dddProgress,
    patternsLearned: learning.patterns,
    sessionsCompleted: learning.sessions,
  };
}

// Security status (pure file reads)
function getSecurityStatus() {
  const totalCves = 3;
  const auditData = readJSON(path.join(CWD, '.claude-flow', 'security', 'audit-status.json'));
  if (auditData) {
    return {
      status: auditData.status || 'PENDING',
      cvesFixed: auditData.cvesFixed || 0,
      totalCves: auditData.totalCves || 3,
    };
  }

  let cvesFixed = 0;
  try {
    const scanDir = path.join(CWD, '.claude', 'security-scans');
    if (fs.existsSync(scanDir)) {
      cvesFixed = Math.min(totalCves, fs.readdirSync(scanDir).filter(f => f.endsWith('.json')).length);
    }
  } catch { /* ignore */ }

  return {
    status: cvesFixed >= totalCves ? 'CLEAN' : cvesFixed > 0 ? 'IN_PROGRESS' : 'PENDING',
    cvesFixed,
    totalCves,
  };
}

// Swarm status (pure file reads, NO ps aux)
function getSwarmStatus() {
  const activityData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'swarm-activity.json'));
  if (activityData?.swarm) {
    return {
      activeAgents: activityData.swarm.agent_count || 0,
      maxAgents: CONFIG.maxAgents,
      coordinationActive: activityData.swarm.coordination_active || activityData.swarm.active || false,
    };
  }

  const progressData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'v3-progress.json'));
  if (progressData?.swarm) {
    return {
      activeAgents: progressData.swarm.activeAgents || progressData.swarm.agent_count || 0,
      maxAgents: progressData.swarm.totalAgents || CONFIG.maxAgents,
      coordinationActive: progressData.swarm.active || (progressData.swarm.activeAgents > 0),
    };
  }

  return { activeAgents: 0, maxAgents: CONFIG.maxAgents, coordinationActive: false };
}

// System metrics (uses process.memoryUsage() — no shell spawn)
function getSystemMetrics() {
  const memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
  const learning = getLearningStats();
  const agentdb = getAgentDBStats();

  // Intelligence from learning.json
  const learningData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'learning.json'));
  let intelligencePct = 0;
  let contextPct = 0;

  if (learningData?.intelligence?.score !== undefined) {
    intelligencePct = Math.min(100, Math.floor(learningData.intelligence.score));
  } else {
    const fromPatterns = learning.patterns > 0 ? Math.min(100, Math.floor(learning.patterns / 10)) : 0;
    const fromVectors = agentdb.vectorCount > 0 ? Math.min(100, Math.floor(agentdb.vectorCount / 100)) : 0;
    intelligencePct = Math.max(fromPatterns, fromVectors);
  }

  // Maturity fallback (pure fs checks, no git exec)
  if (intelligencePct === 0) {
    let score = 0;
    if (fs.existsSync(path.join(CWD, '.claude'))) score += 15;
    const srcDirs = ['src', 'lib', 'app', 'packages', 'v3'];
    for (const d of srcDirs) { if (fs.existsSync(path.join(CWD, d))) { score += 15; break; } }
    const testDirs = ['tests', 'test', '__tests__', 'spec'];
    for (const d of testDirs) { if (fs.existsSync(path.join(CWD, d))) { score += 10; break; } }
    const cfgFiles = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
    for (const f of cfgFiles) { if (fs.existsSync(path.join(CWD, f))) { score += 5; break; } }
    intelligencePct = Math.min(100, score);
  }

  if (learningData?.sessions?.total !== undefined) {
    contextPct = Math.min(100, learningData.sessions.total * 5);
  } else {
    contextPct = Math.min(100, Math.floor(learning.sessions * 5));
  }

  // Sub-agents from file metrics (no ps aux)
  let subAgents = 0;
  const activityData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'swarm-activity.json'));
  if (activityData?.processes?.estimated_agents) {
    subAgents = activityData.processes.estimated_agents;
  }

  return { memoryMB, contextPct, intelligencePct, subAgents };
}

// ADR status (count files only — don't read contents)
function getADRStatus() {
  const complianceData = readJSON(path.join(CWD, '.claude-flow', 'metrics', 'adr-compliance.json'));
  if (complianceData) {
    const checks = complianceData.checks || {};
    const total = Object.keys(checks).length;
    const impl = Object.values(checks).filter(c => c.compliant).length;
    return { count: total, implemented: impl, compliance: complianceData.compliance || 0 };
  }

  // Fallback: just count ADR files (don't read them)
  const adrPaths = [
    path.join(CWD, 'v3', 'implementation', 'adrs'),
    path.join(CWD, 'docs', 'adrs'),
    path.join(CWD, '.claude-flow', 'adrs'),
  ];

  for (const adrPath of adrPaths) {
    try {
      if (fs.existsSync(adrPath)) {
        const files = fs.readdirSync(adrPath).filter(f =>
          f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\d{4}-/.test(f))
        );
        // Estimate: ~70% implemented in mature projects
        const implemented = Math.floor(files.length * 0.7);
        const compliance = files.length > 0 ? Math.floor((implemented / files.length) * 100) : 0;
        return { count: files.length, implemented, compliance };
      }
    } catch { /* ignore */ }
  }

  return { count: 0, implemented: 0, compliance: 0 };
}

// Hooks status (shared settings cache)
function getHooksStatus() {
  let enabled = 0;
  const total = 17;
  const settings = getSettings();

  if (settings?.hooks) {
    for (const category of Object.keys(settings.hooks)) {
      const h = settings.hooks[category];
      if (Array.isArray(h) && h.length > 0) enabled++;
    }
  }

  try {
    const hooksDir = path.join(CWD, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js') || f.endsWith('.sh')).length;
      enabled = Math.max(enabled, hookFiles);
    }
  } catch { /* ignore */ }

  return { enabled, total };
}

// AgentDB stats (pure stat calls)
function getAgentDBStats() {
  let vectorCount = 0;
  let dbSizeKB = 0;
  let namespaces = 0;
  let hasHnsw = false;

  const dbFiles = [
    path.join(CWD, '.swarm', 'memory.db'),
    path.join(CWD, '.claude-flow', 'memory.db'),
    path.join(CWD, '.claude', 'memory.db'),
    path.join(CWD, 'data', 'memory.db'),
  ];

  for (const f of dbFiles) {
    const stat = safeStat(f);
    if (stat) {
      dbSizeKB = stat.size / 1024;
      vectorCount = Math.floor(dbSizeKB / 2);
      namespaces = 1;
      break;
    }
  }

  if (vectorCount === 0) {
    const dbDirs = [
      path.join(CWD, '.claude-flow', 'agentdb'),
      path.join(CWD, '.swarm', 'agentdb'),
      path.join(CWD, '.agentdb'),
    ];
    for (const dir of dbDirs) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const files = fs.readdirSync(dir);
          namespaces = files.filter(f => f.endsWith('.db') || f.endsWith('.sqlite')).length;
          for (const file of files) {
            const stat = safeStat(path.join(dir, file));
            if (stat?.isFile()) dbSizeKB += stat.size / 1024;
          }
          vectorCount = Math.floor(dbSizeKB / 2);
          break;
        }
      } catch { /* ignore */ }
    }
  }

  const hnswPaths = [
    path.join(CWD, '.swarm', 'hnsw.index'),
    path.join(CWD, '.claude-flow', 'hnsw.index'),
  ];
  for (const p of hnswPaths) {
    const stat = safeStat(p);
    if (stat) {
      hasHnsw = true;
      vectorCount = Math.max(vectorCount, Math.floor(stat.size / 512));
      break;
    }
  }

  return { vectorCount, dbSizeKB: Math.floor(dbSizeKB), namespaces, hasHnsw };
}

// Test stats (count files only — NO reading file contents)
function getTestStats() {
  let testFiles = 0;

  function countTestFiles(dir, depth = 0) {
    if (depth > 2) return; // Shallower recursion limit
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          countTestFiles(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const n = entry.name;
          if (n.includes('.test.') || n.includes('.spec.') || n.includes('_test.') || n.includes('_spec.')) {
            testFiles++;
          }
        }
      }
    } catch { /* ignore */ }
  }

  for (const d of ['tests', 'test', '__tests__', 'v3/__tests__']) {
    countTestFiles(path.join(CWD, d));
  }
  countTestFiles(path.join(CWD, 'src'));

  // Estimate ~4 test cases per file (avoids reading every file)
  return { testFiles, testCases: testFiles * 4 };
}

// Integration status (shared settings + file checks)
function getIntegrationStatus() {
  const mcpServers = { total: 0, enabled: 0 };
  const settings = getSettings();

  if (settings?.mcpServers && typeof settings.mcpServers === 'object') {
    const servers = Object.keys(settings.mcpServers);
    mcpServers.total = servers.length;
    mcpServers.enabled = settings.enabledMcpjsonServers
      ? settings.enabledMcpjsonServers.filter(s => servers.includes(s)).length
      : servers.length;
  }

  // Fallback: .mcp.json
  if (mcpServers.total === 0) {
    const mcpConfig = readJSON(path.join(CWD, '.mcp.json'))
                   || readJSON(path.join(os.homedir(), '.claude', 'mcp.json'));
    if (mcpConfig?.mcpServers) {
      const s = Object.keys(mcpConfig.mcpServers);
      mcpServers.total = s.length;
      mcpServers.enabled = s.length;
    }
  }

  const hasDatabase = ['.swarm/memory.db', '.claude-flow/memory.db', 'data/memory.db']
    .some(p => fs.existsSync(path.join(CWD, p)));
  const hasApi = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

  return { mcpServers, hasDatabase, hasApi };
}

// Session stats (pure file reads)
function getSessionStats() {
  for (const p of ['.claude-flow/session.json', '.claude/session.json']) {
    const data = readJSON(path.join(CWD, p));
    if (data?.startTime) {
      const diffMs = Date.now() - new Date(data.startTime).getTime();
      const mins = Math.floor(diffMs / 60000);
      const duration = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
      return { duration };
    }
  }
  return { duration: '' };
}

// ─── Rendering ──────────────────────────────────────────────────

function progressBar(current, total) {
  const width = 5;
  const filled = Math.round((current / total) * width);
  return '[' + '\u25CF'.repeat(filled) + '\u25CB'.repeat(width - filled) + ']';
}

// Single-line statusline for Claude Code's status bar
function generateStatusline() {
  const git = getGitInfo();
  const modelName = getModelName();
  const swarm = getSwarmStatus();
  const system = getSystemMetrics();
  const session = getSessionStats();
  const hooks = getHooksStatus();
  const integration = getIntegrationStatus();

  if (!SL_CONFIG.enabled) return '';

  const parts = [];

  // Branding (always shown when enabled)
  parts.push(`${c.bold}${c.brightPurple}\u258A ${SL_CONFIG.branding}${c.reset}`);

  // User + swarm indicator
  const dot = swarm.coordinationActive ? `${c.brightGreen}\u25CF${c.reset}` : `${c.brightCyan}\u25CF${c.reset}`;
  parts.push(`${dot} ${c.brightCyan}${git.name}${c.reset}`);

  // Git branch + changes
  if (SL_CONFIG.show_git && git.gitBranch) {
    let branchPart = `${c.brightBlue}\u23C7 ${git.gitBranch}${c.reset}`;
    const changes = [];
    if (git.staged > 0) changes.push(`${c.brightGreen}+${git.staged}${c.reset}`);
    if (git.modified > 0) changes.push(`${c.brightYellow}~${git.modified}${c.reset}`);
    if (git.untracked > 0) changes.push(`${c.dim}?${git.untracked}${c.reset}`);
    if (changes.length > 0) branchPart += ` ${changes.join('')}`;
    if (git.ahead > 0) branchPart += ` ${c.brightGreen}\u2191${git.ahead}${c.reset}`;
    if (git.behind > 0) branchPart += ` ${c.brightRed}\u2193${git.behind}${c.reset}`;
    parts.push(branchPart);
  }

  // Model
  if (SL_CONFIG.show_model) {
    parts.push(`${c.purple}${modelName}${c.reset}`);
  }

  // Session duration
  if (SL_CONFIG.show_session && session.duration) {
    parts.push(`${c.cyan}\u23F1 ${session.duration}${c.reset}`);
  }

  // Intelligence %
  if (SL_CONFIG.show_intelligence) {
    const intellColor = system.intelligencePct >= 80 ? c.brightGreen : system.intelligencePct >= 40 ? c.brightYellow : c.dim;
    parts.push(`${intellColor}\u25CF ${system.intelligencePct}%${c.reset}`);
  }

  // Swarm agents (only if active)
  if (SL_CONFIG.show_swarm && (swarm.activeAgents > 0 || swarm.coordinationActive)) {
    parts.push(`${c.brightYellow}\u25C9 ${swarm.activeAgents}/${swarm.maxAgents}${c.reset}`);
  }

  // Hooks (compact)
  if (SL_CONFIG.show_hooks && hooks.enabled > 0) {
    parts.push(`${c.brightGreen}\u2713${hooks.enabled}h${c.reset}`);
  }

  // MCP (compact)
  if (SL_CONFIG.show_mcp && integration.mcpServers.total > 0) {
    const mcpCol = integration.mcpServers.enabled === integration.mcpServers.total ? c.brightGreen : c.brightYellow;
    parts.push(`${mcpCol}MCP${integration.mcpServers.enabled}${c.reset}`);
  }

  return parts.join(` ${c.dim}\u2502${c.reset} `);
}

// Multi-line dashboard (for --dashboard flag)
// Respects show_* toggles from moflo.yaml status_line config
function generateDashboard() {
  const git = getGitInfo();
  const session = getSessionStats();
  const lines = [];

  // Header: branding + git
  let header = `${c.bold}${c.brightPurple}\u258A ${SL_CONFIG.branding}${c.reset}`;
  if (SL_CONFIG.show_git && git.gitBranch) {
    header += `  ${c.brightBlue}\u23C7 ${git.gitBranch}${c.reset}`;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += `${c.brightGreen}+${git.staged}${c.reset}`;
      if (git.modified > 0) ind += `${c.brightYellow}~${git.modified}${c.reset}`;
      if (git.untracked > 0) ind += `${c.dim}?${git.untracked}${c.reset}`;
      header += ` ${ind}`;
    }
    if (git.ahead > 0) header += ` ${c.brightGreen}\u2191${git.ahead}${c.reset}`;
    if (git.behind > 0) header += ` ${c.brightRed}\u2193${git.behind}${c.reset}`;
  }
  if (SL_CONFIG.show_session && session.duration) {
    header += `  ${c.dim}\u2502${c.reset}  ${c.cyan}\u23F1 ${session.duration}${c.reset}`;
  }
  lines.push(header);

  // Separator
  lines.push(`${c.dim}${'─'.repeat(53)}${c.reset}`);

  // Swarm line (if enabled)
  if (SL_CONFIG.show_swarm) {
    const swarm = getSwarmStatus();
    const system = getSystemMetrics();
    const swarmInd = swarm.coordinationActive ? `${c.brightGreen}\u25C9${c.reset}` : `${c.dim}\u25CB${c.reset}`;
    const agentsColor = swarm.activeAgents > 0 ? c.brightGreen : c.red;
    lines.push(
      `${c.brightYellow}\uD83E\uDD16 Swarm${c.reset}  ${swarmInd} [${agentsColor}${String(swarm.activeAgents).padStart(2)}${c.reset}/${c.brightWhite}${swarm.maxAgents}${c.reset}]  ` +
      `${c.brightPurple}\uD83D\uDC65 ${system.subAgents}${c.reset}    ` +
      `${c.brightCyan}\uD83D\uDCBE ${system.memoryMB}MB${c.reset}`
    );
  }

  // AgentDB + MCP line (if either enabled)
  if (SL_CONFIG.show_agentdb || SL_CONFIG.show_mcp) {
    const parts = [];
    if (SL_CONFIG.show_agentdb) {
      const agentdb = getAgentDBStats();
      const hnswInd = agentdb.hasHnsw ? `${c.brightGreen}\u26A1${c.reset}` : '';
      const sizeDisp = agentdb.dbSizeKB >= 1024 ? `${(agentdb.dbSizeKB / 1024).toFixed(1)}MB` : `${agentdb.dbSizeKB}KB`;
      const vectorColor = agentdb.vectorCount > 0 ? c.brightGreen : c.dim;
      parts.push(`${c.cyan}Vectors${c.reset} ${vectorColor}\u25CF${agentdb.vectorCount}${hnswInd}${c.reset}`);
      parts.push(`${c.cyan}Size${c.reset} ${c.brightWhite}${sizeDisp}${c.reset}`);
    }
    if (SL_CONFIG.show_mcp) {
      const integration = getIntegrationStatus();
      if (integration.mcpServers.total > 0) {
        const mcpCol = integration.mcpServers.enabled === integration.mcpServers.total ? c.brightGreen :
                       integration.mcpServers.enabled > 0 ? c.brightYellow : c.red;
        parts.push(`${c.cyan}MCP${c.reset} ${mcpCol}\u25CF${integration.mcpServers.enabled}/${integration.mcpServers.total}${c.reset}`);
      }
      if (integration.hasDatabase) parts.push(`${c.brightGreen}\u25C6${c.reset}DB`);
    }
    if (parts.length > 0) {
      lines.push(`${c.brightCyan}\uD83D\uDCCA AgentDB${c.reset}    ${parts.join(`  ${c.dim}\u2502${c.reset}  `)}`);
    }
  }

  return lines.join('\n');
}

// Compact dashboard: header + single combined line
function generateCompactDashboard() {
  const git = getGitInfo();
  const session = getSessionStats();
  const lines = [];

  // Header: branding + git + session
  let header = `${c.bold}${c.brightPurple}\u258A ${SL_CONFIG.branding}${c.reset}`;
  if (SL_CONFIG.show_git && git.gitBranch) {
    header += `  ${c.brightBlue}\u23C7 ${git.gitBranch}${c.reset}`;
    const changes = git.modified + git.staged + git.untracked;
    if (changes > 0) {
      let ind = '';
      if (git.staged > 0) ind += `${c.brightGreen}+${git.staged}${c.reset}`;
      if (git.modified > 0) ind += `${c.brightYellow}~${git.modified}${c.reset}`;
      if (git.untracked > 0) ind += `${c.dim}?${git.untracked}${c.reset}`;
      header += ` ${ind}`;
    }
    if (git.ahead > 0) header += ` ${c.brightGreen}\u2191${git.ahead}${c.reset}`;
    if (git.behind > 0) header += ` ${c.brightRed}\u2193${git.behind}${c.reset}`;
  }
  if (SL_CONFIG.show_session && session.duration) {
    header += `  ${c.dim}\u2502${c.reset}  ${c.cyan}\u23F1 ${session.duration}${c.reset}`;
  }
  lines.push(header);

  // Combined swarm + agentdb + mcp line
  const segments = [];
  if (SL_CONFIG.show_swarm) {
    const swarm = getSwarmStatus();
    const swarmInd = swarm.coordinationActive ? `${c.brightGreen}\u25C9${c.reset}` : `${c.dim}\u25CB${c.reset}`;
    const agentsColor = swarm.activeAgents > 0 ? c.brightGreen : c.red;
    segments.push(
      `${c.brightYellow}\uD83E\uDD16${c.reset} ${swarmInd}[${agentsColor}${swarm.activeAgents}${c.reset}/${c.brightWhite}${swarm.maxAgents}${c.reset}]`
    );
  }
  if (SL_CONFIG.show_agentdb) {
    const agentdb = getAgentDBStats();
    const hnswInd = agentdb.hasHnsw ? `\u26A1` : '';
    const sizeDisp = agentdb.dbSizeKB >= 1024 ? `${(agentdb.dbSizeKB / 1024).toFixed(1)}MB` : `${agentdb.dbSizeKB}KB`;
    const vectorColor = agentdb.vectorCount > 0 ? c.brightGreen : c.dim;
    segments.push(
      `${c.brightCyan}\uD83D\uDCCA${c.reset} ${vectorColor}${agentdb.vectorCount}${hnswInd}${c.reset} ${c.dim}(${sizeDisp})${c.reset}`
    );
  }
  if (SL_CONFIG.show_mcp) {
    const integration = getIntegrationStatus();
    if (integration.mcpServers.total > 0) {
      const mcpCol = integration.mcpServers.enabled === integration.mcpServers.total ? c.brightGreen :
                     integration.mcpServers.enabled > 0 ? c.brightYellow : c.red;
      segments.push(`${c.cyan}MCP${c.reset} ${mcpCol}\u25CF${integration.mcpServers.enabled}/${integration.mcpServers.total}${c.reset}`);
    }
  }
  if (segments.length > 0) {
    lines.push(segments.join(`  ${c.dim}\u2502${c.reset}  `));
  }

  return lines.join('\n');
}

// JSON output
function generateJSON() {
  const git = getGitInfo();
  return {
    user: { name: git.name, gitBranch: git.gitBranch, modelName: getModelName() },
    v3Progress: getV3Progress(),
    security: getSecurityStatus(),
    swarm: getSwarmStatus(),
    system: getSystemMetrics(),
    adrs: getADRStatus(),
    hooks: getHooksStatus(),
    agentdb: getAgentDBStats(),
    tests: getTestStats(),
    git: { modified: git.modified, untracked: git.untracked, staged: git.staged, ahead: git.ahead, behind: git.behind },
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Main ───────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(generateJSON(), null, 2));
} else if (process.argv.includes('--json-compact')) {
  console.log(JSON.stringify(generateJSON()));
} else if (process.argv.includes('--compact') || SL_CONFIG.mode === 'compact') {
  console.log(generateCompactDashboard());
} else if (process.argv.includes('--dashboard') || SL_CONFIG.mode === 'dashboard') {
  console.log(generateDashboard());
} else {
  // Default: single-line statusline
  console.log(generateStatusline());
}
