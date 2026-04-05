/**
 * Credential Masker Tests
 *
 * Unit tests for credential masking utilities extracted from WorkflowRunner (Issue #182).
 */

import { describe, it, expect } from 'vitest';
import {
  maskCredentials,
  buildCredentialPatterns,
  collectCredentialNames,
  stepReferencesCredentials,
  stepHasCredentialCapability,
  escapeRegExp,
  addCredentialPattern,
  MIN_REDACT_LENGTH,
} from '../src/core/credential-masker.js';
import type { StepOutput, StepCommand } from '../src/types/step-command.types.js';
import type { StepDefinition } from '../src/types/workflow-definition.types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeOutput(data: Record<string, unknown>, overrides?: Partial<StepOutput>): StepOutput {
  return { success: true, data, ...overrides };
}

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id: 'test-step',
    type: 'bash',
    config: { command: 'echo hello' },
    ...overrides,
  };
}

function makeCommand(overrides: Partial<StepCommand> = {}): StepCommand {
  return {
    type: 'bash',
    description: 'test',
    configSchema: {},
    validate: () => ({ valid: true, errors: [] }),
    execute: async () => ({ success: true, data: {} }),
    describeOutputs: () => [],
    ...overrides,
  };
}

// ============================================================================
// escapeRegExp
// ============================================================================

describe('escapeRegExp', () => {
  it('should escape special regex characters', () => {
    expect(escapeRegExp('foo.bar')).toBe('foo\\.bar');
    expect(escapeRegExp('a+b*c?')).toBe('a\\+b\\*c\\?');
    expect(escapeRegExp('[$^|]')).toBe('\\[\\$\\^\\|\\]');
  });

  it('should return plain strings unchanged', () => {
    expect(escapeRegExp('hello')).toBe('hello');
  });
});

// ============================================================================
// buildCredentialPatterns
// ============================================================================

describe('buildCredentialPatterns', () => {
  it('should create RegExp patterns from credential values', () => {
    const patterns = buildCredentialPatterns(['secret-token', 'my-api-key']);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toBeInstanceOf(RegExp);
    expect('has secret-token inside'.replace(patterns[0], 'X')).toBe('has X inside');
  });

  it('should skip values shorter than MIN_REDACT_LENGTH', () => {
    const short = 'a'.repeat(MIN_REDACT_LENGTH - 1);
    const long = 'a'.repeat(MIN_REDACT_LENGTH);
    const patterns = buildCredentialPatterns([short, long]);
    expect(patterns).toHaveLength(1);
  });

  it('should return empty array for empty input', () => {
    expect(buildCredentialPatterns([])).toEqual([]);
  });

  it('should escape special regex characters in values', () => {
    const patterns = buildCredentialPatterns(['key.with+special']);
    const result = 'key.with+special'.replace(patterns[0], 'X');
    expect(result).toBe('X');
    // Ensure it doesn't match unescaped pattern
    const noMatch = 'keyXwithYspecial'.replace(patterns[0], 'X');
    expect(noMatch).toBe('keyXwithYspecial');
  });
});

// ============================================================================
// addCredentialPattern
// ============================================================================

describe('addCredentialPattern', () => {
  it('should add pattern for values at or above MIN_REDACT_LENGTH', () => {
    const patterns: RegExp[] = [];
    addCredentialPattern(patterns, 'abcd');
    expect(patterns).toHaveLength(1);
  });

  it('should skip values below MIN_REDACT_LENGTH', () => {
    const patterns: RegExp[] = [];
    addCredentialPattern(patterns, 'abc');
    expect(patterns).toHaveLength(0);
  });
});

// ============================================================================
// maskCredentials
// ============================================================================

