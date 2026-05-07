---
name: healer
description: Run moflo's Healer (`flo healer`, alias for `flo doctor`) from inside the Claude session. Audit-only by default; pass `--fix` to apply auto-repairs, `-c <component>` for a single check. Use when something feels off (missing moflo.yaml, daemon dead, statusline empty, hooks not firing) or as a periodic health check. Distinct from Claude Code's built-in `/doctor`, which diagnoses Claude Code itself, not moflo.
arguments: "[--fix] [-c <component>]"
---

# /healer — moflo Installation Healer

Thin wrapper around the `flo healer` CLI. All check + fix logic lives in the CLI; this skill just shells out, surfaces results in-thread, and gives one-line follow-up nudges.

**Arguments:** $ARGUMENTS

## Procedure

1. **Memory first** (gate requirement):
   ```
   mcp__moflo__memory_search { query: "doctor healer fix moflo.yaml gate hook wiring", namespace: "guidance" }
   ```

2. **Run the CLI** with the user's arguments passed through:
   ```bash
   npx moflo healer --json $ARGUMENTS
   ```
   - No args → audit-only.
   - `--fix` → CLI runs auto-repairs after the audit.
   - `-c <component>` → restricts to one check.
   - Always include `--json` so output is machine-parseable.

3. **Surface the JSON in-thread**. Group by status:
   - `✓ N passing` (count only)
   - `⚠ warnings` — list `name: message`; flag with `[auto-fixable]` when the result has a `fix` field
   - `✗ failures` — same
   - If `--fix` mode, also list which fixes were applied vs which need manual action.

4. **Nudge based on what changed.** Only mention next steps for state that *actually* changed:
   - Daemon restarted → `Statusline should refresh within ~5s.`
   - `moflo.yaml` created → `Review the new defaults at the project root before your next deep run.`
   - Hook wiring repaired → `Restart Claude Code so the new SessionStart hook fires next launch.`
   - In audit-only mode with auto-fixable issues → `Run /healer --fix to repair.`

## Rules

- **Don't** re-document checks or fixes here. The CLI's `--help` and `src/cli/commands/doctor-*` are the source of truth.
- **Don't** call `flo doctor` directly — use the `healer` alias for thematic consistency. They're equivalent CLI-side.
- **Don't** swallow non-zero exit codes silently — surface them in the summary.
- **Note for users:** Claude Code has its own built-in `/doctor` command that diagnoses Claude Code itself. This skill (`/healer`) diagnoses **moflo**, not Claude Code. The two are complementary, not duplicates — and the healer also runs `claude doctor` internally as a delegated check (`Claude Code Doctor`) so Claude-side issues (auth, settings drift, IDE/extension state) surface in the same report. With `--fix`, the healer re-runs `claude doctor` interactively so you can see and act on its findings; Claude-side fixes typically need user gestures (re-auth, IDE reload) and aren't auto-applied.

## See Also

- `flo doctor --help` — full flag/component list
- `/eldar` — broader project-setup audit; consults the Healer as one input
