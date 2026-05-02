/**
 * MCP Tools Drift Guard
 *
 * Every registered MCP tool must have at least one real consumer outside its
 * own definition file. A "real consumer" is any of:
 *
 *   1. `mcp__moflo__<tool_name>` token in a skill / agent / doc / settings file
 *   2. `callMCPTool('<name>')` / `callMCPTool("<name>")` literal call site
 *   3. `callMCPTool(TOOL_X, …)` indirect call, where `TOOL_X` is exported from
 *      `src/cli/mcp-tools/tool-names.ts` as a literal-typed string constant.
 *      Form #3 was added in #700 after `spell_template` shipped broken because
 *      the literal-string scan missed its constant-mediated callsite.
 *
 * The roundtrip test in `mcp-tools-deep.test.ts` does NOT count — it's a
 * registration smoke test, not a real consumer.
 *
 * Tools that wrap real, exercised infrastructure but legitimately lack MCP-
 * side consumers (e.g. `moflodb_*` is a lower-level controller surface;
 * `aidefence_*` is wired into the security stack via direct imports) live in
 * ALLOWLIST below with per-entry justifications.
 *
 * Failure mode: someone adds a new MCP tool with no consumer. They must
 * either wire a real call site or add the tool to ALLOWLIST with a
 * justification. Mirrors the SKILLS_MAP-integrity pattern from #690.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
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

  // Internal callers reach the tool via direct module import (lazy-load to
  // keep the diagnostic command-line fast) rather than through callMCPTool.
  // Consumers are real, just below the regex's radar.
  'hooks_intelligence_pattern-search': 'consumed by src/cli/commands/doctor.ts via direct hooks-tools import',
  'neural_status': 'consumed by src/cli/commands/diagnose.ts via direct neural-tools import',

  // Spell engine surface advertised to Claude as the permission-acceptance
  // entry point — runner.ts:146 prints "ask Claude to accept it, or call the
  // spell_accept tool with name X" so this IS the documented call site.
  'spell_accept': 'advertised in spell runner permission-acceptance flow',
};

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
        // tmp/ holds one-shot audit scripts (e.g. .claude/tmp/audit-693-*) that
        // intentionally enumerate stale tool names — exclude from drift guard.
        if (e === 'node_modules' || e === 'dist' || e === '.git' || e === 'tmp') continue;
        walk(full);
      } else if (st.isFile()) {
        if (SKIP_BASENAMES.has(e)) continue;
        if (st.size > MAX_FILE_BYTES) continue;
        if (full.endsWith('mcp-tools-deep.test.ts')) continue;
        if (full.endsWith('mcp-tools-drift-guard.test.ts')) continue;
        if (!/\.(ts|js|mjs|cjs|md|json|yaml|yml)$/i.test(full)) continue;
        let content: string;
        try { content = readFileSync(full, 'utf8'); } catch { continue; }
        // Pre-filter: most repo files mention neither marker.
        if (!content.includes('mcp__moflo__') && !content.includes('callMCPTool')) continue;
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

/**
 * Read tool-name constants from `src/cli/mcp-tools/tool-names.ts` so that
 * `callMCPTool(TOOL_FOO, ...)` indirections resolve to the underlying string.
 * Without this, deletion of a tool only consumed via its constant alias
 * (e.g. spell_template via TOOL_SPELL_TEMPLATE) ships a runtime "tool not
 * found" because the substring scan never sees the literal name.
 */
