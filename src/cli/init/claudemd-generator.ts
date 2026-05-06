/**
 * CLAUDE.md Generator
 *
 * Generates ONLY the MoFlo section to inject into a project's CLAUDE.md.
 * This must be minimal — just enough for Claude to work with moflo.
 * All detailed docs live in .claude/guidance/moflo-core-guidance.md on consumer projects (synced from .claude/guidance/shipped/ inside node_modules/moflo).
 *
 * Principle: we are guests in the user's CLAUDE.md. Keep it small.
 */

import type { InitOptions, ClaudeMdTemplate } from './types.js';

const MARKER_START = '<!-- MOFLO:INJECTED:START -->';
const MARKER_END = '<!-- MOFLO:INJECTED:END -->';

// Legacy markers from earlier moflo versions — detected and replaced on re-injection.
// Single source of truth so moflo-init.ts and bin/setup-project.mjs stay in sync.
const LEGACY_MARKER_STARTS = [
  '<!-- MOFLO:START -->',
  '<!-- MOFLO:SUBAGENT-PROTOCOL:START -->',
] as const;
const LEGACY_MARKER_ENDS = [
  '<!-- MOFLO:END -->',
  '<!-- MOFLO:SUBAGENT-PROTOCOL:END -->',
] as const;

/**
 * The single moflo section injected into CLAUDE.md.
 * ~22 lines. Points to moflo-core-guidance.md for everything else.
 */
function mofloSection(): string {
  return `${MARKER_START}
## MoFlo — AI Agent Orchestration

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call MUST be \`mcp__moflo__memory_search\` — before any Glob/Grep/Read. Search \`guidance\`, \`patterns\`, and \`learnings\` every prompt; add \`code-map\` when navigating code, \`tests\` when looking for test inventory or coverage. When the user says "remember this", call \`mcp__moflo__memory_store\` with namespace \`learnings\`.

### Auto-enforced gates

- **TaskCreate-first**: Call \`TaskCreate\` before spawning the Agent tool
- **Task Icons**: \`TaskCreate\` entries MUST use ICON+[Role] format — see \`.claude/guidance/moflo-task-icons.md\`

### Tools

Prefer MCP (\`mcp__moflo__*\` — memory, swarm, agent, task, hooks, hive-mind, neural) over the CLI. CLI binaries: \`flo\` (main), \`flo-search\` (semantic search), \`flo doctor --fix\` (heal). Full catalog: \`.claude/guidance/moflo-core-guidance.md\`.

### After upgrading MoFlo

After \`npm install\` touches moflo, check \`.moflo/restart-pending.json\` — if present, surface its \`message\` field to the user verbatim, then delete the file. (Claude Code only loads new hooks/MCP/launcher at session start.)

### Full Reference

- Universal agent rules (memory protocol, git/PR conventions, file org, build/test): \`.claude/guidance/moflo-agent-rules.md\`
- Subagent spawn protocol: \`.claude/guidance/moflo-subagents.md\`
- Task + swarm coordination: \`.claude/guidance/moflo-claude-swarm-cohesion.md\`
- CLI, hooks, swarm, memory, moflo.yaml: \`.claude/guidance/moflo-core-guidance.md\`
${MARKER_END}`;
}

// --- Public API ---

export { MARKER_START, MARKER_END, LEGACY_MARKER_STARTS, LEGACY_MARKER_ENDS };

/**
 * Generate the MoFlo section to inject into CLAUDE.md.
 * Template parameter is accepted for backward compatibility but ignored —
 * all templates now produce the same minimal injection.
 */
export function generateClaudeMd(_options: InitOptions, _template?: ClaudeMdTemplate): string {
  return mofloSection() + '\n';
}

/**
 * Generate minimal CLAUDE.md content (backward-compatible alias).
 */
export function generateMinimalClaudeMd(options: InitOptions): string {
  return generateClaudeMd(options, 'minimal');
}

/** Available template names for CLI wizard (kept for backward compat, all produce same output) */
export const CLAUDE_MD_TEMPLATES: Array<{ name: ClaudeMdTemplate; description: string }> = [
  { name: 'minimal', description: 'Recommended — memory search, gates, tools, upgrade hint (~22 lines injected)' },
  { name: 'standard', description: 'Same as minimal (detailed docs in .claude/guidance/moflo-core-guidance.md)' },
  { name: 'full', description: 'Same as minimal (detailed docs in .claude/guidance/moflo-core-guidance.md)' },
  { name: 'security', description: 'Same as minimal (detailed docs in .claude/guidance/moflo-core-guidance.md)' },
  { name: 'performance', description: 'Same as minimal (detailed docs in .claude/guidance/moflo-core-guidance.md)' },
  { name: 'solo', description: 'Same as minimal (detailed docs in .claude/guidance/moflo-core-guidance.md)' },
];

export default generateClaudeMd;
