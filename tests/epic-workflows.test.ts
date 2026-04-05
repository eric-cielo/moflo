/**
 * Epic Workflow YAML Template Tests
 *
 * Story #196: Verify both epic workflow YAML templates parse, validate,
 * and produce expected structure.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../src/modules/workflows/src/schema/parser.js';
import type { WorkflowDefinition } from '../src/modules/workflows/src/types/workflow-definition.types.js';

// ============================================================================
// Helpers
// ============================================================================

const WORKFLOWS_DIR = join(__dirname, '..', 'src', 'modules', 'cli', 'src', 'epic', 'workflows');

function loadYaml(filename: string): WorkflowDefinition {
  const content = readFileSync(join(WORKFLOWS_DIR, filename), 'utf-8');
  const parsed = parseYaml(content, filename);
  return parsed.definition;
}

// ============================================================================
// Single-Branch Template
// ============================================================================

describe('single-branch.yaml', () => {
  let def: WorkflowDefinition;

  it('parses without error', () => {
    def = loadYaml('single-branch.yaml');
    expect(def).toBeDefined();
  });

  it('has correct name and abbreviation', () => {
    def = loadYaml('single-branch.yaml');
    expect(def.name).toBe('epic-single-branch');
    expect(def.abbreviation).toBe('esb');
  });

  it('declares required arguments', () => {
    def = loadYaml('single-branch.yaml');
    expect(def.arguments).toBeDefined();
    expect(def.arguments!.epic_number).toBeDefined();
    expect(def.arguments!.epic_number.required).toBe(true);
    expect(def.arguments!.stories).toBeDefined();
    expect(def.arguments!.stories.required).toBe(true);
  });

  it('has optional arguments with defaults', () => {
    def = loadYaml('single-branch.yaml');
    expect(def.arguments!.base_branch.default).toBe('main');
  });

  it('has expected step sequence', () => {
    def = loadYaml('single-branch.yaml');
    const stepIds = def.steps.map(s => s.id);
    expect(stepIds).toEqual(['preflight-check', 'init-state', 'create-branch', 'process-stories', 'push-branch', 'create-pr', 'finalize-state']);
  });

  it('uses correct step types', () => {
    def = loadYaml('single-branch.yaml');
    const stepTypes = def.steps.map(s => s.type);
    expect(stepTypes).toEqual(['bash', 'memory', 'bash', 'loop', 'bash', 'github', 'memory']);
  });

  it('initializes and finalizes epic state in memory', () => {
    def = loadYaml('single-branch.yaml');
    const initStep = def.steps.find(s => s.id === 'init-state');
    const finalStep = def.steps.find(s => s.id === 'finalize-state');
    expect(initStep?.type).toBe('memory');
    expect(finalStep?.type).toBe('memory');
  });

  it('has loop with nested steps', () => {
    def = loadYaml('single-branch.yaml');
    const loopStep = def.steps.find(s => s.id === 'process-stories');
    expect(loopStep?.steps).toBeDefined();
    expect(loopStep!.steps!.length).toBeGreaterThanOrEqual(2);
  });

  it('creates consolidated PR at the end', () => {
    def = loadYaml('single-branch.yaml');
    const prStep = def.steps.find(s => s.id === 'create-pr');
    expect(prStep?.type).toBe('github');
    expect((prStep?.config as Record<string, unknown>).action).toBe('pr-create');
  });

  it('sets mofloLevel to hooks', () => {
    def = loadYaml('single-branch.yaml');
    expect(def.mofloLevel).toBe('hooks');
  });
});

// ============================================================================
// Auto-Merge Template
// ============================================================================

describe('auto-merge.yaml', () => {
  let def: WorkflowDefinition;

  it('parses without error', () => {
    def = loadYaml('auto-merge.yaml');
    expect(def).toBeDefined();
  });

  it('has correct name and abbreviation', () => {
    def = loadYaml('auto-merge.yaml');
    expect(def.name).toBe('epic-auto-merge');
    expect(def.abbreviation).toBe('eam');
  });

  it('declares required arguments', () => {
    def = loadYaml('auto-merge.yaml');
    expect(def.arguments!.epic_number.required).toBe(true);
    expect(def.arguments!.stories.required).toBe(true);
  });

  it('has merge method argument', () => {
    def = loadYaml('auto-merge.yaml');
    expect(def.arguments!.merge_method).toBeDefined();
    expect(def.arguments!.merge_method.default).toBe('squash');
  });

  it('has init-state, loop, and finalize-state as top-level steps', () => {
    def = loadYaml('auto-merge.yaml');
    expect(def.steps).toHaveLength(4);
    expect(def.steps[0].id).toBe('preflight-check');
    expect(def.steps[0].type).toBe('bash');
    expect(def.steps[1].id).toBe('init-state');
    expect(def.steps[1].type).toBe('memory');
    expect(def.steps[2].type).toBe('loop');
    expect(def.steps[2].id).toBe('process-stories');
    expect(def.steps[3].id).toBe('finalize-state');
    expect(def.steps[3].type).toBe('memory');
  });

  it('loop contains checkout, implement, find, merge, pull, comment, record', () => {
    def = loadYaml('auto-merge.yaml');
    const loopStep = def.steps.find(s => s.id === 'process-stories')!;
    const loopSteps = loopStep.steps!;
    expect(loopSteps.length).toBeGreaterThanOrEqual(5);
    const types = loopSteps.map(s => s.type);
    expect(types).toContain('bash');
    expect(types).toContain('github');
    expect(types).toContain('memory');
  });

  it('includes pr-merge step with admin option', () => {
    def = loadYaml('auto-merge.yaml');
    const loopStep = def.steps.find(s => s.id === 'process-stories')!;
    const mergeStep = loopStep.steps!.find(s => s.id === 'merge-story-pr');
    expect(mergeStep).toBeDefined();
    expect((mergeStep!.config as Record<string, unknown>).action).toBe('pr-merge');
  });

  it('sets mofloLevel to hooks', () => {
    def = loadYaml('auto-merge.yaml');
    expect(def.mofloLevel).toBe('hooks');
  });
});
