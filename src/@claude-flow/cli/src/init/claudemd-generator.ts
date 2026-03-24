/**
 * CLAUDE.md Generator
 *
 * Generates ONLY the MoFlo section to inject into a project's CLAUDE.md.
 * This must be minimal — just enough for Claude to work with moflo.
 * All detailed docs live in .claude/guidance/shipped/moflo.md (copied at install).
 *
 * Principle: we are guests in the user's CLAUDE.md. Keep it small.
 */

import type { InitOptions, ClaudeMdTemplate } from './types.js';

const MARKER_START = '<!-- MOFLO:INJECTED:START -->';
const MARKER_END = '<!-- MOFLO:INJECTED:END -->';

/**
 * The single moflo section injected into CLAUDE.md.
 * ~40 lines. Points to moflo.md for everything else.
 */
function mofloSection(): string {
  return `${MARKER_START}
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development workflows.

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call for every new user prompt MUST be a memory search. Do this BEFORE Glob, Grep, Read, or any file exploration.

\`\`\`
mcp__moflo__memory_search — query: "<task description>", namespace: "guidance" or "patterns" or "code-map"
\`\`\`

Search \`guidance\` and \`patterns\` namespaces on every prompt. Search \`code-map\` when navigating the codebase.
When the user asks you to remember something: \`mcp__moflo__memory_store\` with namespace \`knowledge\`.

### Workflow Gates (enforced automatically)

- **Memory-first**: Must search memory before Glob/Grep/Read
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool

- **Task Icons**: \`TaskCreate\` MUST use ICON+[Role] format — see \`.claude/guidance/task-icons.md\`

### MCP Tools (preferred over CLI)

| Tool | Purpose |
|------|---------|
| \`mcp__moflo__memory_search\` | Semantic search across indexed knowledge |
| \`mcp__moflo__memory_store\` | Store patterns and decisions |
| \`mcp__moflo__hooks_route\` | Route task to optimal agent type |
| \`mcp__moflo__hooks_pre-task\` | Record task start |
| \`mcp__moflo__hooks_post-task\` | Record task completion for learning |

### CLI Fallback

\`\`\`bash
npx flo-search "[query]" --namespace guidance   # Semantic search
npx flo doctor --fix                             # Health check
\`\`\`

### Full Reference

- **Agent bootstrap protocol:** \`.claude/guidance/shipped/agent-bootstrap.md\`
- **Task + swarm coordination:** \`.claude/guidance/shipped/task-swarm-integration.md\`
- **CLI, hooks, swarm, memory, moflo.yaml:** \`.claude/guidance/shipped/moflo.md\`
${MARKER_END}`;
}

// --- Public API ---

export { MARKER_START, MARKER_END };

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
  { name: 'minimal', description: 'Recommended — memory search, workflow gates, MCP tools (~40 lines injected)' },
  { name: 'standard', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo.md)' },
  { name: 'full', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo.md)' },
  { name: 'security', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo.md)' },
  { name: 'performance', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo.md)' },
  { name: 'solo', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo.md)' },
];

export default generateClaudeMd;
