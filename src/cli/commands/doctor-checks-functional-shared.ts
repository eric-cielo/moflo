/**
 * Shared helpers for functional doctor checks (issue #844).
 *
 * Extracted from doctor-checks-swarm.ts (epic #798) once doctor-checks-
 * memory-access.ts started copying the same `loadToolArrays` / `getTool` /
 * `summarize` plumbing. New functional checks should consume these helpers
 * rather than re-implementing them.
 */

import { errorDetail } from '../shared/utils/error-detail.js';
import { findModule, toImportUrl, type HealthCheck } from './doctor-checks-deep.js';

export interface FunctionalCheckDetail {
  id: string;
  mcpTool: string;
  status: 'pass' | 'warn' | 'fail';
  observed?: unknown;
  expected: string;
  message?: string;
}

export interface FunctionalHealthCheck extends HealthCheck {
  details?: FunctionalCheckDetail[];
}

export interface ToolHandler {
  name: string;
  handler?: (input: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
}

/**
 * Dynamically import a set of MCP-tool array modules from the moflo dist tree
 * and return the named arrays. Returns null if any module is missing on disk
 * (caller should degrade to `warn: 'not built'`).
 */
export async function loadToolArrays(
  rels: Record<string, string>,
): Promise<Record<string, ToolHandler[]> | null> {
  const paths: Record<string, string> = {};
  for (const [k, rel] of Object.entries(rels)) {
    const p = findModule(rel);
    if (!p) return null;
    paths[k] = p;
  }
  const entries = await Promise.all(
    Object.entries(paths).map(async ([k, p]) => [k, await import(toImportUrl(p))] as const),
  );
  const out: Record<string, ToolHandler[]> = {};
  for (const [k, mod] of entries) {
    const arrName = Object.keys(mod).find(
      name =>
        Array.isArray(mod[name]) &&
        mod[name].every((t: unknown) => typeof (t as ToolHandler)?.name === 'string'),
    );
    if (!arrName) return null;
    out[k] = mod[arrName] as ToolHandler[];
  }
  return out;
}

export function getTool(tools: ToolHandler[], name: string): ToolHandler | undefined {
  return tools.find(t => t.name === name);
}

/**
 * Push a `pass` row when failReason is null, a `fail` row otherwise. Lets the
 * caller compute failReason via whatever shape fits (chained ifs, a guard
 * function, a typed assertion module) without re-inlining the detail literal.
 */
export function pushDetail(
  details: FunctionalCheckDetail[],
  meta: { id: string; mcpTool: string; expected: string },
  observed: unknown,
  failReason: string | null,
): void {
  details.push(
    failReason
      ? { ...meta, status: 'fail', observed, message: failReason }
      : { ...meta, status: 'pass', observed },
  );
}

export interface Expectation {
  id: string;
  mcpTool: string;
  expected: string;
  /** Return null on pass, or a failure-reason string. */
  assert: (out: unknown) => string | null;
  /** When set, return value triggers `warn` instead of `fail` (environmental, not a regression). */
  softFailMessage?: (out: unknown) => string | null;
}

/**
 * Invoke a registered MCP tool, run its assertion, and append a detail row.
 * Catches missing-tool and thrown-handler cases as fails so the caller never
 * has to deal with raw exceptions. Returns the tool's output (or undefined on
 * failure) so the caller can chain dependent calls.
 */
export async function safeInvoke(
  tools: ToolHandler[],
  name: string,
  input: Record<string, unknown>,
  details: FunctionalCheckDetail[],
  ex: Expectation,
): Promise<unknown> {
  const tool = getTool(tools, name);
  if (!tool?.handler) {
    details.push({
      id: ex.id, mcpTool: ex.mcpTool, status: 'fail',
      observed: { reason: 'tool-not-registered' }, expected: ex.expected,
      message: `MCP tool "${name}" not registered in the loaded tool array`,
    });
    return undefined;
  }
  try {
    const out = await tool.handler(input);
    const softReason = ex.softFailMessage?.(out);
    if (softReason) {
      details.push({ id: ex.id, mcpTool: ex.mcpTool, status: 'warn', observed: out, expected: ex.expected, message: softReason });
      return out;
    }
    const failReason = ex.assert(out);
    pushDetail(details, ex, out, failReason);
    return out;
  } catch (err) {
    const detail = errorDetail(err, { firstLineOnly: true });
    details.push({
      id: ex.id, mcpTool: ex.mcpTool, status: 'fail',
      observed: { error: detail }, expected: ex.expected,
      message: `handler threw: ${detail}`,
    });
    return undefined;
  }
}

/**
 * Roll an array of FunctionalCheckDetail rows up into the FunctionalHealthCheck
 * the doctor renderer consumes. Pass-suffix and fail-fix are caller-supplied so
 * the message vocabulary matches the check's domain.
 */
export function summarizeFunctional(
  name: string,
  details: FunctionalCheckDetail[],
  opts: { passSuffix: string; failFix: string },
): FunctionalHealthCheck {
  const fails = details.filter(d => d.status === 'fail');
  const warns = details.filter(d => d.status === 'warn');
  if (fails.length > 0) {
    const first = fails[0];
    return {
      name, status: 'fail',
      message: `${fails.length}/${details.length} subcheck(s) failed (e.g. ${first.id} via ${first.mcpTool}: ${first.message ?? first.expected})`,
      fix: opts.failFix,
      details,
    };
  }
  if (warns.length > 0) {
    return {
      name, status: 'warn',
      message: `${details.length - warns.length}/${details.length} pass; ${warns.length} degraded (likely environment, not regression)`,
      details,
    };
  }
  return { name, status: 'pass', message: `${details.length} subchecks OK ${opts.passSuffix}`.trim(), details };
}
