/**
 * Spell Definition Schema Tests
 *
 * Story #103: YAML/JSON parsing, validation, and argument resolution.
 */

import { describe, it, expect } from 'vitest';
import { parseYaml, parseJson, parseWorkflow } from '../src/schema/parser.js';
import { validateSpellDefinition, resolveArguments } from '../src/schema/validator.js';
import type { SpellDefinition } from '../src/types/workflow-definition.types.js';

// ============================================================================
// Fixtures
// ============================================================================

const VALID_YAML = `
name: security-audit
abbreviation: sa
description: "Run a security audit"
version: "1.0"

arguments:
  target:
    type: string
    required: true
    description: "Target to audit"
  severity:
    type: string
    default: "high"
    enum: ["low", "medium", "high", "critical"]

steps:
  - id: scan
    type: agent
    config:
      agentType: security-auditor
      prompt: "Scan {args.target} at {args.severity}+ severity"
    output: vulnerabilities
  - id: report
    type: bash
    config:
      command: "echo {scan.vulnerabilities}"
`;

const VALID_JSON = JSON.stringify({
  name: 'doc-generation',
  steps: [
    { id: 'analyze', type: 'agent', config: { prompt: 'Analyze code' }, output: 'analysis' },
    { id: 'write', type: 'bash', config: { command: 'echo done' } },
  ],
});

const KNOWN_TYPES = ['agent', 'bash', 'condition', 'prompt', 'memory', 'wait', 'loop', 'browser'];

// ============================================================================
// Parser Tests
// ============================================================================

describe('parseYaml', () => {
  it('should parse valid YAML', () => {
    const result = parseYaml(VALID_YAML, 'security-audit.yaml');
    expect(result.format).toBe('yaml');
    expect(result.definition.name).toBe('security-audit');
    expect(result.definition.steps).toHaveLength(2);
    expect(result.sourceFile).toBe('security-audit.yaml');
  });

  it('should reject invalid YAML', () => {
    expect(() => parseYaml(':', 'bad.yaml')).toThrow();
  });

  it('should reject non-object YAML', () => {
    expect(() => parseYaml('"just a string"')).toThrow('expected an object');
  });
});

describe('parseJson', () => {
  it('should parse valid JSON', () => {
    const result = parseJson(VALID_JSON, 'workflow.json');
    expect(result.format).toBe('json');
    expect(result.definition.name).toBe('doc-generation');
  });

  it('should reject malformed JSON', () => {
    expect(() => parseJson('not json', 'bad.json')).toThrow('Invalid spell JSON');
  });

  it('should reject non-object JSON', () => {
    expect(() => parseJson('"string"')).toThrow('expected an object');
  });
});

describe('parseWorkflow', () => {
  it('should detect format from .yaml extension', () => {
    const result = parseWorkflow(VALID_YAML, 'test.yaml');
    expect(result.format).toBe('yaml');
  });

  it('should detect format from .yml extension', () => {
    const result = parseWorkflow(VALID_YAML, 'test.yml');
    expect(result.format).toBe('yaml');
  });

  it('should detect format from .json extension', () => {
    const result = parseWorkflow(VALID_JSON, 'test.json');
    expect(result.format).toBe('json');
  });

  it('should auto-detect JSON from content', () => {
    const result = parseWorkflow(VALID_JSON);
    expect(result.format).toBe('json');
  });

  it('should auto-detect YAML from content', () => {
    const result = parseWorkflow(VALID_YAML);
    expect(result.format).toBe('yaml');
  });

  it('should fall through to auto-detect on unknown extension', () => {
    // .txt is not a known extension, should auto-detect as YAML from content
    const result = parseWorkflow(VALID_YAML, 'workflow.txt');
    expect(result.format).toBe('yaml');
  });

  it('should auto-detect JSON for unknown extension with JSON content', () => {
    const result = parseWorkflow(VALID_JSON, 'workflow.toml');
    expect(result.format).toBe('json');
  });
});

// ============================================================================
// Validator Tests
// ============================================================================

