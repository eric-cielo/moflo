# Claude Code Configuration - MoFlo

> **MoFlo** — AI agent orchestration for Claude Code. Diverged fork of Ruflo/Claude Flow.
> Published as: `moflo` on npm. Internal CLI workspace: `@moflo/cli`.
> Upstream (read-only reference): `ruflo`, `claude-flow`, `@claude-flow/cli` — do NOT publish to those.

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- ALWAYS write or update tests when changing testable code — no testable change ships without a corresponding test change

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Ensure input validation at system boundaries

### Key Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@moflo/cli` | `src/@claude-flow/cli/` | CLI entry point (40+ commands) |
| `@claude-flow/guidance` | `src/@claude-flow/guidance/` | Governance control plane |
| `@claude-flow/hooks` | `src/@claude-flow/hooks/` | Hooks + workers |
| `@claude-flow/memory` | `src/@claude-flow/memory/` | AgentDB + HNSW search |
| `@claude-flow/security` | `src/@claude-flow/security/` | Input validation, CVE remediation |
| `@claude-flow/embeddings` | `src/@claude-flow/embeddings/` | Vector embeddings (sql.js, HNSW) |
| `@claude-flow/neural` | `src/@claude-flow/neural/` | Neural patterns (SONA) |
| `@claude-flow/plugins` | `src/@claude-flow/plugins/` | Plugin system + RuVector integration |

## Publishing to npm

- We publish **one package**: `moflo`
- Internal CLI workspace: `@moflo/cli` (bundled, NOT published separately)
- Upstream packages (`@claude-flow/cli`, `claude-flow`, `ruflo`) are **not ours** — never publish to them

### Version Alignment

Both files must match. Root `package.json` is source of truth.

```bash
npm version <new-version> --no-git-tag-version
cd src/@claude-flow/cli && npm version <new-version> --no-git-tag-version && cd -
cd src/@claude-flow/cli && npm run build && cd -
npm publish
npm view moflo dist-tags --json  # Verify
```

## Upstream Sync

MoFlo tracks cherry-picks from upstream Ruflo/Claude Flow. Check `UPSTREAM_SYNC.md` before merging upstream changes.

## Support

- Documentation: https://github.com/eric-cielo/moflo
- Issues: https://github.com/eric-cielo/moflo/issues

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
npx flo-search "[query]" --namespace guidance   # Semantic search
npx flo doctor --fix                             # Health check
```

### Full Reference

For CLI commands, hooks, agents, swarm config, memory commands, and moflo.yaml options, see:
`.claude/guidance/shipped/moflo.md`
<!-- MOFLO:INJECTED:END -->
