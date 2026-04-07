/**
 * Shared CLI Formatters
 *
 * Story #380: Extract duplicated status formatting and MCP error handling
 * into shared utilities used by all CLI command files.
 */

import type { CommandResult } from '../types.js';
import { output } from '../output.js';
import { MCPClientError } from '../mcp-client.js';

/**
 * Format a status string with color coding.
 *
 * Covers the superset of statuses used across agent, hooks, session, spell,
 * and task commands. Each status maps to a semantic color:
 *   - success (green): completed, succeeded, success, active, healthy, validated
 *   - highlight (cyan): running, in_progress
 *   - info (blue): saved
 *   - warning (yellow): idle, queued, degraded
 *   - dim (gray): pending, waiting, skipped, inactive, stopped, archived
 *   - error (red): failed, error, cancelled, unhealthy, blocked
 */
export function formatStatus(status: unknown): string {
  const s = String(status);
  switch (s) {
    case 'completed':
    case 'succeeded':
    case 'success':
    case 'active':
    case 'healthy':
    case 'validated':
      return output.success(s);
    case 'running':
    case 'in_progress':
      return output.highlight(s);
    case 'saved':
      return output.info(s);
    case 'idle':
    case 'queued':
    case 'degraded':
      return output.warning(s);
    case 'pending':
    case 'waiting':
    case 'skipped':
    case 'inactive':
    case 'stopped':
    case 'archived':
      return output.dim(s);
    case 'failed':
    case 'error':
    case 'cancelled':
    case 'unhealthy':
    case 'blocked':
      return output.error(s);
    default:
      return s;
  }
}

/**
 * Handle an MCP tool call error and return a failed CommandResult.
 *
 * Extracts the message from MCPClientError instances, falls back to
 * String(error) for unexpected errors. Prints via output.printError().
 */
export function handleMCPError(error: unknown, action: string): CommandResult {
  const msg = error instanceof MCPClientError ? error.message : String(error);
  output.printError(`Failed to ${action}: ${msg}`);
  return { success: false, exitCode: 1 };
}
