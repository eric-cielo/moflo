# MoFlo Agent Rules — Universal Coordination & Coding Discipline

**Purpose:** Universal rules every moflo agent — coordinator OR subagent — must follow. The coordinator's CLAUDE.md injection enforces the trigger rules inline (memory-first, TaskCreate-first, icons); this doc is the canonical reference for *all* shared behavior. Subagents reach these rules through `.claude/guidance/moflo-subagents.md` § Universal Agent Rules.

---

## Memory-First Protocol

**Before reading any files or exploring code, search memory.** Memory search is faster than Glob/Grep and returns domain-aware, semantically scored results that file-system tools cannot provide.

### Namespaces

| Namespace | When to search | What it returns |
|-----------|---------------|-----------------|
| `guidance` | always | Guidance docs, coding rules, domain context |
| `patterns` | always | Learned patterns from previous task execution |
| `learnings` | always | User-directed decisions + distilled insights (post-mortems, gotchas, lessons learned) |
| `code-map` | navigating code | Project overviews, directory contents, type-to-file mappings |
| `tests` | test/coverage queries | Indexed test inventory — pinpoint specs and coverage for a given function/module |

**Always search `patterns` and `learnings` alongside `guidance`.** Patterns hold solutions to already-solved problems; learnings hold incident insights and standing decisions. Skipping either repeats past mistakes or violates user-stated decisions.

**Search `code-map` BEFORE Glob/Grep** for navigation — it's faster and returns structured results including file-level type mappings.

**Search `tests` when looking for test coverage** of a function, module, or behavior — it indexes the test tree separately so you can pinpoint specs without grepping the whole repo.

### Traverse Chunks, Don't Bulk-Retrieve

Search returns chunked guidance with a compact `navigation` crumb (`parentDoc`, `prevChunk`, `nextChunk`, `chunkTitle`). Use it:

| Want | Use |
|------|-----|
| Adjacent / sibling / hierarchical context | `mcp__moflo__memory_get_neighbors` |
| Full content of one chunk | `mcp__moflo__memory_retrieve` (returns full nav for further traversal) |
| Whole source doc | `Read` `parentPath` from any chunk's nav |

Full protocol: `.claude/guidance/moflo-memory-protocol.md`. Don't retrieve every search hit blindly.

### Tool Selection (MCP-first)

| Tool | Purpose |
|------|---------|
| `mcp__moflo__memory_search` | Semantic search with domain-aware embeddings (preferred) |
| `mcp__moflo__memory_store` | Store patterns with auto-vectorization |
| `mcp__moflo__hooks_route` | Get agent routing suggestions |

**CLI fallback** when MCP is unavailable:

```bash
npx flo memory search --query "[describe your task]" --namespace guidance --limit 5
```

Use results with score > 0.3. If no good results, fall back to reading project guidance docs directly.

### Query Examples

| Your task involves... | Namespace(s) | Example query |
|-----------------------|--------------|---------------|
| Database/entities | `guidance` + `patterns` + `learnings` | `"database entity migration"` |
| Frontend components | `guidance` + `patterns` + `learnings` | `"React frontend component"` |
| API endpoints | `guidance` + `patterns` + `learnings` | `"API route endpoint pattern"` |
| Authentication | `guidance` + `patterns` + `learnings` | `"auth middleware JWT"` |
| Prior solutions/gotchas | `patterns` + `learnings` | `"audit log service pattern"` |
| Past incident/lesson | `learnings` | `"windows postinstall file locks"` |
| Where is a file/type? | `code-map` | `"CompanyEntity file location"` |
| What's in a directory? | `code-map` | `"back-office api routes"` |
| Tests for a function | `tests` | `"audit log service tests"` |
| Coverage for a module | `tests` | `"auth middleware test cases"` |

---

## MCP Over CLI

**Prefer `mcp__moflo__*` tools over `npx flo` CLI commands.** MCP tools coordinate strategy directly without subprocess overhead, return structured results, and respect the same auth/config as the rest of the moflo stack.

| Layer | Examples |
|-------|----------|
| MCP (preferred) | `mcp__moflo__swarm_init`, `mcp__moflo__agent_spawn`, `mcp__moflo__memory_store`, `mcp__moflo__hooks_*` |
| CLI (fallback) | `npx flo swarm init …`, `npx flo memory store …` |

