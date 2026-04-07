/**
 * Workflow Builder Skill — Content Validation Tests
 *
 * Validates that the SKILL.md file is well-formed and contains
 * all required sections for creating, editing, and validating
 * workflow definitions.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_PATH = path.resolve(__dirname, '../../.claude/skills/workflow-builder/SKILL.md');

describe('workflow-builder skill', () => {
  let content: string;
  let fmName: string;
  let fmDescription: string;

  beforeAll(() => {
    content = fs.readFileSync(SKILL_PATH, 'utf-8');

    const fm = content.match(/^---\r?\n([\s\S]*?)---/);
    expect(fm).not.toBeNull();
    const nameMatch = fm![1].match(/name:\s*"([^"]+)"/);
    const descMatch = fm![1].match(/description:\s*"([^"]+)"/);
    expect(nameMatch).not.toBeNull();
    expect(descMatch).not.toBeNull();
    fmName = nameMatch![1];
    fmDescription = descMatch![1];
  });

  describe('file structure', () => {
    it('exists and is non-empty', () => {
      expect(fs.existsSync(SKILL_PATH)).toBe(true);
      expect(content.length).toBeGreaterThan(100);
    });
  });

  describe('YAML frontmatter', () => {
    it('starts with YAML frontmatter delimiters', () => {
      expect(content.startsWith('---\r\n') || content.startsWith('---\n')).toBe(true);
    });

    it('has a name field under 64 characters', () => {
      expect(fmName.length).toBeLessThanOrEqual(64);
      expect(fmName.length).toBeGreaterThan(0);
    });

    it('has a description field under 1024 characters', () => {
      expect(fmDescription.length).toBeLessThanOrEqual(1024);
    });

    it('description mentions workflows', () => {
      const desc = fmDescription.toLowerCase();
      expect(desc).toContain('workflow');
    });

    it('description includes a "when" trigger clause', () => {
      const desc = fmDescription.toLowerCase();
      expect(desc).toMatch(/use when|when building|when creating|when modifying/);
    });
  });

  describe('workflow creation guidance', () => {
    it('has a workflow creation section', () => {
      expect(content).toMatch(/Create a New Workflow/i);
    });

    it('documents required metadata fields in gather step', () => {
      expect(content).toContain('**Name**');
      expect(content).toContain('**Description**');
    });

    it('documents optional metadata fields', () => {
      expect(content).toContain('abbreviation');
      expect(content).toContain('description');
      expect(content).toContain('version');
    });

    it('documents mofloLevel values', () => {
      expect(content).toContain('`none`');
      expect(content).toContain('`memory`');
      expect(content).toContain('`hooks`');
      expect(content).toContain('`full`');
      expect(content).toContain('`recursive`');
    });

    it('documents argument types', () => {
      expect(content).toContain('`string`');
      expect(content).toContain('`number`');
      expect(content).toContain('`boolean`');
      expect(content).toContain('`string[]`');
    });

    it('documents argument fields (required, default, enum)', () => {
      expect(content).toMatch(/required/i);
      expect(content).toMatch(/default/i);
      expect(content).toMatch(/enum/i);
    });
  });

  describe('step definition guidance', () => {
    it('documents step fields: id, type, config, output', () => {
      expect(content).toContain('**ID**');
      expect(content).toContain('**Type**');
      expect(content).toContain('**Config**');
      expect(content).toContain('**Output**');
    });

    it('documents continueOnError option', () => {
      expect(content).toContain('Continue on Error');
    });
  });

  describe('variable reference syntax', () => {
    it('documents {args.name} syntax', () => {
      expect(content).toContain('{args.');
    });

    it('documents {credentials.NAME} syntax', () => {
      expect(content).toContain('{credentials.');
    });

    it('documents {stepId.outputKey} syntax', () => {
      expect(content).toContain('{stepId.');
    });
  });

  describe('built-in step commands', () => {
    it('lists all 9 built-in step command types', () => {
      const stepTypes = [
        'agent', 'bash', 'condition', 'prompt',
        'memory', 'wait', 'loop', 'browser', 'github',
      ];
      for (const type of stepTypes) {
        expect(content).toContain(`\`${type}\``);
      }
    });

    it('references the commands source file', () => {
      expect(content).toContain('commands/index.ts');
    });
  });

  describe('built-in connectors', () => {
    it('lists all 3 built-in connectors', () => {
      const connectorNames = ['http', 'github-cli', 'playwright'];
      for (const name of connectorNames) {
        expect(content).toContain(`\`${name}\``);
      }
    });

    it('references the connectors source file', () => {
      expect(content).toContain('connectors/index.ts');
    });
  });

  describe('workflow editing guidance', () => {
    it('has an editing section', () => {
      expect(content).toMatch(/Edit an Existing Workflow/i);
    });

    it('documents add step operation', () => {
      expect(content).toMatch(/add step/i);
    });

    it('documents remove step operation', () => {
      expect(content).toMatch(/remove step/i);
    });

    it('documents reorder steps operation', () => {
      expect(content).toMatch(/reorder step/i);
    });

    it('documents updating step config', () => {
      expect(content).toMatch(/update step config/i);
    });
  });

  describe('validation guidance', () => {
    it('has a validation section', () => {
      expect(content).toMatch(/Validate an Existing Workflow|Run Validation/i);
    });

    it('documents validation rules for required fields and step integrity', () => {
      expect(content).toMatch(/`name`.*required/is);
      expect(content).toMatch(/steps.*non-empty/is);
    });

    it('documents unique step IDs rule', () => {
      expect(content).toMatch(/unique.*id|no duplicate/is);
    });

    it('documents forward reference detection', () => {
      expect(content).toMatch(/forward reference/i);
    });

    it('documents circular jump detection', () => {
      expect(content).toMatch(/circular/i);
    });

    it('documents mofloLevel escalation constraint', () => {
      expect(content).toMatch(/cannot exceed|can only narrow/i);
    });

    it('references the validator source', () => {
      expect(content).toContain('validator.ts');
    });
  });

  describe('complete workflow example', () => {
    it('includes at least one complete YAML example', () => {
      const yamlBlocks = content.match(/```yaml[\s\S]*?```/g);
      expect(yamlBlocks).not.toBeNull();
      expect(yamlBlocks!.length).toBeGreaterThan(0);
    });

    it('example includes name, steps, and arguments', () => {
      expect(content).toMatch(/```yaml[\s\S]*?name:[\s\S]*?arguments:[\s\S]*?steps:[\s\S]*?```/);
    });
  });

  describe('cross-references', () => {
    it('references /connector-builder skill', () => {
      expect(content).toContain('/connector-builder');
      expect(content).toContain('#238');
    });

    it('references MCP workflow_create tool', () => {
      expect(content).toContain('mcp__moflo__workflow_create');
    });

    it('references MCP workflow_list tool', () => {
      expect(content).toContain('mcp__moflo__workflow_list');
    });
  });

  describe('type definition references', () => {
    it('references SpellDefinition type', () => {
      expect(content).toContain('SpellDefinition');
    });

    it('references StepDefinition type', () => {
      expect(content).toContain('StepDefinition');
    });

    it('references ArgumentDefinition type', () => {
      expect(content).toContain('ArgumentDefinition');
    });

    it('references the workflow registry', () => {
      expect(content).toContain('Grimoire');
    });

    it('references the definition loader', () => {
      expect(content).toContain('definition-loader');
    });
  });

  describe('engine components', () => {
    it('references the parser', () => {
      expect(content).toContain('parser.ts');
    });

    it('references output directories', () => {
      expect(content).toContain('workflows/');
      expect(content).toContain('.claude/workflows/');
    });
  });
});
