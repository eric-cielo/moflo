# Validate Use Before Deleting

**Purpose:** Rule for any deletion or removal in the moflo source tree — files, directories, exports, configuration entries, MCP tool registrations, agent definitions, anything. Looks-broken-on-the-surface is not a license to delete; the surface may be a load-bearing reference target for moflo's own internal dispatch. Confirm zero load-bearing references *before* the `rm -rf`, not after CI complains.

---

## The Rule

**Before deleting any artifact, prove via search that nothing references it as a load-bearing identifier.** "Load-bearing" means moflo's source code, hooks, MCP tools, skill files, command files, or shipped guidance reference the artifact by name to do real work — not just docs/comments mentioning it.

Apply to every deletion. No size threshold. No "obviously broken" exemption. The surface that looks like dead cruft is sometimes the routing target for a code path you haven't read yet.

---

## Why

Deleting first and verifying via CI failure is a *destructive* check — it ships breakage downstream before the test catches it. Reversing the deletion costs more than the search cost would have:

- A reverted commit shows up in `git log` forever as evidence of the misstep.
- If the broken commit shipped to npm, every consumer who upgraded between the publish and the revert hits the breakage.
- "Just delete and let tests catch it" trains the wrong reflex: tests are partial coverage; the absence of a failing test is not proof of safety.

A 90-second grep prevents a 30-minute revert + force-push + apology cycle. Always cheaper.

---

## How to verify (concrete)

For each candidate artifact, run all of the following and require *zero* hits in non-test, non-worktree paths before deleting:

| Artifact type | Search command(s) |
|---------------|-------------------|
| Skill (`.claude/skills/<name>/`) | grep for `'<name>'` and `"<name>"` in `src/cli/init/`, `src/cli/commands/`, `bin/`, `.claude/helpers/`, `.claude/commands/`, `.claude/skills/`, `.claude/agents/` |
| Agent (`.claude/agents/<cat>/<name>.md`) | grep for `'<name>'`, `"<name>"`, `subagent_type[\"' ]*[:=][\"' ]*<name>` in `src/cli/`, `bin/`, `.claude/skills/`, `.claude/commands/` |
| Command (`.claude/commands/<name>.md`) | grep for `'<name>.md'` in `src/cli/init/executor.ts` (COMMANDS_MAP); grep for the slash-command form in `.claude/skills/` and `.claude/guidance/` |
| MCP tool registration | grep for the tool name string in `.claude/skills/`, `.claude/agents/`, `tests/`, `src/cli/__tests__/`; check the `mcp-tools-drift-guard.test.ts` ALLOWLIST |
| Guidance doc (`.claude/guidance/**`) | grep for the bare filename in any `*.md`, `*.ts`, `*.mjs` |
| Source export (TypeScript) | check IDE/tsc for downstream importers; grep for the export name across `src/cli/`, `bin/`, `tests/` |

Exclude `node_modules/`, `dist/`, `.claude/worktrees/`, `coverage/`, and the artifact's own definition file from the search corpus. A non-zero count outside those directories is a stop signal.

---

## What "load-bearing" actually means

A reference is load-bearing when **removing it or removing what it points to changes runtime behavior**. Examples:

| Reference | Load-bearing? |
|-----------|---------------|
| `subagent_type: 'security-architect'` in code | yes — Claude can't spawn the agent if the file is gone |
| `'<name>': 'opus'` in `mcp-tools/agent-tools.ts` model-routing map | yes — moflo routing falls through to a default that may be wrong |
| `value: '<name>'` in agent picker UI registration | yes — the picker dies if the SKILL.md the picker links to is missing |
| Markdown comment `<!-- previously called X -->` referencing a deleted X | no — purely historical |
| Doc text "see also: X" with no clickable path | no (but worth fixing for clarity) |

When uncertain, treat the reference as load-bearing. The cost of preserving an unused reference is one comment; the cost of breaking moflo's dispatch is a revert.

---

## When the deletion still goes ahead

Real load-bearing references can be retired. Do it in this order, never reversed:

1. Replace or remove every load-bearing reference (with a passing test for each).
2. Verify the registration map / dispatcher / consumer no longer needs the artifact.
3. *Then* delete the artifact.
4. Run the full drift-guard test suite (`mcp-tools-drift-guard`, `skills-classification-drift`, `published-package-drift-guard`, `post-install-bootstrap-drift-guard`). All must pass.

If step 1 surfaces a reference that requires nontrivial migration (e.g. modernizing a stale agent body, retargeting a skill name across consumer projects), STOP and surface it as a separate concern. Do not bundle the migration into a "cleanup" PR — it deserves its own scope and its own review.

---

## Anti-patterns this rule catches

- **"It looks like cruft"**: looking-like is not knowing. The 23 v3 / optimization / github agent files in the moflo tree all have `npx claude-flow` invocations in their bodies (legitimately broken bodies) — but most are referenced by `src/cli/commands/agent.ts`, `src/cli/commands/hooks.ts`, `src/cli/mcp-tools/agent-tools.ts` as agent-type identifiers. Delete the file → break the dispatcher.
- **"The CI test will catch it"**: tests are partial. Even `mcp-tools-drift-guard` only checks for token-form references; object-property access (`mcp.swarm_scale(...)`) slips past it. A regex hit count of zero is not the same as zero load-bearing consumers.
- **"I'll just rm and see what breaks"**: this is the failure mode that drove this rule. Each time the cycle ran in this repo it cost a revert, an apology, and stakeholder credibility.
- **Allowlist-as-paper-over**: when a drift test fails because deletion removed a tool's last regex-detectable consumer, never paper over by allowlisting against another file you haven't audited. If the cited justification file is itself stale, the allowlist entry is dishonest.

---

## See Also

- `.claude/guidance/internal/consumer-bound-references.md` — Sibling rule for path strings that ship to consumers
- `.claude/guidance/internal/dogfooding.md` — Why local source state and `node_modules/moflo/` state can disagree (a separate trap)
- `.claude/guidance/internal/pre-publish-rules.md` — The publish gate that catches some, but not all, of the deletions this rule blocks