function loadToolNameConstants(): Map<string, string> {
  const path = join(TOOLS_DIR, 'tool-names.ts');
  const map = new Map<string, string>();
  let src: string;
  try { src = readFileSync(path, 'utf8'); } catch { return map; }
  const re = /export\s+const\s+(\w+)\s*=\s*['"]([\w-]+)['"]\s+as\s+const/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) map.set(m[1], m[2]);
  return map;
}

interface ConsumerIndex {
  /** tool name → set of files that reference it */
  byTool: Map<string, Set<string>>;
}

/**
 * One-pass scan: for each corpus file, harvest every `mcp__moflo__<name>` and
 * `callMCPTool(...'name'|CONST_NAME...)` reference and record (toolName, file).
 *
 * Single regex sweep per file replaces the previous O(tools × corpus) per-tool
 * scan. Exact-name matching via `Set.has` also fixes the substring bug where
 * `mcp__moflo__hooks_intelligence` falsely matched
 * `mcp__moflo__hooks_intelligence_pattern-store`.
 */
function buildConsumerIndex(corpus: CorpusEntry[]): ConsumerIndex {
  const constants = loadToolNameConstants();
  const tokenRe = /mcp__moflo__([a-z][a-z0-9_-]+)/g;
  // First capture: quoted literal. Second: SCREAMING_CONSTANT identifier.
  const callRe = /callMCPTool\b[^(]*\(\s*(?:['"]([\w-]+)['"]|([A-Z][A-Z0-9_]+))/g;
  const byTool = new Map<string, Set<string>>();
  const record = (name: string, path: string): void => {
    let files = byTool.get(name);
    if (!files) byTool.set(name, files = new Set());
    files.add(path);
  };
  for (const entry of corpus) {
    for (const m of entry.content.matchAll(tokenRe)) record(m[1], entry.path);
    for (const m of entry.content.matchAll(callRe)) {
      const name = m[1] ?? constants.get(m[2]!);
      if (name) record(name, entry.path);
    }
  }
  return { byTool };
}

let _index: ConsumerIndex | null = null;
function getConsumerIndex(): ConsumerIndex {
  return _index ??= buildConsumerIndex(getCorpus());
}

function findConsumers(tool: RegisteredTool): string[] {
  const files = getConsumerIndex().byTool.get(tool.name);
  if (!files) return [];
  return [...files].filter(f => f !== tool.ownerFile);
}

describe('MCP Tools Drift Guard (#693)', () => {
  // #847: warm the lazy corpus + consumer-index memos in beforeAll so the
  // ~350ms-in-isolation / 5s+-under-load AST work doesn't burn the per-test
  // 5s budget. Vitest's hookTimeout (10s) covers this comfortably.
  beforeAll(() => {
    getConsumerIndex(); // also triggers getCorpus() via buildConsumerIndex()
  });

  it('every registered MCP tool has a real consumer, allowlist, or follow-up entry', () => {
    const tools = collectRegisteredTools();
    expect(tools.length).toBeGreaterThan(0);

    const orphaned: Array<{ name: string; ownerFile: string }> = [];
    for (const tool of tools) {
      if (tool.name in ALLOWLIST) continue;
      const consumers = findConsumers(tool);
      if (consumers.length === 0) {
        orphaned.push({ name: tool.name, ownerFile: tool.ownerFile });
      }
    }

    if (orphaned.length > 0) {
      const message = orphaned
        .map(o => `  - ${o.name} (defined in ${o.ownerFile.split(/[\\/]/).slice(-3).join('/')})`)
        .join('\n');
      const hint = `\n\n${orphaned.length} MCP tool(s) registered with no consumer:\n${message}\n\nFix: either wire a real call site (mcp__moflo__<name> in a skill/agent .md, or callMCPTool('<name>') / callMCPTool(TOOL_X, ...) in CLI code), or add to ALLOWLIST with a justification.`;
      expect(orphaned, hint).toEqual([]);
    }
  });

  it('no allowlist entry references a tool that does not exist', () => {
    const tools = collectRegisteredTools();
    const registeredNames = new Set(tools.map(t => t.name));
    const stale = Object.keys(ALLOWLIST).filter(name => !registeredNames.has(name));
    expect(stale, `Allowlist references unknown tools: ${stale.join(', ')}`).toEqual([]);
  });

  it('every allowlist entry has a non-empty justification', () => {
    for (const [name, justification] of Object.entries(ALLOWLIST)) {
      expect(justification.trim().length, `${name} needs a justification`).toBeGreaterThan(10);
    }
  });

  // Files that reference `mcp__moflo__<prefix>` as a regex matcher (hook
  // event prefix, settings hook config) rather than a tool name. The
  // doc-side drift guard (#698) skips these so wildcard stems aren't flagged.
  const TOKEN_REGEX_SOURCE_BASENAMES: ReadonlySet<string> = new Set([
    'mcp-client.ts',
    'hook-wiring.ts',
    'settings-generator.ts',
    'moflo-init.ts',
    'settings.json',
  ]);
  const MCP_TOKEN_DIR = join('src', 'cli', 'mcp-tools') + sep;

  // Inverse direction (#698): every `mcp__moflo__<name>` token in any
  // skill / agent / doc file must resolve to a registered tool. This caught
  // ~210 stale tokens across 90+ files inherited from upstream forks
  // (memory_usage, sparc_mode, task_orchestrate, swarm_monitor, etc).
  it('every mcp__moflo__ token in skills/agents/docs names a registered tool', () => {
    const registered = new Set(collectRegisteredTools().map(t => t.name));
    // Family-prefix wildcards intentionally appear in guidance prose
    // (`mcp__moflo__memory_*`, `mcp__moflo__hooks_*`); the regex captures
    // them as `memory_`, `hooks_`, etc. Skip those.
    const isWildcardStem = (name: string): boolean => /^[a-z]+_$/.test(name);

    const orphans = new Map<string, string[]>();
    for (const entry of getCorpus()) {
      if (entry.path.includes(MCP_TOKEN_DIR)) continue;
      if (TOKEN_REGEX_SOURCE_BASENAMES.has(basename(entry.path))) continue;

      const seen = new Set<string>();
      // matchAll avoids the module-scoped /g regex `lastIndex` footgun.
      for (const m of entry.content.matchAll(/mcp__moflo__([a-zA-Z0-9_-]+)/g)) {
        const name = m[1];
        if (registered.has(name) || isWildcardStem(name) || seen.has(name)) continue;
        seen.add(name);
        if (!orphans.has(name)) orphans.set(name, []);
        orphans.get(name)!.push(entry.path);
      }
    }

    if (orphans.size > 0) {
      const lines = [...orphans.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, files]) => `  - mcp__moflo__${name} (${files.length} file(s); first: ${files[0]})`)
        .join('\n');
      const hint = `\n\n${orphans.size} stale MCP tool name(s) referenced in docs:\n${lines}\n\nFix: replace with the closest real tool, or remove the reference.`;
      expect([...orphans.keys()], hint).toEqual([]);
    }
  });
});
