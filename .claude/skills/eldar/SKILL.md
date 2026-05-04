---
name: eldar
description: Consult the Eldar — audit a project's moflo + Claude Code setup for portable, high-leverage gaps and guide remediation. Default mode is read-only audit with severity-ranked findings; --fix presents an interactive triage menu and walks the user through each chosen fix (healer, missing CLAUDE.md, sparse guidance, hook/MCP wiring, empty memory namespaces, stack→guidance gaps). Use when starting in a new project, when Claude feels lost or inefficient, when guidance/CLAUDE.md is sparse, or as a periodic health check.
arguments: "[--fix]"
---

# /eldar — Consult the Eldar

The Eldar audit a project's moflo + Claude Code setup for portable, high-leverage gaps. **Audit is read-only by default; `--fix` walks through remediation.** The Eldar consult the **Healer** (`flo healer`, the thematic alias for `flo doctor`), they do not replace them.

**Arguments:** $ARGUMENTS

## Modes

| Mode | Trigger | What it does |
|------|---------|--------------|
| Audit | no flag (default) | Read-only scan; produces categorized findings + top-3 recommendation |
| Fix | `--fix` | Audit, then interactive triage menu; user picks findings to address one at a time |

## Step 0 — Memory First

Before any file reads, run:

```
mcp__moflo__memory_search { query: "guidance rules project conventions stack", namespace: "guidance" }
```

The memory-first gate blocks reads otherwise. The search also surfaces any project-specific conventions the Eldar should weigh in their findings.

## Step 1 — Run the Audit

Walk the checklist below in order. Each check is a single category in the final report. Be explicit about what you find — both presence and absence. Severities: `error` (blocks productive work), `warn` (degrades quality), `info` (suggestion).

### 1a. Setup Health — call the Healer

```bash
npx moflo healer --json
```

Parse the JSON output. Surface every `failed` check as `error`, every `warn` as `warn`. Do **not** invoke `flo doctor` directly — use the `healer` alias for thematic consistency.

### 1b. Index Freshness

Check for `.moflo/moflo.db` (existence + mtime). Query memory namespaces to confirm guidance + code-map are populated:

```
mcp__moflo__memory_stats — { namespace: "guidance" }
mcp__moflo__memory_stats — { namespace: "code-map" }
```

Flag if `entries === 0` (warn) or db missing (error).

### 1c. Version Skew

```bash
npm view moflo version    # latest published
node -e "console.log(require('./package.json').devDependencies?.moflo || require('./package.json').dependencies?.moflo || 'not-installed')"
```

Compute minor-version delta. Warn if behind by ≥3 minors; info if behind by 1–2.

### 1d. Model & Token Routing

```
mcp__moflo__hooks_model-stats — {}
```

If recent sonnet→opus escalation rate exceeds ~30%, flag as `info`: "router escalating frequently — see `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md` for tuning". If stats unavailable (no history), skip silently.

### 1e. CLAUDE.md

Check `CLAUDE.md` (and `.claude/CLAUDE.md`) for:

| Check | Threshold | Severity |
|-------|-----------|----------|
| Exists | required | error if missing |
| Line count | 20–500 | warn if outside range |
| Referenced files exist | every relative path it cites | warn per missing path |

Use `Grep` over the file content for `\.claude/[a-z-]+/[a-z-]+\.md` patterns and verify each path resolves.

### 1f. Guidance Content

Count `.md` files under `.claude/guidance/` (recursive). Severity table:

| File count | Severity |
|------------|----------|
| 0 | warn — "no guidance docs; Claude has nothing project-specific to follow" |
| 1–2 | warn — "very sparse guidance" |
| 3–10 | info |
| 11+ | info |

### 1g. Guidance Structure (only if 1f found ≥1 file)

Invoke `/guidance -a` via the `Skill` tool to run the structural audit. The /guidance skill enforces the universal rules from `.claude/guidance/shipped/moflo-guidance-rules.md` (Purpose lines, See Also, generic H2s, hedged language, 500-line cap, RAG chunking) and is the single source of truth for those checks — never re-implement them here.

Fold the result into the Eldar report under the "Guidance structure" row:

| Outcome of `/guidance -a` | Eldar row severity |
|---------------------------|--------------------|
| 0 files with issues       | ok                 |
| 1–2 files with issues     | info               |
| 3+ files with issues      | warn               |
| `/guidance` itself errors | warn — quote the error verbatim so the user can fix the offending file before re-running |

