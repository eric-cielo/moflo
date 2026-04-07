/**
 * Shared CLI Formatters Tests
 *
 * Story #380: Validates the shared formatStatus and handleMCPError utilities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock output before importing formatters
vi.mock('../src/output.js', () => ({
  output: {
    success: (s: string) => `[success:${s}]`,
    highlight: (s: string) => `[highlight:${s}]`,
    info: (s: string) => `[info:${s}]`,
    warning: (s: string) => `[warning:${s}]`,
    dim: (s: string) => `[dim:${s}]`,
    error: (s: string) => `[error:${s}]`,
    printError: vi.fn(),
  },
}));

// Mock mcp-client
vi.mock('../src/mcp-client.js', () => {
  class MCPClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MCPClientError';
    }
  }
  return { MCPClientError, callMCPTool: vi.fn() };
});

import { formatStatus, handleMCPError } from '../src/services/cli-formatters.js';
import { output } from '../src/output.js';
import { MCPClientError } from '../src/mcp-client.js';

describe('formatStatus', () => {
  // Success statuses (green)
  it.each(['completed', 'succeeded', 'success', 'active', 'healthy', 'validated'])(
    'formats "%s" as success',
    (status) => {
      expect(formatStatus(status)).toBe(`[success:${status}]`);
    },
  );

  // Highlight statuses (cyan)
  it.each(['running', 'in_progress'])(
    'formats "%s" as highlight',
    (status) => {
      expect(formatStatus(status)).toBe(`[highlight:${status}]`);
    },
  );

  // Info statuses (blue)
  it('formats "saved" as info', () => {
    expect(formatStatus('saved')).toBe('[info:saved]');
  });

  // Warning statuses (yellow)
  it.each(['idle', 'queued', 'degraded'])(
    'formats "%s" as warning',
    (status) => {
      expect(formatStatus(status)).toBe(`[warning:${status}]`);
    },
  );

  // Dim statuses (gray)
  it.each(['pending', 'waiting', 'skipped', 'inactive', 'stopped', 'archived'])(
    'formats "%s" as dim',
    (status) => {
      expect(formatStatus(status)).toBe(`[dim:${status}]`);
    },
  );

  // Error statuses (red)
  it.each(['failed', 'error', 'cancelled', 'unhealthy', 'blocked'])(
    'formats "%s" as error',
    (status) => {
      expect(formatStatus(status)).toBe(`[error:${status}]`);
    },
  );

  // Unknown status passthrough
  it('passes through unknown status values unchanged', () => {
    expect(formatStatus('custom-state')).toBe('custom-state');
  });

  // Coerces non-string input
  it('coerces non-string input to string', () => {
    expect(formatStatus(42)).toBe('42');
    expect(formatStatus(null)).toBe('null');
    expect(formatStatus(undefined)).toBe('undefined');
  });
});

describe('handleMCPError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts message from MCPClientError', () => {
    const error = new MCPClientError('connection timeout');
    const result = handleMCPError(error, 'list spells');

    expect(output.printError).toHaveBeenCalledWith('Failed to list spells: connection timeout');
    expect(result).toEqual({ success: false, exitCode: 1 });
  });

  it('stringifies non-MCPClientError', () => {
    const error = new Error('something broke');
    const result = handleMCPError(error, 'cast spell');

    expect(output.printError).toHaveBeenCalledWith('Failed to cast spell: Error: something broke');
    expect(result).toEqual({ success: false, exitCode: 1 });
  });

  it('handles string errors', () => {
    handleMCPError('raw string error', 'validate');
    expect(output.printError).toHaveBeenCalledWith('Failed to validate: raw string error');
  });

  it('always returns failed CommandResult', () => {
    const result = handleMCPError(new Error('x'), 'test');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
