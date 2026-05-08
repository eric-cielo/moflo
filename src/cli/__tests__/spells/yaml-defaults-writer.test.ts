/**
 * Tests for the YAML defaults writer (#1003).
 *
 * Round-trip + corner cases: comment preservation, missing default insertion,
 * absent arguments block, value formatting, type variety, leaving non-target
 * keys untouched.
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import {
  updateYamlArgDefaults,
  formatYamlValue,
} from '../../spells/core/yaml-defaults-writer.js';

const STANDARD_YAML = `name: oap
description: Outlook -> abstract -> persist
version: 1
arguments:
  maxEmails:
    type: number
    default: 25  # max per cast
    description: Cap on emails fetched
  sinceDays:
    type: number
    default: 7
    description: Lookback window in days
  headless:
    type: boolean
    default: true
steps:
  - id: fetch
    type: bash
    config:
      command: echo hi
`;

describe('updateYamlArgDefaults', () => {
  it('rewrites a number default and preserves the inline comment', () => {
    const r = updateYamlArgDefaults(STANDARD_YAML, { maxEmails: 50 });

    expect(r.updated).toEqual(['maxEmails']);
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('default: 50  # max per cast');
    // sinceDays untouched
    expect(r.content).toContain('default: 7');
    // re-parse as YAML and confirm new value
    const reparsed = yaml.load(r.content) as { arguments: Record<string, { default: unknown }> };
    expect(reparsed.arguments.maxEmails.default).toBe(50);
    expect(reparsed.arguments.sinceDays.default).toBe(7);
    expect(reparsed.arguments.headless.default).toBe(true);
  });

  it('rewrites multiple defaults in one pass without disturbing structure', () => {
    const r = updateYamlArgDefaults(STANDARD_YAML, {
      maxEmails: 100,
      sinceDays: 30,
      headless: false,
    });

    expect(r.updated.sort()).toEqual(['headless', 'maxEmails', 'sinceDays']);
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('default: 100  # max per cast');

    const reparsed = yaml.load(r.content) as { arguments: Record<string, { default: unknown }> };
    expect(reparsed.arguments.maxEmails.default).toBe(100);
    expect(reparsed.arguments.sinceDays.default).toBe(30);
    expect(reparsed.arguments.headless.default).toBe(false);

    // Top-level keys untouched
    expect(r.content.startsWith('name: oap\n')).toBe(true);
    expect(r.content).toContain('description: Outlook -> abstract -> persist');
    expect(r.content).toContain('  - id: fetch');
  });

  it('inserts a default line when one is missing', () => {
    const yamlNoDefault = `arguments:
  needle:
    type: string
    description: required by user
`;
    const r = updateYamlArgDefaults(yamlNoDefault, { needle: 'haystack' });

    expect(r.updated).toEqual(['needle']);
    expect(r.skipped).toEqual([]);
    const reparsed = yaml.load(r.content) as { arguments: { needle: { default: string } } };
    expect(reparsed.arguments.needle.default).toBe('haystack');
    // The new line should be at the same indent as siblings
    expect(r.content).toMatch(/^ {4}default: haystack$/m);
  });

  it('returns skipped for keys not declared in arguments', () => {
    const r = updateYamlArgDefaults(STANDARD_YAML, { unknownArg: 'x' });

    expect(r.updated).toEqual([]);
    expect(r.skipped).toEqual(['unknownArg']);
    expect(r.content).toBe(STANDARD_YAML);
  });

  it('returns all keys as skipped when arguments: block is absent', () => {
    const yamlNoArgs = `name: simple
steps:
  - id: a
    type: bash
`;
    const r = updateYamlArgDefaults(yamlNoArgs, { foo: 1 });

    expect(r.updated).toEqual([]);
    expect(r.skipped).toEqual(['foo']);
    expect(r.content).toBe(yamlNoArgs);
  });

  it('is a no-op when updates is empty', () => {
    const r = updateYamlArgDefaults(STANDARD_YAML, {});

    expect(r.updated).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.content).toBe(STANDARD_YAML);
  });

  it('round-trips strings with special characters via js-yaml quoting', () => {
    const yamlInput = `arguments:
  pathArg:
    type: string
    default: ./data
`;
    const r = updateYamlArgDefaults(yamlInput, { pathArg: 'a path with spaces' });

    expect(r.updated).toEqual(['pathArg']);
    const reparsed = yaml.load(r.content) as { arguments: { pathArg: { default: string } } };
    expect(reparsed.arguments.pathArg.default).toBe('a path with spaces');
  });

  it('preserves comments and blank lines outside the touched block', () => {
    const yamlInput = `# top-level header comment
name: x

arguments:
  # inside arguments comment
  maxEmails:
    type: number
    default: 25

  # comment between args
  sinceDays:
    type: number
    default: 7

steps:
  - id: a
    type: bash
`;
    const r = updateYamlArgDefaults(yamlInput, { maxEmails: 99 });

    expect(r.updated).toEqual(['maxEmails']);
    expect(r.content).toContain('# top-level header comment');
    expect(r.content).toContain('# inside arguments comment');
    expect(r.content).toContain('# comment between args');
    // Blank line between args is still there
    expect(r.content).toMatch(/default: 99\n\n  # comment between args/);
  });
});

describe('updateYamlArgDefaults — corruption guards', () => {
  it('preserves CRLF line endings on round-trip', () => {
    const yamlInput = 'arguments:\r\n  maxEmails:\r\n    type: number\r\n    default: 25\r\n';
    const r = updateYamlArgDefaults(yamlInput, { maxEmails: 99 });

    expect(r.updated).toEqual(['maxEmails']);
    expect(r.content).toContain('\r\n');
    expect(r.content).not.toMatch(/[^\r]\n/);
    expect(r.content).toContain('default: 99');
  });

  it('skips block-scalar `|` defaults instead of orphaning continuation lines', () => {
    const yamlInput = `arguments:
  body:
    type: string
    default: |
      line one
      line two
    description: long-form text
`;
    const r = updateYamlArgDefaults(yamlInput, { body: 'one-liner' });

    expect(r.updated).toEqual([]);
    expect(r.skipped).toEqual(['body']);
    expect(r.content).toBe(yamlInput);
  });

  it('skips block-scalar `>` (folded) defaults', () => {
    const yamlInput = `arguments:
  body:
    type: string
    default: >
      paragraph one
      paragraph two
`;
    const r = updateYamlArgDefaults(yamlInput, { body: 'short' });

    expect(r.skipped).toEqual(['body']);
    expect(r.content).toBe(yamlInput);
  });

  it('round-trips multiline string values via js-yaml inline quoting', () => {
    const yamlInput = `arguments:
  note:
    type: string
    default: x
`;
    const r = updateYamlArgDefaults(yamlInput, { note: 'line1\nline2\nline3' });

    expect(r.updated).toEqual(['note']);
    expect(r.skipped).toEqual([]);

    const reparsed = yaml.load(r.content) as { arguments: { note: { default: string } } };
    expect(reparsed.arguments.note.default).toBe('line1\nline2\nline3');
    // The dumped value sits on the `default:` line — no orphaned continuation.
    expect(r.content.split('\n').filter((l) => l.includes('default:'))).toHaveLength(1);
  });
});

describe('formatYamlValue', () => {
  it.each([
    [42, '42'],
    [0, '0'],
    [-1.5, '-1.5'],
    [true, 'true'],
    [false, 'false'],
    [null, 'null'],
    [undefined, 'null'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatYamlValue(input)).toBe(expected);
  });

  it('formats simple strings without quotes when safe', () => {
    expect(formatYamlValue('plain')).toBe('plain');
  });

  it('quotes strings that need it', () => {
    // js-yaml dumps strings containing leading whitespace with quotes
    const out = formatYamlValue(' leading');
    expect(out).toMatch(/^['"].*['"]$/);
  });

  it('formats arrays inline', () => {
    expect(formatYamlValue([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('formats objects inline', () => {
    expect(formatYamlValue({ a: 1, b: 'x' })).toMatch(/^\{a: 1, b: x\}$/);
  });
});
