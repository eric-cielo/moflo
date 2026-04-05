# Claude Code Configuration - MoFlo

> **MoFlo** — AI agent orchestration for Claude Code. Diverged fork of Ruflo/Claude Flow.
> Published as: `moflo` on npm. Internal CLI workspace: `@moflo/cli`.
> Upstream (read-only reference): `ruflo`, `claude-flow`, `@claude-flow/cli` — do NOT publish to those.

## Behavioral Rules (Always Enforced)

- When writing or revising `.claude/guidance/` documents, ALWAYS read `.claude/guidance/internal/guidance-rules.md` first
- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- ALWAYS write or update tests when changing testable code — no testable change ships without a corresponding test change
- ZERO TOLERANCE for failing tests — if any test fails, fix it before proceeding, whether we caused the failure or not. Pre-existing failures are not acceptable; they must be fixed on sight.

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Source Code Hygiene

**Read `.claude/guidance/shipped/moflo-source-hygiene.md` for full rules.** Key points:

- ALL source files under `src/` are TypeScript — no hand-written `.js` files
- NO cross-package imports between `src/packages/*/src/` directories
- `src/packages/` are internal modules, NOT independently published npm packages
- MCP tools live in `src/packages/cli/src/mcp-tools/` — this is the only canonical location
- Never commit `dist/` build artifacts to git

## Cross-Platform Compatibility

**Read `.claude/guidance/shipped/moflo-cross-platform.md` for full rules.** Key points:

- ALL code changes MUST work on Linux, macOS, and Windows
- Use `path.join()`/`path.resolve()` — never hardcoded `\` separators or drive letters
- Use `pathToFileURL()` for dynamic imports — never `file://` string concatenation
- Use `.split(/\r?\n/)` on file content — never `.split('\n')`
- Use `os.homedir()` — never raw `process.env.HOME`
- Use `path.isAbsolute()` — never `startsWith('/')`
- Bin scripts MUST have LF line endings and `#!/usr/bin/env node` shebangs

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Ensure input validation at system boundaries

### Key Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@moflo/cli` | `src/packages/cli/` | CLI entry point (40+ commands) |
| `@moflo/guidance` | `src/packages/guidance/` | Governance control plane |
| `@moflo/hooks` | `src/packages/hooks/` | Hooks + workers |
| `@moflo/memory` | `src/packages/memory/` | AgentDB + HNSW search |
| `@moflo/security` | `src/packages/security/` | Input validation, CVE remediation |
| `@moflo/embeddings` | `src/packages/embeddings/` | Vector embeddings (sql.js, HNSW) |
| `@moflo/neural` | `src/packages/neural/` | Neural patterns (SONA) |
| `@moflo/plugins` | `src/packages/plugins/` | Plugin system |
| `@moflo/workflows` | `src/packages/workflows/` | Workflow engine, step commands, YAML/JSON definitions |

## MoFlo is a Library (CRITICAL)

MoFlo is installed as a `devDependency` in **other projects**. Every feature, command, and check MUST work when running from `node_modules/moflo/` in a consumer project — not just in the moflo dev repo. This is the single most common source of bugs.

### Consumer-Project Checklist (apply to ALL new code)

1. **`src/tsconfig.json` references** — add the package so `tsc -b` builds it
2. **Root `package.json` `files` array** — add `dist/**/*.js`, `dist/**/*.d.ts`, and `package.json` entries (exclude `.map` files). If a module is not in `files`, it does not ship to consumers.
3. **Never compile in-place** — always use `outDir: "./dist"` via `tsc -p tsconfig.json`; never run bare `tsc` from within `src/`
4. **Path resolution for consumer project root** — bin scripts and loaders must use `findProjectRoot()`, not `__dirname`, to find the consumer's project root
5. **Path resolution for moflo internals** — code that loads moflo's own modules at runtime (dynamic `import()`, `require()`) MUST resolve from `import.meta.url` (walking up to the moflo `package.json`), NEVER from `process.cwd()`. `process.cwd()` points to the consumer's project, not to moflo's install location.
6. **Dynamic imports need file:// URLs on Windows** — always wrap absolute paths with `pathToFileURL(path).href` before passing to `import()`
7. **Only `.js` files can be dynamically imported** — never import `.ts` source files at runtime; always target compiled `dist/**/*.js`
8. **Verify with installed copy** — after adding new runtime-loaded modules, check they exist under `node_modules/moflo/` (run `npm pack --dry-run | grep <file>` to verify they're in the published package)

## Publishing to npm

- We publish **one package**: `moflo`
- Internal CLI workspace: `@moflo/cli` (bundled, NOT published separately)
- Upstream packages (`@claude-flow/cli`, `claude-flow`, `ruflo`) are **not ours** — never publish to them

### Build, Test & Publish

See `docs/BUILD.md` for the complete, canonical process. Quick reference:

```bash
git pull origin main                        # ALWAYS pull first
npm run build                               # tsc -b from root (NOT from src/)
npm test                                    # Must pass — 0 failures
npm version patch --no-git-tag-version      # Bumps root + cli package.json
npm run build                               # Rebuild with new version
npm publish --otp=<code>                    # Requires OTP
npm view moflo version                      # Verify
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

- **Subagents protocol:** `.claude/guidance/shipped/moflo-subagents.md`
- **Task + swarm coordination:** `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md`
- **CLI, hooks, swarm, memory, moflo.yaml:** `.claude/guidance/shipped/moflo-core-guidance.md`
<!-- MOFLO:INJECTED:END -->
