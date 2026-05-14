/**
 * Fix 3 of #1132 — every moflo-shipped agent `.md` file must carry an
 * `## Operating context (moflo)` section. The section tells the spawned
 * Claude built-in agent which memory namespace to search and pins the
 * memory-first contract that Fix 1 now hard-enforces via the gate.
 *
 * "Shipped" = the YAML frontmatter declares `name:` (Claude Code's agent
 * registration field). README / TEMPLATE files in `.claude/agents/` without
 * frontmatter are skipped.
 *
 * If this test fires on a new agent file, run:
 *   `node scripts/insert-agent-operating-context.mjs`
 * which is idempotent and inserts the section after the frontmatter block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const AGENTS_DIR = resolve(__dirname, '../../.claude/agents');
const SECTION_HEADER = '## Operating context (moflo)';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function isShippedAgent(src: string): boolean {
  if (!src.startsWith('---')) return false;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return false;
  return /\n\s*name\s*:/.test(src.slice(0, end));
}

describe('shipped agents — operating-context section (#1132)', () => {
  const files = walk(AGENTS_DIR).sort();
  const shipped = files.filter(f => isShippedAgent(readFileSync(f, 'utf-8')));

  it('discovers at least one shipped agent (sanity check)', () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  for (const file of shipped) {
    it(`${file.slice(AGENTS_DIR.length + 1)} contains "${SECTION_HEADER}"`, () => {
      const src = readFileSync(file, 'utf-8');
      expect(src).toContain(SECTION_HEADER);
    });

    it(`${file.slice(AGENTS_DIR.length + 1)} names the memory-first contract`, () => {
      const src = readFileSync(file, 'utf-8');
      // Spot-check that the canonical phrasing made it in, not just the header.
      expect(src).toMatch(/mcp__moflo__memory_search/);
      expect(src).toMatch(/mcp__moflo__memory_get_neighbors/);
    });
  }
});

/**
 * The agent `.md` Operating context section and the runtime
 * `subagent-bootstrap.json` directive both deliver moflo's memory-first
 * contract — the former via Claude Code's agent-definition system context,
 * the latter via the SubagentStart hook's `additionalContext`. They are
 * delivered through different channels but must agree on the substantive
 * facts (namespace list + the load-bearing tool names) or subagents will see
 * conflicting instructions depending on how they were spawned.
 */
describe('agent .md ↔ subagent-bootstrap parity (#1132)', () => {
  const BOOTSTRAP_PATH = resolve(__dirname, '../../.claude/helpers/subagent-bootstrap.json');
  const directive = (JSON.parse(readFileSync(BOOTSTRAP_PATH, 'utf-8')) as { directive: string }).directive;
  const sampleAgent = readFileSync(resolve(AGENTS_DIR, 'core/coder.md'), 'utf-8');

  it('both name the canonical memory tools', () => {
    expect(directive).toContain('mcp__moflo__memory_search');
    expect(directive).toContain('mcp__moflo__memory_get_neighbors');
    expect(sampleAgent).toContain('mcp__moflo__memory_search');
    expect(sampleAgent).toContain('mcp__moflo__memory_get_neighbors');
  });

  it.each(['guidance', 'code-map', 'patterns', 'learnings', 'tests'])(
    'both list the "%s" namespace',
    (ns) => {
      expect(directive).toContain(ns);
      expect(sampleAgent).toContain(ns);
    },
  );

  it('both reference the memory-protocol guidance doc', () => {
    expect(directive).toContain('moflo-memory-protocol.md');
    expect(sampleAgent).toContain('moflo-memory-protocol.md');
  });
});