describe('validateSpellDefinition', () => {
  it('should accept a valid spell', () => {
    const result = parseYaml(VALID_YAML);
    const validation = validateSpellDefinition(result.definition, { knownStepTypes: KNOWN_TYPES });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('should reject missing name', () => {
    const def: SpellDefinition = {
      name: '',
      steps: [{ id: 'a', type: 'bash', config: {} }],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'name')).toBe(true);
  });

  it('should reject missing steps', () => {
    const def = { name: 'test', steps: [] } as unknown as SpellDefinition;
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.path === 'steps')).toBe(true);
  });

  it('should reject duplicate step IDs', () => {
    const def: SpellDefinition = {
      name: 'test',
      steps: [
        { id: 'dup', type: 'bash', config: {} },
        { id: 'dup', type: 'bash', config: {} },
      ],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('duplicate step id'))).toBe(true);
  });

  it('should reject unknown step types with suggestions', () => {
    const def: SpellDefinition = {
      name: 'test',
      steps: [{ id: 'a', type: 'bask', config: {} }],
    };
    const result = validateSpellDefinition(def, { knownStepTypes: KNOWN_TYPES });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('unknown step type');
    expect(result.errors[0].message).toContain('bash');
  });

  it('should accept unknown types when no registry provided', () => {
    const def: SpellDefinition = {
      name: 'test',
      steps: [{ id: 'a', type: 'custom-step', config: {} }],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('should validate argument type', () => {
    const def: SpellDefinition = {
      name: 'test',
      arguments: { x: { type: 'invalid' as 'string' } },
      steps: [{ id: 'a', type: 'bash', config: {} }],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toContain('arguments.x.type');
  });

  it('should reject default value that mismatches argument type', () => {
    const def: SpellDefinition = {
      name: 'test',
      arguments: {
        count: { type: 'number', default: 'not-a-number' },
      },
      steps: [{ id: 'a', type: 'bash', config: {} }],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('does not match declared type');
  });

  it('should reject enum values that mismatch argument type', () => {
    const def: SpellDefinition = {
      name: 'test',
      arguments: {
        level: { type: 'number', enum: ['low', 'high'] },
      },
      steps: [{ id: 'a', type: 'bash', config: {} }],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('does not match declared type'))).toBe(true);
  });

  it('should validate enum default', () => {
    const def: SpellDefinition = {
      name: 'test',
      arguments: {
        level: { type: 'string', default: 'ultra', enum: ['low', 'high'] },
      },
      steps: [{ id: 'a', type: 'bash', config: {} }],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('not in enum');
  });

  it('should detect forward variable references', () => {
    const def: SpellDefinition = {
      name: 'test',
      steps: [
        { id: 'a', type: 'bash', config: { command: 'echo {b.output}' } },
        { id: 'b', type: 'bash', config: { command: 'echo hello' }, output: 'output' },
      ],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('forward reference');
  });

  it('should detect undefined argument references', () => {
    const def: SpellDefinition = {
      name: 'test',
      arguments: { target: { type: 'string' } },
      steps: [
        { id: 'a', type: 'bash', config: { command: 'echo {args.nonexistent}' } },
      ],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('undefined argument');
  });

  it('should validate nested steps in condition/loop', () => {
    const def: SpellDefinition = {
      name: 'test',
      steps: [
        {
          id: 'loop1',
          type: 'loop',
          config: {},
          steps: [
            { id: 'inner1', type: 'bash', config: {} },
            { id: 'inner1', type: 'bash', config: {} }, // duplicate
          ],
        },
      ],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('duplicate step id'))).toBe(true);
  });
});

// ============================================================================
// Argument Resolution Tests
// ============================================================================

describe('resolveArguments', () => {
  it('should resolve provided arguments', () => {
    const defs = {
      target: { type: 'string' as const, required: true },
    };
    const { resolved, errors } = resolveArguments(defs, { target: 'src/' });
    expect(errors).toEqual([]);
    expect(resolved.target).toBe('src/');
  });

  it('should apply defaults for missing optional args', () => {
    const defs = {
      severity: { type: 'string' as const, default: 'high', enum: ['low', 'medium', 'high'] },
    };
    const { resolved, errors } = resolveArguments(defs, {});
    expect(errors).toEqual([]);
    expect(resolved.severity).toBe('high');
  });

  it('should error on missing required args', () => {
    const defs = {
      target: { type: 'string' as const, required: true },
    };
    const { errors } = resolveArguments(defs, {});
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('required argument');
  });

  it('should reject values not in enum', () => {
    const defs = {
      level: { type: 'string' as const, enum: ['low', 'high'] },
    };
    const { errors } = resolveArguments(defs, { level: 'ultra' });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('not in enum');
  });

  it('should flag unknown argument keys (typos)', () => {
    const defs = {
      target: { type: 'string' as const, required: true },
    };
    const { errors } = resolveArguments(defs, { target: 'src/', targat: 'oops' });
    expect(errors.some(e => e.message.includes('unknown argument "targat"'))).toBe(true);
  });

  it('should omit optional args with no default when not provided', () => {
    const defs = {
      optional: { type: 'string' as const },
    };
    const { resolved, errors } = resolveArguments(defs, {});
    expect(errors).toEqual([]);
    expect(resolved).not.toHaveProperty('optional');
  });

  it('should reject value that does not match declared type', () => {
    const defs = {
      count: { type: 'number' as const, required: true },
    };
    const { errors } = resolveArguments(defs, { count: 'not-a-number' });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('does not match declared type');
  });

  it('should reject boolean value for string type', () => {
    const defs = {
      name: { type: 'string' as const },
    };
    const { errors } = resolveArguments(defs, { name: true });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('"string"');
  });
});

// ============================================================================
// YAML Hardening Tests (Issue #184)
// ============================================================================

describe('parseYaml hardening', () => {
  it('rejects !!js/function type (JSON_SCHEMA does not support it)', () => {
    const malicious = `
name: exploit
steps:
  - id: s1
    type: bash
    config:
      command: !!js/function 'function() { return "pwned"; }'
`;
    // JSON_SCHEMA rejects !!js/function with a parse error
    expect(() => parseYaml(malicious)).toThrow();
  });

  it('sanitizes __proto__ key from parsed YAML', () => {
    const poisoned = `
name: test
__proto__:
  isAdmin: true
steps:
  - id: s1
    type: bash
    config:
      command: echo hello
`;
    const result = parseYaml(poisoned);
    expect(result.definition).not.toHaveProperty('__proto__');
    // Verify the rest is intact
    expect(result.definition.name).toBe('test');
    expect(result.definition.steps).toHaveLength(1);
  });

  it('sanitizes nested __proto__, constructor, and prototype keys', () => {
    const poisoned = `
name: test
steps:
  - id: s1
    type: bash
    config:
      command: echo hello
      constructor: evil
      prototype: also-evil
`;
    const result = parseYaml(poisoned);
    const config = result.definition.steps[0].config as Record<string, unknown>;
    expect(config).not.toHaveProperty('constructor');
    expect(config).not.toHaveProperty('prototype');
    expect(config.command).toBe('echo hello');
  });

  it('rejects non-JSON YAML types like !!binary', () => {
    const yaml = `
name: test
steps:
  - id: s1
    type: bash
    config:
      data: !!binary "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
`;
    // JSON_SCHEMA rejects !!binary
    expect(() => parseYaml(yaml)).toThrow();
  });
});

describe('nested step variable validation', () => {
  it('should detect undefined arg refs inside nested steps', () => {
    const def: SpellDefinition = {
      name: 'test',
      arguments: { target: { type: 'string' } },
      steps: [
        {
          id: 'loop1',
          type: 'loop',
          config: {},
          steps: [
            { id: 'inner', type: 'bash', config: { command: 'echo {args.missing}' } },
          ],
        },
      ],
    };
    const result = validateSpellDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('undefined argument'))).toBe(true);
  });
});
