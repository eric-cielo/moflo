/**
 * Synthetic-response labeling for MCP tools (#1324, #1325).
 *
 * Several registered MCP tools return values that look like measurements but
 * are not: hardcoded literals, `Math.random()` draws, or local coordination
 * state that never reaches the service it appears to describe. They stay
 * registered — removing them would break callers that use the honest parts —
 * but a caller must be able to tell the difference, and today it cannot.
 *
 * `withSyntheticNotice` attaches one notice in both places a caller can see:
 *
 * - **`description`**, which the MCP server returns verbatim from
 *   `tools/list`, so the contract is visible at tool-*selection* time. A
 *   source-file header comment is not — that was the gap in #1324.
 * - **every response object**, so a record captured from a call is still
 *   self-describing afterwards, when nobody remembers which tool produced it.
 *
 * Wrapping the tool rather than editing each `return` is deliberate: these
 * handlers have 20+ return sites between them, and a missed one produces
 * exactly the unlabelled fabrication this module exists to prevent.
 *
 * This is labeling only. No handler's success/failure behaviour changes, and
 * nothing that works today starts failing — see the issues for why the
 * behaviour fixes (`merge` reporting success for a PR it never found,
 * `hooks_intelligence-reset` reporting a reset it never performs) are tracked
 * separately.
 */

import type { MCPTool } from './types.js';

/**
 * Uppercase so it survives an agent skimming a long tool list, and greppable
 * so a consumer can audit which of their tools are labelled.
 */
export const SYNTHETIC_PREFIX = 'SYNTHETIC:';

/**
 * Wrap a tool so its description and every object response carry `notice`.
 *
 * Non-object returns (a bare string, an array) pass through untouched — there
 * is nowhere to attach a field without changing the response's shape, and a
 * shape change is a behaviour change. No such handler exists among the tools
 * wrapped today; the guard is here so adding one later fails visibly as an
 * unlabelled response rather than a corrupted one.
 */
export function withSyntheticNotice<T extends MCPTool>(tool: T, notice: string): T {
  const inner = tool.handler;
  const full = `${SYNTHETIC_PREFIX} ${notice}`;

  return {
    ...tool,
    description: `${tool.description}. ${full}`,
    handler: async (input, context) => {
      const result = await inner(input, context);
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      // Spread first: the marker is authoritative and must win over any
      // same-named field a handler happens to return.
      return { ...(result as Record<string, unknown>), synthetic: true, syntheticNotice: full };
    },
  };
}

/**
 * Apply per-tool notices to a tool array by name.
 *
 * A name absent from `notices` passes through unwrapped, which is the correct
 * default: tools in these files that genuinely measure something
 * (`performance_benchmark` times real work, `neural_patterns` computes real
 * cosine similarity) must not be labelled synthetic. The labeling test pins
 * both sets by name, so an omission on either side is caught rather than
 * shipped.
 */
export function applySyntheticNotices(tools: MCPTool[], notices: Record<string, string>): MCPTool[] {
  return tools.map(tool => {
    const notice = notices[tool.name];
    return notice ? withSyntheticNotice(tool, notice) : tool;
  });
}
