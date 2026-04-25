/**
 * Parallel Command Tests
 *
 * Unit tests for the parallel step command (Issue #247).
 */

import { describe, it, expect } from 'vitest';
import { parallelCommand } from '../../src/spells/commands/parallel-command.js';

describe('parallelCommand', () => {
  it('should have correct type and description', () => {
    expect(parallelCommand.type).toBe('parallel');
    expect(parallelCommand.description).toContain('concurrently');
  });

  it('should validate valid config with defaults', () => {
    const result = parallelCommand.validate({});
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate config with maxConcurrency and failFast', () => {
    const result = parallelCommand.validate({ maxConcurrency: 3, failFast: false });
    expect(result.valid).toBe(true);
  });

  it('should reject maxConcurrency of 0', () => {
    const result = parallelCommand.validate({ maxConcurrency: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('maxConcurrency');
  });

  it('should reject negative maxConcurrency', () => {
    const result = parallelCommand.validate({ maxConcurrency: -1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('positive');
  });

  it('should reject non-boolean failFast', () => {
    const result = parallelCommand.validate({ failFast: 'yes' as unknown as boolean });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('failFast');
  });

  it('should execute and return metadata', async () => {
    const output = await parallelCommand.execute({ maxConcurrency: 5, failFast: false });
    expect(output.success).toBe(true);
    expect(output.data.maxConcurrency).toBe(5);
    expect(output.data.failFast).toBe(false);
  });

  it('should default maxConcurrency to 0 (unlimited) and failFast to true', async () => {
    const output = await parallelCommand.execute({});
    expect(output.data.maxConcurrency).toBe(0);
    expect(output.data.failFast).toBe(true);
  });

  it('should describe outputs', () => {
    const outputs = parallelCommand.describeOutputs!();
    expect(outputs.some(o => o.name === 'maxConcurrency')).toBe(true);
    expect(outputs.some(o => o.name === 'failFast')).toBe(true);
    expect(outputs.some(o => o.name === 'stepOutputs')).toBe(true);
  });
});
