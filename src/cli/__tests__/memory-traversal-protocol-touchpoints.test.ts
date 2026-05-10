/**
 * #1053 S3: Memory traversal protocol must reach agents through all 6
 * touchpoints. Each one carries a substring crumb pointing at
 * `moflo-memory-protocol.md` (or naming `memory_get_neighbors`). If any
 * touchpoint loses its crumb during a refactor, the protocol stops
 * reaching one of: bootstrap-injected subagents, gate-blocked callers,
 * schema-only MCP callers, or main-agent CLAUDE.md readers.
 *
 * Per the conciseness mandate: each crumb is the minimum that still
 * routes the agent to the canonical doc.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateClaudeMd } from '../init/claudemd-generator.js';

const ROOT = resolve(__dirname, '../../..');

const CANONICAL = '.claude/guidance/shipped/moflo-memory-protocol.md';
const NEIGHBORS_TOOL = 'memory_get_neighbors';

describe('Memory traversal protocol — 6-touchpoint drift guards (#1053 S3)', () => {
  it('Touchpoint #0 — canonical protocol doc exists and is ≤40 lines', () => {
    const docPath = resolve(ROOT, CANONICAL);
    expect(existsSync(docPath)).toBe(true);
    const text = readFileSync(docPath, 'utf-8');
    const lineCount = text.split('\n').length;
    expect(lineCount, `protocol doc grew past 40-line cap (${lineCount}); compress before adding`).toBeLessThanOrEqual(40);
  });

  it('Touchpoint #1 — subagent-bootstrap.json directive references neighbors + protocol doc', () => {
    const json = JSON.parse(readFileSync(resolve(ROOT, '.claude/helpers/subagent-bootstrap.json'), 'utf-8')) as { directive: string };
    expect(json.directive).toContain(NEIGHBORS_TOOL);
    expect(json.directive).toContain('moflo-memory-protocol.md');
  });

  it('Touchpoint #2 — moflo-agent-rules.md cites the protocol doc and neighbors tool', () => {
    const md = readFileSync(resolve(ROOT, '.claude/guidance/shipped/moflo-agent-rules.md'), 'utf-8');
    expect(md).toContain('moflo-memory-protocol.md');
    expect(md).toContain(NEIGHBORS_TOOL);
  });

  it('Touchpoint #3 — moflo-subagents.md cites the protocol doc and neighbors tool', () => {
    const md = readFileSync(resolve(ROOT, '.claude/guidance/shipped/moflo-subagents.md'), 'utf-8');
    expect(md).toContain('moflo-memory-protocol.md');
    expect(md).toContain(NEIGHBORS_TOOL);
  });

  it('Touchpoint #4 — generated CLAUDE.md injection cites the protocol doc and neighbors tool', () => {
    const generated = generateClaudeMd({ name: 'test-app', languages: ['typescript'] });
    expect(generated).toContain('moflo-memory-protocol.md');
    expect(generated).toContain(NEIGHBORS_TOOL);
  });

  it('Touchpoint #5 — gate.cjs messages all carry the traversal crumb', () => {
    const src = readFileSync(resolve(ROOT, '.claude/helpers/gate.cjs'), 'utf-8');
    // The three messages: agent-spawn reminder, scan block, read block.
    // Each must mention the neighbors tool by name AND the protocol doc.
    const occurrences = (src.match(/moflo-memory-protocol\.md/g) || []).length;
    expect(occurrences, 'expected 3 gate messages with the crumb (agent-spawn reminder, scan block, read block)').toBeGreaterThanOrEqual(3);
    const neighborsOccurrences = (src.match(new RegExp(NEIGHBORS_TOOL, 'g')) || []).length;
    expect(neighborsOccurrences).toBeGreaterThanOrEqual(3);
  });

  it('Touchpoint #6 — memory-tools.ts descriptions mention the traversal pathway', async () => {
    // Drive the registration runtime instead of regex-scanning the source —
    // the registry IS the contract; source layout can drift.
    const { memoryTools } = await import('../mcp-tools/memory-tools.js');
    const get = (name: string): string => {
      const t = (memoryTools as Array<{ name: string; description: string }>).find(x => x.name === name);
      if (!t) throw new Error(`${name} not registered`);
      return t.description;
    };
    expect(get('memory_search')).toContain(NEIGHBORS_TOOL);
    expect(get('memory_retrieve')).toContain(NEIGHBORS_TOOL);
    // The neighbors tool itself must be registered.
    expect(() => get('memory_get_neighbors')).not.toThrow();
  });
});
