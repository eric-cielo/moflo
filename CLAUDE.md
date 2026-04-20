<!-- MOFLO:INJECTED:START -->
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development spells.

### FIRST ACTION ON EVERY PROMPT: Search Memory

MUST call `mcp__moflo__memory_search` BEFORE any Glob/Grep/Read/file exploration. Namespaces: `guidance`+`patterns` every prompt; `code-map` when navigating code. When the user says "remember this": `mcp__moflo__memory_store` with namespace `knowledge`.

### Spell Gates (enforced automatically)

- **Memory-first**: Must search memory before Glob/Grep/Read
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool

- **Task Icons**: `TaskCreate` MUST use ICON+[Role] format — see `.claude/guidance/moflo-task-icons.md`

### MCP Tools (preferred over CLI)

| Tool | Purpose |
|------|---------|
| `mcp__moflo__memory_search` | Semantic search across indexed knowledge |
| `mcp__moflo__memory_store` | Store patterns and decisions |

### CLI Fallback

```bash
flo-search "[query]" --namespace guidance   # Semantic search
flo doctor --fix                             # Health check
```

### Full Reference

- **Subagents protocol:** `.claude/guidance/shipped/moflo-subagents.md`
- **Task + swarm coordination:** `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md`
- **CLI, hooks, swarm, memory, moflo.yaml:** `.claude/guidance/shipped/moflo-core-guidance.md`
<!-- MOFLO:INJECTED:END -->

## Broken Window Theory (mandatory — moflo repo only)

Zero tolerance for unresolved failures. Every failing test, every warning, every bug gets fixed before moving on — no exceptions by severity, no "probably flaky" without individual re-verification. If a test fails in the full suite, retest individually to distinguish real failures from flaky ones. If flaky, fix the flakiness itself (tight timeouts, resource contention, etc.) — don't just re-run and move on. A red signal is never acceptable as background noise.
