# Guidance Rules — Moflo-Only Extensions

**Purpose:** Moflo-specific extensions to the universal guidance-authoring rules. Use this whenever you create or revise guidance INSIDE the moflo repo. The universal writing rules (Purpose line, imperative voice, decision tables, concrete examples, 500-line cap, specific headings, anti-patterns, RAG chunking, See Also) live in `shipped/moflo-guidance-rules.md` — read those first; the rules below only cover what's unique to moflo's two-bucket layout.

> **The universal rules live in `shipped/moflo-guidance-rules.md`.** This doc is moflo-specific.

---

## 1. Shipped Guidance File Naming

**All shipped guidance files in `.claude/guidance/shipped/` MUST begin with the `moflo-` prefix** (e.g., `moflo-subagents.md`, `moflo-memory-strategy.md`). This prevents name collisions when these files are synced into a consumer project's `.claude/guidance/` directory, where the project may already have its own guidance files with generic names like `subagents.md` or `memory-strategy.md`.

The prefix is applied statically at the source — the sync process copies files as-is without modifying names.

Consumer projects writing their OWN guidance do NOT use this prefix; the prefix is moflo-specific because moflo's files travel into other people's directories.

---

## 2. Ship-vs-Local Partitioning Contract

**Three buckets, one ship boundary.** `package.json` `files` includes only `.claude/guidance/shipped/**`; everything else stays local.

| Path | Tracked? | Ships? | Purpose |
|------|----------|--------|---------|
| `.claude/guidance/shipped/moflo-*.md` | yes | yes | Consumer-facing rules (CLI, swarm, memory, spells, sandboxing, icons, language, etc.) |
| `.claude/guidance/internal/*.md` | yes | no | Dev-only (this file, dogfooding, testing, coding-style, upgrade-contract, guidance-sync, pre-publish-rules) |
| `.claude/guidance/*.md` (top level) | no | no | Auto-generated mirror written by session-start launcher; consumers regenerate on install |

**Gitignore must target only the top-level mirror.** Use `/.claude/guidance/*.md` — a bare `.claude/guidance/` will silently swallow `shipped/` and `internal/` too, and the failure is invisible because `npm pack` ships from the working tree (not git), so a fresh CI clone publishes an incomplete `shipped/` set.

**CLAUDE.md cross-references should point to `shipped/` paths**, not the top-level mirror. The mirror only exists once session-start has run; `shipped/` is the durable source.

---

## 3. Deciding Where a New Guidance File Lives

**Pick the destination BEFORE writing.** Rules #1 and #2 say WHAT each bucket holds; this rule says HOW to choose between them, and HOW to actually ship a doc once you've chosen.

### Decision Table

| Question | If yes | Destination |
|----------|--------|-------------|
| Is the audience a Claude session running INSIDE a consumer project? | yes | `shipped/` |
| Does it document a moflo CLI/MCP surface, agent, hook, spell, or config field? | yes | `shipped/` |
| Could a regression in this doc break a consumer's workflow? | yes | `shipped/` |
| Will only moflo developers ever read this (build, release, dogfooding, sync pipelines, upgrade contract)? | yes | `internal/` |
| Does it describe source-vs-installed mechanics, dogfood gotchas, or publish gates? | yes | `internal/` |
| Is the content tied to repo structure that doesn't exist in consumer projects? | yes | `internal/` |

**When in doubt, choose `internal/`.** Promotion (internal → shipped) is cheap: rename + add `moflo-` prefix. Demotion (shipped → internal) is more disruptive because consumers may have built workflows around the doc. Shipped guidance is a public surface; treat new entries with the same care as a CLI flag.

### Mechanical Steps to Ship a New Guidance File

Once you've decided shipping is right, the actual mechanics are minimal:

1. **Filename** — save as `.claude/guidance/shipped/moflo-<topic>.md`. The `moflo-` prefix is mandatory (rule #1 of this doc).
2. **Structure** — H1, then `**Purpose:**` line, then body following `shipped/moflo-guidance-rules.md` rules #1–#8, then `## See Also` (rule #9 there).
3. **No `package.json` edit needed** — the `files` array already globs `.claude/guidance/shipped/**`. Sanity-check with `npm pack --dry-run | grep moflo-<topic>` if paranoid.
4. **No source-code edit needed** — `syncAllShippedGuidance()` in `src/cli/init/moflo-init.ts` discovers `*.md` files dynamically; the launcher copies them to consumers via section 3 (see `internal/guidance-sync.md`).
5. **No new test needed** — `commands-deep.test.ts:1558` only asserts the CLAUDE.md injection points at `moflo-core-guidance.md`; new sibling docs don't break it.
6. **Cross-link bidirectionally** — add a See Also entry in at least one related shipped doc that points back at the new file. The hub is `moflo-core-guidance.md`; sibling links go through the most relevant topical neighbor.
7. **Local verification** — `node bin/index-guidance.mjs` and confirm `chunk-guidance-moflo-<topic>-*` rows appear (per `internal/guidance-sync.md` § Verification Recipe).

### Mechanical Steps to Promote internal → shipped

If a doc starts in `internal/` and later earns its place in `shipped/`:

1. `git mv .claude/guidance/internal/<topic>.md .claude/guidance/shipped/moflo-<topic>.md`
2. Re-frame the `**Purpose:**` line for the consumer audience (no "moflo developers" framing).
3. Update inbound See Also references — `grep -rn "<topic>.md" .claude/guidance/` finds them all.
4. Update the partition table in rule #2 if the move changes the per-bucket enumeration.

### Mechanical Steps to Demote shipped → internal

This is rarer and riskier — only do it when you're sure no consumer relies on the doc:

1. `git mv .claude/guidance/shipped/moflo-<topic>.md .claude/guidance/internal/<topic>.md`
2. Drop the `moflo-` prefix.
3. Verify the launcher's section 3 manifest-diff cleanup will prune the consumer's old top-level mirror (per `internal/guidance-sync.md` Layer 1).
4. Update inbound See Also references.

---

## See Also

- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal writing rules (#1–#9) every guidance file in any project must follow; this doc only adds the moflo-specific bucket extensions on top of those
- `.claude/guidance/internal/dogfooding.md` — The shipped-vs-internal partition this doc enforces, framed from the dogfood loop's perspective
- `.claude/guidance/internal/upgrade-contract.md` — Where the "user never re-runs init" invariant for guidance sync is defined
- `.claude/guidance/internal/coding-style.md` — Sibling style rules but for source code; both files share the imperative/concrete/specific posture
- `.claude/guidance/shipped/moflo-memory-strategy.md` — Companion shipped doc on writing guidance that indexes well for RAG (consumer audience)
- `.claude/guidance/shipped/moflo-session-start.md` — Where shipped guidance gets synced to consumer projects (and why the `moflo-` prefix matters there)
- `.claude/guidance/internal/guidance-sync.md` — Three-layer sync pipeline (filesystem → DB → HNSW); the chunking decisions in the universal rules feed Layer 2's behavior
- `.claude/skills/guidance/SKILL.md` — `/guidance` skill that exercises the universal rules in consumer projects (uses only the shipped doc, not this internal one)
