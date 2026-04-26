## ⚠ This repo dogfoods MoFlo — read before any diagnostic

**MoFlo IS the project AND the installed devDependency that drives the editor.** Two layers exist and they routinely diverge:

| Layer | Location | Role |
|-------|----------|------|
| **Source** | `src/cli/...`, `bin/...` (working tree) | What's being edited |
| **Installed** | `node_modules/moflo/...` | What's actually running — Claude Code's SessionStart hooks, daemon, statusline, indexers, embeddings migration all execute from here |

When diagnosing any "X is broken" symptom (statusline numbers, daemon spam, missing upgrade UI, indexer behavior, hook output, anything observable in the editor) the symptom is produced by the **installed** bits — NOT by the source. Diagnostic instinct of "open the source file and read the code" is wrong here unless the install was just refreshed.

**Before opening issues for runtime symptoms, verify the install state:**

```bash
node -p "require('./node_modules/moflo/package.json').version"  # what's running
node -p "require('./package.json').version"                     # source version
git log --oneline -5                                            # what's in source not yet shipped
```

If installed lags source, **publish + reinstall first** (use `/publish`), then re-test. Most "the code is buggy" symptoms turn out to be stale-install artifacts in this repo specifically because of the dogfood loop.

**Corollary:** features must work from `node_modules/moflo/...` paths (consumer perspective), not from source paths anchored on `process.cwd()`. See `feedback_consumer_path_resolution.md`.

---

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