CLI is the fallback when MCP is unavailable (`.mcp.json` missing, MCP server stopped). See `.claude/guidance/moflo-core-guidance.md` for the full MCP catalog.

---

## Task Icons — Mandatory ICON + [Role] Format

**Every `TaskCreate` and `Agent` description MUST use `ICON + [Role]` prefix** so the user can visually identify which specialist is working.

```
TaskCreate({ subject: "🧪 [Tester] Run unit tests", activeForm: "🧪 Running unit tests" })
Task({ ..., description: "🔍 [Researcher] Investigate failing test" })
```

The full icon map (researcher 🔍, coder 💻, tester 🧪, reviewer 👀, etc.) lives in `.claude/guidance/moflo-task-icons.md`. The format itself is enforced by the `tests/guidance/lint-guidance.test.ts` linter — guidance examples missing icons fail CI.

---

## Git & Branch Conventions

| Element | Convention |
|---------|-----------|
| Commit message prefix | `feat:`, `fix:`, `refactor:`, `test:`, `chore:` |
| Branch prefix | `feature/`, `fix/`, `refactor/` |
| Branch case | kebab-case (`feature/add-billing-export`, not `feature/AddBillingExport`) |

---

## Pull Requests — CRITICAL: Always Target the Correct Repo

**NEVER run bare `gh pr create` in a forked repository.** The `gh` CLI defaults to the upstream parent repo, not your fork's origin. This has caused PRs to be accidentally opened against upstream projects.

**Required workflow:**

```bash
# 1. Determine the correct repo from the origin remote
REPO=$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')

# 2. ALWAYS pass --repo to gh pr create
gh pr create --repo "$REPO" --title "..." --body "..."

# 3. For merge: also pass --repo
gh pr merge <number> --repo "$REPO" --squash
```

This applies to ALL `gh` commands that target a repo: `pr create`, `pr merge`, `pr list`, `issue create`, `issue comment`, etc.

---

## File Organization

| Rule | Detail |
|------|--------|
| Never save working files to repository root | Use `tmp/`, `scratch/`, or a feature-specific directory |
| Keep changes focused (3–10 files per PR) | Larger churn loses reviewer attention and increases revert blast-radius |
| Stay within feature scope | Drive-by refactors belong in their own PR; bundling them dilutes review and risk-shares unrelated changes |

---

## Build & Test Discipline

| Rule | Detail |
|------|--------|
| Build and test after code changes | `npm run build && npm test` — surface breakage at the change boundary, not at PR review |
| Never leave failing tests | "Probably flaky" without re-verification is banned. Fix every red signal at the source |
| Per-test timeout bumps are not a fix | Slow tests are bugs in the test or the code under test — never bump timeout >30 s as a workaround |

---

## Storing Discoveries

When you discover something new during work — a pattern that worked, a gotcha you hit, a workaround for a limitation — store it so future agents don't repeat the discovery cost:

**MCP (preferred):**

```
mcp__moflo__memory_store
  namespace: "patterns"
  key: "brief-descriptive-key"
  value: "1–2 sentence insight"
```

**CLI fallback:**

```bash
npx flo memory store --namespace patterns --key "brief-descriptive-key" --value "1–2 sentence insight"
```

| Namespace | What to store |
|-----------|---------------|
| `patterns` | Solutions to tricky bugs, patterns that worked, gotchas, workarounds |
| `learnings` | Architectural choices, user-stated decisions, post-mortem insights (`knowledge` is a deprecated alias — writes auto-redirect) |

**Skip** generic summaries of retrieved guidance, restated rules, and trivial file-location notes — those waste retrieval bandwidth on every future search.

---

## See Also

- `.claude/guidance/moflo-subagents.md` — Spawn protocol that consumes these universal rules
- `.claude/guidance/moflo-task-icons.md` — Full ICON + [Role] format and icon map
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — How `TaskCreate` and swarm coordination layer on top of these rules
- `.claude/guidance/moflo-memory-strategy.md` — How memory search works under the hood (embeddings, RAG indexing, namespaces)
- `.claude/guidance/moflo-core-guidance.md` — CLI/MCP reference and Auto-Learning protocol
- `.claude/guidance/moflo-guidance-rules.md` — Rules for *writing* guidance docs (different audience: doc authors, not agents)
