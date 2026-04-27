/**
 * MCP Tools Drift Guard
 *
 * Every registered MCP tool must have at least one real consumer outside its
 * own definition file. A "real consumer" is any of:
 *
 *   1. `mcp__moflo__<tool_name>` token in any file outside the tool's owner module
 *   2. `callMCPTool('<tool_name>')` or `callMCPTool("<tool_name>")` in any source file
 *
 * The roundtrip test in `mcp-tools-deep.test.ts` does NOT count — it's a
 * registration smoke test, not a real consumer.
 *
 * Tools wrap real, exercised infrastructure but lack MCP-side consumers
 * intentionally (e.g. `moflodb_*` is a lower-level controller surface;
 * `aidefence_*` is wired into the security stack via direct imports). Those
 * live in ALLOWLIST below with per-entry justifications.
 *
 * The TIER_3_FOLLOWUP set parks individual orphaned tools inside otherwise-
 * live families (e.g. `agent_terminate` inside agent_*) — these are known
 * dead and slated for a follow-up cleanup PR but were out of scope for the
 * conservative Tier-1 + Tier-2 cut in #693.
 *
 * Failure mode: someone adds a new MCP tool with no consumer. They must
 * either (a) wire a real call site, or (b) add the tool to ALLOWLIST or
 * TIER_3_FOLLOWUP. Mirrors the SKILLS_MAP-integrity pattern from #690.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = join(__dirname, '..', '..', '..');
const TOOLS_DIR = join(REPO_ROOT, 'src', 'cli', 'mcp-tools');

// Tools that wrap real, exercised infrastructure but have no MCP-side consumer
// in the repo. Each needs a one-line justification.
const ALLOWLIST: Record<string, string> = {
  // moflodb_* — wraps memory-bridge controllers (HierarchicalMemory,
  // CausalGraph, ReasoningBank, EWC consolidation, AttestationLog). Lower-level
  // expert API; the higher-level memory_* tools cover common cases.
  'moflodb_health': 'expert API: memory-bridge health probe',
  'moflodb_controllers': 'expert API: list active memory controllers',
  'moflodb_pattern-store': 'expert API: ReasoningBank pattern store',
  'moflodb_pattern-search': 'expert API: ReasoningBank pattern search',
  'moflodb_feedback': 'expert API: RVF feedback signal recording',
  'moflodb_causal-edge': 'expert API: causal-graph edge mgmt',
  'moflodb_route': 'expert API: semantic route resolution',
  'moflodb_session-start': 'expert API: bridge session lifecycle',
  'moflodb_session-end': 'expert API: bridge session lifecycle',
  'moflodb_hierarchical-store': 'expert API: hierarchical memory write',
  'moflodb_hierarchical-recall': 'expert API: hierarchical memory read',
  'moflodb_consolidate': 'expert API: EWC++ consolidation',
  'moflodb_batch': 'expert API: batch ops on the bridge',
  'moflodb_context-synthesize': 'expert API: context synthesis',
  'moflodb_semantic-route': 'expert API: semantic routing',

  // aidefence_* — wraps the active aidefence module. Wired into the security
  // stack via direct imports; the MCP exposure is the public surface for
  // security-tooling consumers.
  'aidefence_scan': 'public security API: prompt-injection scan',
  'aidefence_analyze': 'public security API: deep analysis',
  'aidefence_stats': 'public security API: aggregated stats',
  'aidefence_learn': 'public security API: pattern learning',
  'aidefence_is_safe': 'public security API: boolean safety check',
  'aidefence_has_pii': 'public security API: PII detection',

  // Tools advertised in the CLAUDE.md fragment shipped to consumers via
  // moflo-init.ts. The documented call site IS the consumer.
  'hooks_route': 'advertised in moflo-init.ts CLAUDE.md fragment as consumer API',
  'hooks_pre-task': 'advertised in moflo-init.ts CLAUDE.md fragment as consumer API',
  'hooks_post-task': 'advertised in moflo-init.ts CLAUDE.md fragment as consumer API',
};

// Tier-3 follow-up: individual tools inside otherwise-live families with no
// MCP consumer. The conservative scope of #693 was Tier 1 + Tier 2 only;
// these were left for a follow-up. Each entry should either gain a consumer
// or be removed in that PR.
const TIER_3_FOLLOWUP: ReadonlySet<string> = new Set([
  // agent_* family alive; these singletons orphaned
  'agent_terminate', 'agent_pool', 'agent_health', 'agent_update',
  // swarm_* family alive
  'swarm_shutdown', 'swarm_health',
  // task_* family alive
  'task_list', 'task_update', 'task_assign', 'task_cancel',
  // config_* — duplicated by `flo config <action>` CLI
  'config_get', 'config_set', 'config_list', 'config_reset', 'config_export', 'config_import',
  // session_* — duplicated by `flo session <action>` CLI
  'session_save', 'session_restore', 'session_list', 'session_delete', 'session_info',
  // hooks_* singletons — wrap the live HookRegistry but no MCP consumer
  'hooks_pre-edit', 'hooks_pre-command', 'hooks_post-command',
  'hooks_metrics', 'hooks_list', 'hooks_explain',
  'hooks_pretrain', 'hooks_build-agents', 'hooks_transfer',
  'hooks_session-restore', 'hooks_notify', 'hooks_init',
  'hooks_intelligence_trajectory-start', 'hooks_intelligence_trajectory-step',
  'hooks_intelligence_trajectory-end', 'hooks_intelligence_pattern-search',
  'hooks_intelligence_stats', 'hooks_intelligence_learn',
  'hooks_intelligence_attention',
  'hooks_worker-list', 'hooks_worker-status', 'hooks_worker-detect', 'hooks_worker-cancel',
  'hooks_model-route', 'hooks_model-outcome', 'hooks_model-stats',
  // neural_* — wraps neural module
  'neural_compress', 'neural_status', 'neural_optimize',
  // spell_* — wraps spell engine; spell_cast/create/list/etc are consumed
  'spell_template', 'spell_accept', 'spell_delete',
  // hive-mind_* — wraps the live hive-mind subsystem
  'hive-mind_spawn', 'hive-mind_shutdown',
  // singletons in otherwise-live families
  'memory_migrate', 'github_workflow',
]);

interface RegisteredTool {
  name: string;
  ownerFile: string;
}

function collectRegisteredTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  // Read the registry source-of-truth: mcp-client.ts imports each *-tools.ts
  // module that's actually wired in. Files defined but not imported (orphan
  // modules) are excluded.
  const clientPath = join(TOOLS_DIR, '..', 'mcp-client.ts');
  const client = readFileSync(clientPath, 'utf8');
  const importRe = /import\s+\{\s*(\w+)\s*\}\s+from\s+['"]\.\/mcp-tools\/([\w-]+)\.js['"]/g;
  const registeredFiles = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(client))) {
    registeredFiles.add(`${m[2]}.ts`);
  }

  for (const fname of registeredFiles) {
    const file = join(TOOLS_DIR, fname);
    const src = readFileSync(file, 'utf8');
    // Require at least one underscore to avoid matching inner property names
    // like { name: 'mcp', ... } in handler bodies. Real MCP tool names always
    // have form `<category>_<action>` or `<category>_<action>-<detail>`.
    const re = /^\s*name:\s*['"]([a-z][a-z0-9-]*_[a-z0-9_-]+)['"]/gm;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(src))) {
      tools.push({ name: mm[1], ownerFile: file });
    }
  }
  return tools;
}

interface CorpusEntry { path: string; content: string }

const MAX_FILE_BYTES = 1 << 20; // 1 MB — real refs are short identifiers
const SKIP_BASENAMES = new Set(['package-lock.json']);

function buildCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const ROOTS = [
    join(REPO_ROOT, 'src'),
    join(REPO_ROOT, '.claude'),
    join(REPO_ROOT, 'docs'),
    join(REPO_ROOT, 'bin'),
    join(REPO_ROOT, 'spells'),
  ];
  function walk(dir: string): void {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const e of names) {
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
        walk(full);
      } else if (st.isFile()) {
        if (SKIP_BASENAMES.has(e)) continue;
        if (st.size > MAX_FILE_BYTES) continue;
        if (full.endsWith('mcp-tools-deep.test.ts')) continue;
        if (full.endsWith('mcp-tools-drift-guard.test.ts')) continue;
        if (!/\.(ts|js|mjs|cjs|md|json|yaml|yml)$/i.test(full)) continue;
        let content: string;
        try { content = readFileSync(full, 'utf8'); } catch { continue; }
        // Pre-filter: keep only files that contain at least one of the
        // consumer markers. Most repo files don't reference MCP tools at all,
        // so this rejects the bulk before the per-tool inner loop.
        if (!content.includes('mcp__moflo__') && !content.includes('callMCPTool(')) continue;
        entries.push({ path: full, content });
      }
    }
  }
  for (const root of ROOTS) walk(root);
  return entries;
}

let _corpus: CorpusEntry[] | null = null;
function getCorpus(): CorpusEntry[] {
  return _corpus ??= buildCorpus();
}

function findConsumers(tool: RegisteredTool): string[] {
  const consumers: string[] = [];
  const t1 = `mcp__moflo__${tool.name}`;
  const t2 = `callMCPTool('${tool.name}'`;
  const t3 = `callMCPTool("${tool.name}"`;
  for (const entry of getCorpus()) {
    if (entry.path === tool.ownerFile) continue;
    if (entry.content.includes(t1) || entry.content.includes(t2) || entry.content.includes(t3)) {
      consumers.push(entry.path);
    }
  }
  return consumers;
}

describe('MCP Tools Drift Guard (#693)', () => {
  it('every registered MCP tool has a real consumer, allowlist, or follow-up entry', () => {
    const tools = collectRegisteredTools();
    expect(tools.length).toBeGreaterThan(0);

    const orphaned: Array<{ name: string; ownerFile: string }> = [];
    for (const tool of tools) {
      if (tool.name in ALLOWLIST) continue;
      if (TIER_3_FOLLOWUP.has(tool.name)) continue;
      const consumers = findConsumers(tool);
      if (consumers.length === 0) {
        orphaned.push({ name: tool.name, ownerFile: tool.ownerFile });
      }
    }

    if (orphaned.length > 0) {
      const message = orphaned
        .map(o => `  - ${o.name} (defined in ${o.ownerFile.split(/[\\/]/).slice(-3).join('/')})`)
        .join('\n');
      const hint = `\n\n${orphaned.length} MCP tool(s) registered with no consumer:\n${message}\n\nFix: either wire a real call site (mcp__moflo__<name> in a skill/agent .md, or callMCPTool('<name>') in CLI code), add to ALLOWLIST with a justification, or add to TIER_3_FOLLOWUP if it's a known orphan.`;
      expect(orphaned, hint).toEqual([]);
    }
  });

  it('no allowlist or follow-up entry references a tool that does not exist', () => {
    const tools = collectRegisteredTools();
    const registeredNames = new Set(tools.map(t => t.name));
    const stale: string[] = [];
    for (const name of Object.keys(ALLOWLIST)) {
      if (!registeredNames.has(name)) stale.push(name);
    }
    for (const name of TIER_3_FOLLOWUP) {
      if (!registeredNames.has(name)) stale.push(name);
    }
    expect(stale, `Allowlist/follow-up references unknown tools: ${stale.join(', ')}`).toEqual([]);
  });

  it('every allowlist entry has a non-empty justification', () => {
    for (const [name, justification] of Object.entries(ALLOWLIST)) {
      expect(justification.trim().length, `${name} needs a justification`).toBeGreaterThan(10);
    }
  });
});
