/**
 * Spell MCP Tools — Engine Integration Tests
 *
 * Story #225: Verifies that MCP spell tool handlers call the real
 * spell engine via runner-bridge, not a mock file-based store.
 * Story #371: Renamed workflow_* tools to spell_* with wizard terminology.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spellTools, invalidateRegistry } from '../mcp-tools/spell-tools.js';

// Disable sandbox at the engine layer so the bash steps below run unsandboxed
// regardless of host capability. Without this, sandbox.enabled=true in the
// project's moflo.yaml + Windows-without-Docker makes the engine bail out on
// the prerequisite check before any step runs.
const ORIGINAL_SANDBOX_ENV = process.env.MOFLO_SANDBOX_DISABLED;
beforeAll(() => { process.env.MOFLO_SANDBOX_DISABLED = '1'; });
afterAll(() => {
  if (ORIGINAL_SANDBOX_ENV === undefined) delete process.env.MOFLO_SANDBOX_DISABLED;
  else process.env.MOFLO_SANDBOX_DISABLED = ORIGINAL_SANDBOX_ENV;
});

function findTool(name: string) {
  const tool = spellTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe('Spell MCP Tools — Engine Integration', () => {
  // -------------------------------------------------------------------------
  // Tool registration
  // -------------------------------------------------------------------------

  it('exports exactly 11 spell tools', () => {
    expect(spellTools).toHaveLength(11);
    const names = spellTools.map(t => t.name).sort();
    expect(names).toEqual([
      'spell_accept',
      'spell_cancel',
      'spell_cast',
      'spell_create',
      'spell_delete',
      'spell_execute',
      'spell_list',
      'spell_resume',
      'spell_status',
      'spell_suspend',
      'spell_template',
    ]);
  });

  it('all tools have category "spell"', () => {
    for (const tool of spellTools) {
      expect(tool.category).toBe('spell');
    }
  });

  // -------------------------------------------------------------------------
  // spell_create — returns a definition, not a file-based record
  // -------------------------------------------------------------------------

  it('spell_create returns a definition object with steps', async () => {
    const tool = findTool('spell_create');
    const result: any = await tool.handler({
      name: 'test-create',
      description: 'Integration test spell',
      steps: [
        { id: 'step-1', type: 'bash', config: { command: 'echo hello' } },
        { id: 'step-2', type: 'bash', config: { command: 'echo world' } },
      ],
    });

    expect(result.name).toBe('test-create');
    expect(result.stepCount).toBe(2);
    expect(result.definition).toBeDefined();
    expect(result.definition.name).toBe('test-create');
    expect(result.definition.steps).toHaveLength(2);
    expect(result.definition.steps[0].id).toBe('step-1');
    expect(result.definition.steps[0].type).toBe('bash');
    // Should NOT have a spellId (that's the old mock-store pattern)
    expect(result.spellId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // spell_cast — requires content, file, or name (no hardcoded templates)
  // -------------------------------------------------------------------------

  it('spell_cast returns error when no source provided', async () => {
    const tool = findTool('spell_cast');
    const result: any = await tool.handler({});
    expect(result.error).toMatch(/name.*file.*content.*required/i);
  });

  it('spell_cast returns error for non-existent file', async () => {
    const tool = findTool('spell_cast');
    const result: any = await tool.handler({ file: '/tmp/nonexistent-workflow-xyz.yaml' });
    expect(result.error).toMatch(/not found/i);
  });

  it('spell_cast executes inline YAML content via engine', { timeout: 15_000 }, async () => {
    const tool = findTool('spell_cast');
    const yamlContent = `
name: inline-test
steps:
  - id: step-1
    type: bash
    config:
      command: echo engine-ok
`;
    const result: any = await tool.handler({ content: yamlContent });

    // Engine returns a structured SpellResult
    expect(result.spellId).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.steps).toBeDefined();
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].stepType).toBe('bash');
    expect(result.steps[0].status).toBe('succeeded');
    // Engine output includes real data (not mock { executed: true })
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('spell_cast dry-run validates without executing', async () => {
    const tool = findTool('spell_cast');
    const yamlContent = `
name: dryrun-test
steps:
  - id: step-1
    type: bash
    config:
      command: echo should-not-run
`;
    const result: any = await tool.handler({ content: yamlContent, dryRun: true });
    expect(result.spellId).toBeDefined();
    // Dry run returns a result structure (validated, not executed)
    expect(result.cancelled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // spell_execute — takes a definition object
  // -------------------------------------------------------------------------

  it('spell_execute runs a definition via the engine', { timeout: 15_000 }, async () => {
    const tool = findTool('spell_execute');
    const definition = {
      name: 'execute-test',
      steps: [
        { id: 'step-1', type: 'bash', config: { command: 'echo executed' } },
      ],
    };
    const result: any = await tool.handler({ definition });

    expect(result.spellId).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('succeeded');
  });

  it('spell_execute returns error for invalid definition', async () => {
    const tool = findTool('spell_execute');
    const result: any = await tool.handler({ definition: { name: null, steps: null } });
    expect(result.error).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // spell_status — tracks results from engine runs
  // -------------------------------------------------------------------------

  it('spell_status returns not-found for unknown ID', async () => {
    const tool = findTool('spell_status');
    const result: any = await tool.handler({ spellId: 'nonexistent-id' });
    expect(result.error).toMatch(/not found/i);
  });

  it('spell_status returns result for completed spell', { timeout: 15_000 }, async () => {
    // First, cast a spell to get a tracked ID
    const runTool = findTool('spell_cast');
    const runResult: any = await runTool.handler({
      content: 'name: status-test\nsteps:\n  - id: s1\n    type: bash\n    config:\n      command: echo ok',
    });
    const spellId = runResult.spellId;

    // Now query status
    const statusTool = findTool('spell_status');
    const statusResult: any = await statusTool.handler({ spellId, verbose: true });

    expect(statusResult.spellId).toBe(spellId);
    expect(statusResult.status).toBe('completed');
    expect(statusResult.success).toBe(true);
    expect(statusResult.steps).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // spell_list — returns grimoire definitions and tracked castings
  // -------------------------------------------------------------------------

  it('spell_list returns runs array', async () => {
    const tool = findTool('spell_list');
    const result: any = await tool.handler({ source: 'runs' });
    expect(result.runs).toBeDefined();
    expect(Array.isArray(result.runs)).toBe(true);
  });

  it('spell_list returns activeSpells array', async () => {
    const tool = findTool('spell_list');
    const result: any = await tool.handler({ source: 'all' });
    expect(result.activeSpells).toBeDefined();
    expect(Array.isArray(result.activeSpells)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // spell_cancel — uses engine AbortController
  // -------------------------------------------------------------------------

  it('spell_cancel returns not-found for unknown ID', async () => {
    const tool = findTool('spell_cancel');
    const result: any = await tool.handler({ spellId: 'nonexistent' });
    expect(result.error).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // spell_delete — removes from tracked map
  // -------------------------------------------------------------------------

  it('spell_delete returns deleted=false for unknown ID', async () => {
    const tool = findTool('spell_delete');
    const result: any = await tool.handler({ spellId: 'nonexistent' });
    expect(result.deleted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // spell_suspend — honest about limitations
  // -------------------------------------------------------------------------

  it('spell_suspend returns error for non-active spell', async () => {
    const tool = findTool('spell_suspend');
    const result: any = await tool.handler({ spellId: 'nonexistent' });
    expect(result.error).toMatch(/not.*active/i);
  });

  // -------------------------------------------------------------------------
  // spell_resume — honest about limitations
  // -------------------------------------------------------------------------

  it('spell_resume returns error for unknown spell', async () => {
    const tool = findTool('spell_resume');
    const result: any = await tool.handler({ spellId: 'nonexistent' });
    expect(result.error).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // spell_template — delegates to grimoire
  // -------------------------------------------------------------------------

  it('spell_template list returns templates array', async () => {
    const tool = findTool('spell_template');
    const result: any = await tool.handler({ action: 'list' });
    expect(result.action).toBe('list');
    expect(result.templates).toBeDefined();
    expect(Array.isArray(result.templates)).toBe(true);
  });

  it('spell_template info returns error for unknown spell', async () => {
    const tool = findTool('spell_template');
    const result: any = await tool.handler({ action: 'info', query: 'nonexistent-workflow-xyz' });
    expect(result.error).toMatch(/not found/i);
  });

  it('spell_template with unknown action returns error', async () => {
    const tool = findTool('spell_template');
    const result: any = await tool.handler({ action: 'unknown' });
    expect(result.error).toMatch(/unknown action/i);
  });

  // -------------------------------------------------------------------------
  // Registry invalidation (Story #231)
  // -------------------------------------------------------------------------

  it('spell_list with refresh=true returns refreshed=true', async () => {
    const tool = findTool('spell_list');
    const result: any = await tool.handler({ source: 'registry', refresh: true });
    expect(result.refreshed).toBe(true);
    expect(result.definitions).toBeDefined();
  });

  it('spell_list without refresh does not include refreshed flag', async () => {
    const tool = findTool('spell_list');
    const result: any = await tool.handler({ source: 'registry' });
    expect(result.refreshed).toBeUndefined();
  });

  it('invalidateRegistry can be called without error when no instance exists', () => {
    // Clear any existing instance first, then call again — should not throw
    invalidateRegistry();
    invalidateRegistry();
  });

  it('registry returns fresh data after invalidation', async () => {
    const tool = findTool('spell_list');

    // First call loads and caches the registry
    const first: any = await tool.handler({ source: 'registry' });
    expect(first.definitions).toBeDefined();

    // Refresh forces a re-scan — should still return valid data
    const second: any = await tool.handler({ source: 'registry', refresh: true });
    expect(second.refreshed).toBe(true);
    expect(second.definitions).toBeDefined();
    // Same shipped definitions should be present
    expect(second.definitions.length).toBe(first.definitions.length);
  });

  // -------------------------------------------------------------------------
  // Critical assertion: No file-based store
  // -------------------------------------------------------------------------

  it('does not import or reference store.json', async () => {
    // Read the source file and verify no references to the old mock store
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../mcp-tools/spell-tools.ts'),
      'utf-8',
    );
    expect(source).not.toContain('store.json');
    expect(source).not.toContain('WORKFLOW_FILE');
    expect(source).not.toContain('saveWorkflowStore');
    expect(source).not.toContain('loadWorkflowStore');
    // Verify it references the engine bridge
    expect(source).toContain('bridgeRunSpell');
    expect(source).toContain('bridgeExecuteSpell');
    expect(source).toContain('bridgeCancelSpell');
    expect(source).toContain('Grimoire');
  });
});
