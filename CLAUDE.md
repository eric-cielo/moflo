<!-- MOFLO:INJECTED:START -->
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development workflows.

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call for every new user prompt MUST be a memory search. Do this BEFORE Glob, Grep, Read, or any file exploration.

```
mcp__moflo__memory_search — query: "<task description>", namespace: "guidance" or "patterns" or "code-map"
```

Search `guidance` and `patterns` namespaces on every prompt. Search `code-map` when navigating the codebase.
When the user asks you to remember something: `mcp__moflo__memory_store` with namespace `knowledge`.

### Workflow Gates (enforced automatically)

- **Memory-first**: Must search memory before Glob/Grep/Read
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool

- **Task Icons**: `TaskCreate` MUST use ICON+[Role] format — see `.claude/guidance/moflo-task-icons.md`

### MCP Tools (preferred over CLI)

| Tool | Purpose |
|------|---------|
| `mcp__moflo__memory_search` | Semantic search across indexed knowledge |
| `mcp__moflo__memory_store` | Store patterns and decisions |
| `mcp__moflo__hooks_route` | Route task to optimal agent type |
| `mcp__moflo__hooks_pre-task` | Record task start |
| `mcp__moflo__hooks_post-task` | Record task completion for learning |

### CLI Fallback

```bash
flo-search "[query]" --namespace guidance   # Semantic search
flo doctor --fix                             # Health check
```

### Broken Window Theory (mandatory)

Zero tolerance for unresolved failures. Every failing test, every warning, every bug gets fixed before moving on — no exceptions by severity, no "probably flaky" without individual re-verification. If a test fails in the full suite, retest individually to distinguish real failures from flaky ones. If flaky, fix the flakiness itself (tight timeouts, resource contention, etc.) — don't just re-run and move on. A red signal is never acceptable as background noise.

### Full Reference

- **Subagents protocol:** `.claude/guidance/shipped/moflo-subagents.md`
- **Task + swarm coordination:** `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md`
- **CLI, hooks, swarm, memory, moflo.yaml:** `.claude/guidance/shipped/moflo-core-guidance.md`
<!-- MOFLO:INJECTED:END -->