When the user is in `--fix` mode and chooses guidance fixes from the triage menu (3b), the same /guidance skill is the handoff target — so the audit and the fix flow share one implementation.

### 1h. Memory Health

For each of the canonical namespaces, check entry count:

```
mcp__moflo__memory_stats — { namespace: "guidance" }
mcp__moflo__memory_stats — { namespace: "patterns" }
mcp__moflo__memory_stats — { namespace: "learnings" }
```

Flag empty `learnings` as `info` (project hasn't accumulated decisions yet — fine for new projects). Flag empty `guidance` as `warn` (no indexed guidance means semantic search is degraded).

### 1i. Hooks & MCP Wiring

Read `.claude/settings.json`. Check:

| Check | Severity |
|-------|----------|
| Session-start hook references the moflo launcher | error if missing |
| `mcpServers.moflo` is configured | error if missing |
| `hooks` section exists with at least pre-task/post-task entries | warn if absent |

If settings.json is malformed JSON, surface as `error`.

### 1j. Settings Sanity

Spot-check `.claude/settings.json` for:

- `permissions` block exists (info if absent — every prompt becomes a confirmation)
- `env` block has at least the moflo entries the launcher writes
- `statusLine` is configured (info — quality-of-life, not blocking)

### 1k. Spell Inventory

```bash
npx moflo spell list
```

Flag `info` if count is 0 (no spells registered — user may not know they exist).

### 1l. Subagent Fleet

```
Glob — { pattern: ".claude/agents/**/*.md" }
```

Count the result. `info` if 0 (no project-specific subagents — user is relying entirely on built-ins).

### 1m. Stack → Guidance Cross-Reference (highest leverage)

Detect the project's stack from manifests:

| Manifest | Detected stack |
|----------|----------------|
| `package.json` deps | Node — inspect for React, Next, Drizzle, Prisma, Express, NestJS, Vite, etc. |
| `pyproject.toml` / `requirements.txt` | Python — Django, FastAPI, SQLAlchemy, etc. |
| `Cargo.toml` | Rust — axum, tokio, sqlx, etc. |
| `go.mod` | Go — gin, sqlc, gorm, etc. |
| `Gemfile` | Ruby — Rails, Sidekiq, etc. |

For each detected technology, check whether `.claude/guidance/` mentions it (Grep for the technology name across the directory). Each `(detected stack item, no guidance match)` pair becomes one `info` finding: "uses Drizzle ORM but no DB-conventions guidance — high-leverage gap".

This is the **highest-impact finding** for new adopters. Lead with it in the recommendation.

### 1n. Anti-Pattern from History (best-effort, optional)

If recent transcripts/commits are accessible, scan them for repeated manual work that an existing spell or agent already covers (e.g., 5+ separate `git status`/`git diff`/run-tests sequences in a session that `/simplify` would have handled). Surface as `info`: "consider /simplify for review loops". If unavailable, skip silently — never block the audit on this.

## Step 2 — Render the Report

Output a single table grouped by category, sorted by severity (`error` → `warn` → `info`):

```
ELDAR AUDIT — <project name>
─────────────────────────────

Category               Finding                                    Severity
─────────────────────────────────────────────────────────────────────────
Setup health           Healer reports 0 errors, 1 warning         warn
Index freshness        Guidance index empty                       warn
CLAUDE.md              File missing                               error
Guidance content       0 docs in .claude/guidance/                warn
Memory health          guidance namespace empty                   warn
Stack → guidance       Drizzle ORM in deps; no DB guidance        info
Stack → guidance       React Native; no mobile guidance           info
Hooks & MCP wiring     all wired                                  ok
... (etc) ...
```

Then list the **top 3 ranked recommendations** in plain English, with rationale and citation:

```
TOP 3 RECOMMENDATIONS
─────────────────────

1. Add CLAUDE.md (error)
   Without it, Claude has no project entry point. Use the Eldar's
   stack-aware scaffold via `/eldar --fix`.

2. Add Drizzle conventions guidance (info — high leverage)
   You use Drizzle ORM but have no DB-conventions doc. This is the
   single highest-leverage gap for getting Claude to write idiomatic
   queries and migrations in your codebase. /guidance -a (run inline
   in step 1g) flagged 3 existing docs with structural issues; pick
   one to fix alongside this new one.
   See: .claude/guidance/shipped/moflo-guidance-rules.md

3. Run `flo healer --fix` (warn)
   One auto-fixable warning. Run via `/eldar --fix` and select Healer.
```

End the audit with a one-line prompt: "Run `/eldar --fix` to address these interactively."

## Step 3 — Fix Mode (`--fix` flag only)

After the report, present a numbered triage menu:

```
TRIAGE MENU
───────────
[1] Add CLAUDE.md
[2] Add Drizzle conventions guidance
[3] Run flo healer --fix (1 warning)
[4] Add empty .claude/guidance/ docs to memory namespaces

Choose: all, none, or comma-separated numbers (e.g., 1,3): _
```

Drive each chosen finding through its sub-flow. Confirm before any write.

### 3a. CLAUDE.md scaffold

Ask the user 2–4 targeted questions based on detected stack:

1. "What does this project do? (1-2 sentences for Claude's context)"
2. "Primary tech stack confirmed: <detected list>. Anything missing?"
3. "Any conventions Claude should follow (testing approach, branch model, etc.)?"
4. "Any high-blast-radius areas Claude should be careful with?"

Compose a CLAUDE.md draft incorporating their answers + standard moflo memory-first rule. **Show the draft to the user before writing.** Never auto-fill opinionated content.

### 3b. Stack → guidance authoring

For each chosen stack-gap finding:

- Hand off to `/guidance` skill for the heavy lifting — it already enforces the universal rules.
- Brief the user on what gap will be filled: "drafting Drizzle conventions doc covering query patterns, migrations, schema files".
- Ask 2–4 targeted questions about *their* conventions (not generic Drizzle tips — Claude should follow how *they* use it).
- The `/guidance` skill produces the draft and walks the user through the rules check.

### 3c. Healer fixes

```bash
npx moflo healer --fix
```

Pass through the output verbatim. If the Healer reports manual-only fixes, surface them as next steps.

### 3d. Hook/MCP wiring repair

Suggest:

```bash
npx moflo init --upgrade
```

This is the standard wiring repair path. If the user is wary of running init, surface the specific missing keys from `.claude/settings.json` and offer to write them directly.

### 3e. Empty namespaces

Suggest concrete first entries based on detected stack. Example: "Your project uses Drizzle. Want me to seed `learnings` with the most common Drizzle gotchas as a starting set? You'd review each before storage."

If the user declines, that's fine — empty `learnings` is a valid state for a young project.

### 3f. After each fix

After each chosen fix completes, ask: "Continue to next finding? (y/n)". Don't run them all in a batch — every change is high-leverage and deserves the user's attention.

## Step 4 — Wrap-Up

After audit (or audit + chosen fixes), end with:

- **Audit-only**: One sentence — what was found, what to do next.
- **Fix mode**: One sentence per applied fix, plus a closing line on what remains.

Never leave the user without a clear next step.

## Important

- **Memory-first is mandatory.** Step 0 runs the search; the gate blocks reads otherwise.
- **Call the Healer, not the Doctor.** `npx moflo healer` (alias) — never `flo doctor` — for thematic consistency.
- **No auto-write of opinionated content.** Every guidance doc, every CLAUDE.md draft, every namespace seed gets shown to the user first.
- **Portable only.** This skill ships to consumers via `.claude/skills/**/*.md` in the package files array. Never assume moflo source paths or moflo-internal state.
- **No kitchen sink.** The audit checklist is locked at the categories above. New checks require a specific portable benefit and an issue to discuss them.
- **Read-only by default.** `/eldar` (no flag) never writes. Only `--fix` writes, and only with per-finding confirmation.
- **Hand off to specialists.** `/guidance` for guidance authoring, `flo healer --fix` for setup repair, `flo init --upgrade` for wiring. The Eldar route, they don't reimplement.

## See Also

- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal guidance writing rules used by `/guidance` and surfaced in 1g
- `.claude/skills/guidance/SKILL.md` — The skill `/eldar --fix` hands off to for guidance authoring
- `.claude/guidance/shipped/moflo-core-guidance.md` — moflo CLI / hooks / memory reference; useful when explaining wiring findings
- `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md` — Subagent + task coordination reference cited in routing findings