describe('maskCredentials', () => {
  it('should replace credential values in StepOutput data', () => {
    const patterns = buildCredentialPatterns(['super-secret']);
    const output = makeOutput({ message: 'token is super-secret here' });
    const masked = maskCredentials(output, patterns);
    expect(masked.data).toEqual({ message: 'token is ***REDACTED*** here' });
    expect(masked.success).toBe(true);
  });

  it('should handle multiple credential patterns', () => {
    const patterns = buildCredentialPatterns(['secret-a', 'secret-b']);
    const output = makeOutput({ a: 'has secret-a', b: 'has secret-b' });
    const masked = maskCredentials(output, patterns);
    expect(masked.data).toEqual({ a: 'has ***REDACTED***', b: 'has ***REDACTED***' });
  });

  it('should return original output when no patterns match', () => {
    const patterns = buildCredentialPatterns(['not-present']);
    const output = makeOutput({ message: 'clean data' });
    const masked = maskCredentials(output, patterns);
    expect(masked).toBe(output); // Same reference — no copy needed
  });

  it('should return original output when patterns array is empty', () => {
    const output = makeOutput({ message: 'anything' });
    const masked = maskCredentials(output, []);
    expect(masked).toBe(output);
  });

  it('should handle JSON corruption from partial replacement gracefully', () => {
    // Craft data where the credential value, when replaced, breaks JSON structure.
    // The credential matches a substring of the serialized JSON that includes
    // structural characters (quotes/braces), so replacing it corrupts the JSON.
    // We build the output manually so that the serialized JSON contains the pattern.
    const output = makeOutput({ key: 'value' });

    // Create a pattern that matches part of the JSON structural text itself
    // JSON.stringify({ key: 'value' }) => '{"key":"value"}'
    // A pattern matching '":"' will replace structural JSON, breaking it.
    const corruptingPattern = new RegExp('":"', 'g');
    const masked = maskCredentials(output, [corruptingPattern]);

    // The replacement corrupts JSON, triggering the catch fallback
    expect(masked.data).toEqual({
      _redacted: true,
      _note: 'Output contained credentials and was fully redacted',
    });
  });

  it('should mask credential values that appear in nested data', () => {
    const patterns = buildCredentialPatterns(['my-token']);
    const output = makeOutput({ nested: { deep: 'value is my-token' } });
    const masked = maskCredentials(output, patterns);
    expect((masked.data.nested as Record<string, unknown>).deep).toBe('value is ***REDACTED***');
  });

  it('should mask the error field when present in output data', () => {
    const patterns = buildCredentialPatterns(['leaked-key']);
    const output = makeOutput(
      { info: 'ok' },
      { error: 'failed with leaked-key' },
    );
    // maskCredentials operates on output.data via JSON.stringify(output.data),
    // so the top-level error field is part of the StepOutput spread, not data.
    // The function serializes output.data, so error in data would be masked:
    const outputWithErrorInData = makeOutput({ error: 'failed with leaked-key' });
    const masked = maskCredentials(outputWithErrorInData, patterns);
    expect(masked.data.error).toBe('failed with ***REDACTED***');
  });
});

// ============================================================================
// collectCredentialNames
// ============================================================================

describe('collectCredentialNames', () => {
  it('should extract {credentials.NAME} references from step config', () => {
    const steps: StepDefinition[] = [
      makeStep({ config: { token: '{credentials.API_KEY}' } }),
    ];
    const names = collectCredentialNames(steps);
    expect(names).toEqual(new Set(['API_KEY']));
  });

  it('should extract multiple credential references', () => {
    const steps: StepDefinition[] = [
      makeStep({ config: { a: '{credentials.KEY1}', b: '{credentials.KEY2}' } }),
    ];
    const names = collectCredentialNames(steps);
    expect(names).toEqual(new Set(['KEY1', 'KEY2']));
  });

  it('should scan nested step definitions', () => {
    const steps: StepDefinition[] = [
      makeStep({
        type: 'loop',
        config: {},
        steps: [
          makeStep({ id: 'inner', config: { secret: '{credentials.INNER_KEY}' } }),
        ],
      }),
    ];
    const names = collectCredentialNames(steps);
    expect(names).toEqual(new Set(['INNER_KEY']));
  });

  it('should scan arrays in config', () => {
    const steps: StepDefinition[] = [
      makeStep({ config: { items: ['{credentials.ARR_KEY}'] } }),
    ];
    const names = collectCredentialNames(steps);
    expect(names).toEqual(new Set(['ARR_KEY']));
  });

  it('should return empty set when no credentials referenced', () => {
    const steps: StepDefinition[] = [
      makeStep({ config: { command: 'echo hello' } }),
    ];
    const names = collectCredentialNames(steps);
    expect(names.size).toBe(0);
  });
});

// ============================================================================
// stepReferencesCredentials
// ============================================================================

describe('stepReferencesCredentials', () => {
  it('should return true when step config contains credential references', () => {
    const step = makeStep({ config: { token: '{credentials.TOKEN}' } });
    expect(stepReferencesCredentials(step)).toBe(true);
  });

  it('should return false when step config has no credential references', () => {
    const step = makeStep({ config: { command: 'echo test' } });
    expect(stepReferencesCredentials(step)).toBe(false);
  });
});

// ============================================================================
// stepHasCredentialCapability
// ============================================================================

describe('stepHasCredentialCapability', () => {
  it('should return true when command has credentials capability', () => {
    const step = makeStep();
    const command = makeCommand({
      capabilities: [{ type: 'credentials' }],
    });
    expect(stepHasCredentialCapability(step, command)).toBe(true);
  });

  it('should return false when command has no credentials capability', () => {
    const step = makeStep();
    const command = makeCommand({
      capabilities: [{ type: 'shell' }],
    });
    expect(stepHasCredentialCapability(step, command)).toBe(false);
  });

  it('should return false when command has no capabilities defined', () => {
    const step = makeStep();
    const command = makeCommand({ capabilities: undefined });
    expect(stepHasCredentialCapability(step, command)).toBe(false);
  });
});
