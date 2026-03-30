/**
 * Workflow MCP Tools — Engine Integration Tests
 *
 * Story #225: Verifies that MCP workflow tool handlers call the real
 * workflow engine via runner-bridge, not a mock file-based store.
 */

import { describe, it, expect } from 'vitest';
import { workflowTools } from '../src/mcp-tools/workflow-tools.js';

function findTool(name: string) {
  const tool = workflowTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe('Workflow MCP Tools — Engine Integration', () => {
  // -------------------------------------------------------------------------
  // Tool registration
  // -------------------------------------------------------------------------

  it('exports exactly 10 workflow tools', () => {
    expect(workflowTools).toHaveLength(10);
    const names = workflowTools.map(t => t.name).sort();
    expect(names).toEqual([
      'workflow_cancel',
      'workflow_create',
      'workflow_delete',
      'workflow_execute',
      'workflow_list',
      'workflow_pause',
      'workflow_resume',
      'workflow_run',
      'workflow_status',
      'workflow_template',
    ]);
  });

  it('all tools have category "workflow"', () => {
    for (const tool of workflowTools) {
      expect(tool.category).toBe('workflow');
    }
  });

  // -------------------------------------------------------------------------
  // workflow_create — returns a definition, not a file-based record
  // -------------------------------------------------------------------------

  it('workflow_create returns a definition object with steps', async () => {
    const tool = findTool('workflow_create');
    const result: any = await tool.handler({
      name: 'test-create',
      description: 'Integration test workflow',
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
    // Should NOT have a workflowId (that's the old mock-store pattern)
    expect(result.workflowId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // workflow_run — requires content, file, or name (no hardcoded templates)
  // -------------------------------------------------------------------------

  it('workflow_run returns error when no source provided', async () => {
    const tool = findTool('workflow_run');
    const result: any = await tool.handler({});
    expect(result.error).toMatch(/name.*file.*content.*required/i);
  });

  it('workflow_run returns error for non-existent file', async () => {
    const tool = findTool('workflow_run');
    const result: any = await tool.handler({ file: '/tmp/nonexistent-workflow-xyz.yaml' });
    expect(result.error).toMatch(/not found/i);
  });

  it('workflow_run executes inline YAML content via engine', async () => {
    const tool = findTool('workflow_run');
    const yamlContent = `
name: inline-test
steps:
  - id: step-1
    type: bash
    config:
      command: echo engine-ok
`;
    const result: any = await tool.handler({ content: yamlContent });

    // Engine returns a structured WorkflowResult
    expect(result.workflowId).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.steps).toBeDefined();
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0].stepType).toBe('bash');
    expect(result.steps[0].status).toBe('succeeded');
    // Engine output includes real data (not mock { executed: true })
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('workflow_run dry-run validates without executing', async () => {
    const tool = findTool('workflow_run');
    const yamlContent = `
name: dryrun-test
steps:
  - id: step-1
    type: bash
    config:
      command: echo should-not-run
`;
    const result: any = await tool.handler({ content: yamlContent, dryRun: true });
    expect(result.workflowId).toBeDefined();
    // Dry run returns a result structure (validated, not executed)
    expect(result.cancelled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // workflow_execute — takes a definition object
  // -------------------------------------------------------------------------

  it('workflow_execute runs a definition via the engine', async () => {
    const tool = findTool('workflow_execute');
    const definition = {
      name: 'execute-test',
      steps: [
        { id: 'step-1', type: 'bash', config: { command: 'echo executed' } },
      ],
    };
    const result: any = await tool.handler({ definition });

    expect(result.workflowId).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe('succeeded');
  });

  it('workflow_execute returns error for invalid definition', async () => {
    const tool = findTool('workflow_execute');
    const result: any = await tool.handler({ definition: { name: null, steps: null } });
    expect(result.error).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // workflow_status — tracks results from engine runs
  // -------------------------------------------------------------------------

  it('workflow_status returns not-found for unknown ID', async () => {
    const tool = findTool('workflow_status');
    const result: any = await tool.handler({ workflowId: 'nonexistent-id' });
    expect(result.error).toMatch(/not found/i);
  });

  it('workflow_status returns result for completed workflow', async () => {
    // First, run a workflow to get a tracked ID
    const runTool = findTool('workflow_run');
    const runResult: any = await runTool.handler({
      content: 'name: status-test\nsteps:\n  - id: s1\n    type: bash\n    config:\n      command: echo ok',
    });
    const workflowId = runResult.workflowId;

    // Now query status
    const statusTool = findTool('workflow_status');
    const statusResult: any = await statusTool.handler({ workflowId, verbose: true });

    expect(statusResult.workflowId).toBe(workflowId);
    expect(statusResult.status).toBe('completed');
    expect(statusResult.success).toBe(true);
    expect(statusResult.steps).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // workflow_list — returns registry definitions and tracked runs
  // -------------------------------------------------------------------------

  it('workflow_list returns runs array', async () => {
    const tool = findTool('workflow_list');
    const result: any = await tool.handler({ source: 'runs' });
    expect(result.runs).toBeDefined();
    expect(Array.isArray(result.runs)).toBe(true);
  });

  it('workflow_list returns activeWorkflows array', async () => {
    const tool = findTool('workflow_list');
    const result: any = await tool.handler({ source: 'all' });
    expect(result.activeWorkflows).toBeDefined();
    expect(Array.isArray(result.activeWorkflows)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // workflow_cancel — uses engine AbortController
  // -------------------------------------------------------------------------

  it('workflow_cancel returns not-found for unknown ID', async () => {
    const tool = findTool('workflow_cancel');
    const result: any = await tool.handler({ workflowId: 'nonexistent' });
    expect(result.error).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // workflow_delete — removes from tracked map
  // -------------------------------------------------------------------------

  it('workflow_delete returns deleted=false for unknown ID', async () => {
    const tool = findTool('workflow_delete');
    const result: any = await tool.handler({ workflowId: 'nonexistent' });
    expect(result.deleted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // workflow_pause — honest about limitations
  // -------------------------------------------------------------------------

  it('workflow_pause returns error for non-running workflow', async () => {
    const tool = findTool('workflow_pause');
    const result: any = await tool.handler({ workflowId: 'nonexistent' });
    expect(result.error).toMatch(/not running/i);
  });

  // -------------------------------------------------------------------------
  // workflow_resume — honest about limitations
  // -------------------------------------------------------------------------

  it('workflow_resume returns error for unknown workflow', async () => {
    const tool = findTool('workflow_resume');
    const result: any = await tool.handler({ workflowId: 'nonexistent' });
    expect(result.error).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // workflow_template — delegates to registry
  // -------------------------------------------------------------------------

  it('workflow_template list returns templates array', async () => {
    const tool = findTool('workflow_template');
    const result: any = await tool.handler({ action: 'list' });
    expect(result.action).toBe('list');
    expect(result.templates).toBeDefined();
    expect(Array.isArray(result.templates)).toBe(true);
  });

  it('workflow_template info returns error for unknown workflow', async () => {
    const tool = findTool('workflow_template');
    const result: any = await tool.handler({ action: 'info', query: 'nonexistent-workflow-xyz' });
    expect(result.error).toMatch(/not found/i);
  });

  it('workflow_template with unknown action returns error', async () => {
    const tool = findTool('workflow_template');
    const result: any = await tool.handler({ action: 'unknown' });
    expect(result.error).toMatch(/unknown action/i);
  });

  // -------------------------------------------------------------------------
  // Critical assertion: No file-based store
  // -------------------------------------------------------------------------

  it('does not import or reference store.json', async () => {
    // Read the source file and verify no references to the old mock store
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/mcp-tools/workflow-tools.ts'),
      'utf-8',
    );
    expect(source).not.toContain('store.json');
    expect(source).not.toContain('WORKFLOW_FILE');
    expect(source).not.toContain('saveWorkflowStore');
    expect(source).not.toContain('loadWorkflowStore');
    // Verify it references the engine bridge
    expect(source).toContain('bridgeRunWorkflow');
    expect(source).toContain('bridgeExecuteWorkflow');
    expect(source).toContain('bridgeCancelWorkflow');
    expect(source).toContain('WorkflowRegistry');
  });
});
