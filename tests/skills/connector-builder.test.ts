/**
 * Connector Builder Skill — Content Validation Tests
 *
 * Validates that the SKILL.md file is well-formed and contains
 * all required sections for scaffolding connectors and step commands.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_PATH = path.resolve(__dirname, '../../.claude/skills/connector-builder/SKILL.md');

describe('connector-builder skill', () => {
  let content: string;
  let fmName: string;
  let fmDescription: string;
  let connectorSection: string;
  let stepSection: string;

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

    const sections = content.split(/## Building a Step Command/i);
    connectorSection = sections[0];
    stepSection = sections[1];
  });

  describe('file structure', () => {
    it('is non-empty', () => {
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

    it('description mentions connectors and steps', () => {
      const desc = fmDescription.toLowerCase();
      expect(desc).toContain('connector');
      expect(desc).toContain('step');
    });

    it('description includes a "when" trigger clause', () => {
      const desc = fmDescription.toLowerCase();
      expect(desc).toMatch(/use when|when creating|when building|when extending/);
    });
  });

  describe('connector scaffolding', () => {
    it('contains a connector building section', () => {
      expect(content).toMatch(/## Building a (?:Generalized )?Connector/i);
    });

    it('references SpellConnector interface', () => {
      expect(content).toContain('SpellConnector');
    });

    it('references ConnectorAction type', () => {
      expect(content).toContain('ConnectorAction');
    });

    it('references ConnectorOutput type', () => {
      expect(content).toContain('ConnectorOutput');
    });

    it('includes connector capabilities list', () => {
      const capSection = content.match(/Capabilities.*?`read`.*?`write`.*?`search`.*?`subscribe`.*?`authenticate`/s);
      expect(capSection).not.toBeNull();
    });

    it('shows connector registration in index.ts', () => {
      expect(content).toContain('connectors/index.ts');
      expect(content).toContain('builtinConnectors');
    });

    it('includes initialize and dispose lifecycle methods', () => {
      expect(content).toContain('initialize');
      expect(content).toContain('dispose');
    });

    it('includes listActions method', () => {
      expect(content).toContain('listActions');
    });
  });

  describe('step command scaffolding', () => {
    it('contains a step building section', () => {
      expect(content).toMatch(/## Building a Step Command/i);
    });

    it('references StepCommand interface', () => {
      expect(content).toContain('StepCommand');
    });

    it('references StepConfig type', () => {
      expect(content).toContain('StepConfig');
    });

    it('references StepOutput type', () => {
      expect(content).toContain('StepOutput');
    });

    it('references CastingContext type', () => {
      expect(content).toContain('CastingContext');
    });

    it('includes configSchema with JSONSchema', () => {
      expect(content).toContain('configSchema');
      expect(content).toContain('JSONSchema');
    });

    it('includes validate and execute methods', () => {
      expect(content).toContain('validate');
      expect(content).toContain('execute');
    });

    it('includes describeOutputs method', () => {
      expect(content).toContain('describeOutputs');
    });

    it('shows step registration in commands/index.ts', () => {
      expect(content).toContain('commands/index.ts');
      expect(content).toContain('builtinCommands');
    });

    it('mentions createStepCommand factory', () => {
      expect(content).toContain('createStepCommand');
    });
  });

  describe('test generation', () => {
    it('includes connector test template', () => {
      expect(content).toMatch(/Generate Connector Test/i);
      expect(content).toContain('vitest');
    });

    it('includes step command test template', () => {
      expect(content).toMatch(/Generate Step Command Test/i);
      expect(content).toContain('mockContext');
    });
  });

  describe('workflow YAML examples', () => {
    it('includes connector workflow YAML example', () => {
      expect(connectorSection).toContain('```yaml');
    });

    it('includes step command workflow YAML example', () => {
      expect(stepSection).toContain('```yaml');
    });
  });

  describe('reference tables', () => {
    it('lists existing shipped connectors', () => {
      expect(content).toContain('github-cli');
      expect(content).toContain('http');
      expect(content).toContain('playwright');
    });

    it('lists existing built-in step commands', () => {
      expect(content).toContain('agent-command');
      expect(content).toContain('bash-command');
      expect(content).toContain('condition-command');
      expect(content).toContain('memory-command');
    });

    it('references the spell-builder skill (#240)', () => {
      expect(content).toContain('spell-builder');
      expect(content).toContain('#240');
    });
  });
});
