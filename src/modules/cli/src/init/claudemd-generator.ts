/**
 * CLAUDE.md Generator
 *
 * Generates ONLY the MoFlo section to inject into a project's CLAUDE.md.
 * This must be minimal — just enough for Claude to work with moflo.
 * All detailed docs live in .claude/guidance/shipped/moflo-core-guidance.md (copied at install).
 *
 * Principle: we are guests in the user's CLAUDE.md. Keep it small.
 */

import type { InitOptions, ClaudeMdTemplate } from './types.js';

const MARKER_START = '<!-- MOFLO:INJECTED:START -->';
const MARKER_END = '<!-- MOFLO:INJECTED:END -->';

/**
 * The single moflo section injected into CLAUDE.md.
 * ~40 lines. Points to moflo-core-guidance.md for everything else.
 */
function mofloSection(): string {
  return `${MARKER_START}
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development spells.

### FIRST ACTION ON EVERY PROMPT: Search Memory

MUST call \`mcp__moflo__memory_search\` BEFORE any Glob/Grep/Read/file exploration. Namespaces: \`guidance\`+\`patterns\` every prompt; \`code-map\` when navigating code. When the user says "remember this": \`mcp__moflo__memory_store\` with namespace \`knowledge\`.

### Spell Gates (enforced automatically)

- **Memory-first**: Must search memory before Glob/Grep/Read
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool

- **Task Icons**: \`TaskCreate\` MUST use ICON+[Role] format — see \`.claude/guidance/moflo-task-icons.md\`

### MCP Tools (preferred over CLI)

| Tool | Purpose |
|------|---------|
| \`mcp__moflo__memory_search\` | Semantic search across indexed knowledge |
| \`mcp__moflo__memory_store\` | Store patterns and decisions |

### CLI Fallback

\`\`\`bash
flo-search "[query]" --namespace guidance   # Semantic search
flo doctor --fix                             # Health check
\`\`\`

### Full Reference

- **Subagents protocol:** \`.claude/guidance/shipped/moflo-subagents.md\`
- **Task + swarm coordination:** \`.claude/guidance/shipped/moflo-claude-swarm-cohesion.md\`
- **CLI, hooks, swarm, memory, moflo.yaml:** \`.claude/guidance/shipped/moflo-core-guidance.md\`
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
  { name: 'minimal', description: 'Recommended — memory search, spell gates, MCP tools (~40 lines injected)' },
  { name: 'standard', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo-core-guidance.md)' },
  { name: 'full', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo-core-guidance.md)' },
  { name: 'security', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo-core-guidance.md)' },
  { name: 'performance', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo-core-guidance.md)' },
  { name: 'solo', description: 'Same as minimal (detailed docs in .claude/guidance/shipped/moflo-core-guidance.md)' },
];

export default generateClaudeMd;
