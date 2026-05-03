# MoFlo Subagents Guide

**Purpose:** Protocol for subagents spawned by coordinators. Follow these steps before doing any work.

---

## 1. Search Memory FIRST

**Before reading any files or exploring code, search memory for guidance relevant to your task.**

### Namespaces to search:

| Namespace | When to search | What it returns |
|-----------|---------------|-----------------|
| `guidance` | always | Guidance docs, coding rules, domain context |
| `patterns` | always | Learned patterns from previous task execution |
| `learnings` | always | User-directed decisions + distilled insights (post-mortems, gotchas, lessons learned) |
| `code-map` | navigating code | Project overviews, directory contents, type-to-file mappings |
| `tests` | test/coverage queries | Indexed test inventory — pinpoint specs and coverage for a given function/module |

**Always search `patterns` and `learnings` alongside `guidance`.** Patterns hold solutions to already-solved problems; learnings hold incident insights and user-stated decisions. Skipping either means repeating past mistakes or violating standing decisions.

**Search `code-map` BEFORE using Glob/Grep for navigation.** It's faster and returns structured results including file-level type mappings.

**Search `tests` when looking for test coverage** of a function, module, or behavior — it indexes the test tree separately so you can pinpoint specs without grepping the whole repo.

### Option A: MCP Tools (Preferred)

If you have MCP tools available (check for `mcp__moflo__*`), use them directly:

| Tool | Purpose |
|------|---------|
| `mcp__moflo__memory_search` | Semantic search with domain-aware embeddings |
| `mcp__moflo__memory_store` | Store patterns with auto-vectorization |
| `mcp__moflo__hooks_route` | Get agent routing suggestions |

### Option B: CLI via Bash

```bash
npx flo memory search --query "[describe your task]" --namespace guidance --limit 5
```

| Your task involves... | Search namespace | Example query |
|-----------------------|------------------|---------------|
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

Use results with score > 0.3. If no good results, fall back to reading project guidance docs.

---

## 2. Check for Project-Specific Overrides

Claude Code automatically loads all `.claude/guidance/*.md` files into your context. If the consuming project has its own guidance files (e.g., domain rules, entity patterns, tech stack conventions), they are already available to you — no need to read them manually.

Project-specific guidance always takes precedence over generic MoFlo guidance.

---

## 3. Universal Rules

### Memory Protocol
- Search memory before exploring files
- Store discoveries back to memory when done
- Use `patterns` namespace for solutions and gotchas
- Use `learnings` namespace for architectural choices, user-requested decisions, and distilled insights (`knowledge` is a deprecated alias — writes are auto-redirected)

### Git/Branches
- Use conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`
- Use branch prefixes: `feature/`, `fix/`, `refactor/`
- Use kebab-case for branch names

### Pull Requests — CRITICAL: Always target the correct repo
**NEVER run bare `gh pr create` in a forked repository.** The `gh` CLI defaults to the upstream parent repo, not the fork's origin. This has caused PRs to be accidentally opened against upstream.

**Required workflow:**
```bash
# 1. Determine the correct repo from the origin remote
REPO=$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')

# 2. ALWAYS pass --repo to gh pr create
gh pr create --repo "$REPO" --title "..." --body "..."

# 3. For merge: also pass --repo
gh pr merge <number> --repo "$REPO" --squash
```

This applies to ALL `gh` commands that target a repo: `pr create`, `pr merge`, `pr list`, `issue create`, etc.

### File Organization
- Never save working files to repository root
- Keep changes focused (3-10 files)
- Stay within feature scope

### Build & Test
- Build and test after code changes
- Never leave failing tests

### Task Icons (MANDATORY)
- `TaskCreate` MUST use **ICON + [Role]** in `subject` and `activeForm`
- Full icon map: `.claude/guidance/shipped/moflo-task-icons.md`
- Example: `🧪 [Tester] Run unit tests` / activeForm: `🧪 Running unit tests`

---

## 4. Store Discoveries

If you discover something new (pattern, solution, gotcha), store it:

### MCP (Preferred):
```
mcp__moflo__memory_store
  namespace: "patterns"
  key: "brief-descriptive-key"
  value: "1-2 sentence insight"
```

### CLI Fallback:
```bash
npx flo memory store --namespace patterns --key "brief-descriptive-key" --value "1-2 sentence insight"
```

**Store:** Solutions to tricky bugs, patterns that worked, gotchas, workarounds
**Skip:** Summaries of retrieved guidance, general rules, file locations

---

## 5. When Complete

1. Report findings to coordinator
2. Store learnings if you discovered something new
3. Coordinator will mark your task as completed

---

## See Also

- `.claude/guidance/shipped/moflo-task-icons.md` — Mandatory ICON + [Role] format for every `TaskCreate` and `Agent` description spawned by a coordinator
- `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md` — How task lists and swarm coordinators cooperate when subagents are spawned in batches
- `.claude/guidance/shipped/moflo-memory-strategy.md` — The memory-search-first rule this protocol enforces, with namespace-selection guidance
- `.claude/guidance/shipped/moflo-memorydb-maintenance.md` — How the memory namespaces are populated and refreshed; required reading when search returns no results
- `.claude/guidance/shipped/moflo-core-guidance.md` — Full CLI/MCP reference including the spell gates that block subagent spawn before memory is searched
