# Spell Troubleshooting — Sandbox, Network, and Permission Failures

**Purpose:** Diagnostic playbook for spell step failures that look like environmental issues but are actually capability/sandbox boundaries. Reference this when a step "should work" but produces DNS errors, silent no-ops, or confusing downstream failures. Pair with `.claude/guidance/moflo-spell-sandboxing.md` for the underlying enforcement model.

---

## Bash Step Fails With DNS / SSH Resolution Errors

The single most common spell failure mode. The step works fine in your normal shell, then fails inside a spell with what looks like a network/DNS problem.

### Typical Error Messages

- `ssh: Could not resolve hostname github.com: Temporary failure in name resolution`
- `fatal: Could not read from remote repository.`
- `curl: (6) Could not resolve host ...`
- `getaddrinfo ENOTFOUND ...`
- Any other DNS/connection failure where the **same command works in your normal shell**.

### Tell-Tale Clue

The error mentions `Temporary failure in name resolution` — a **glibc-specific** wording. That means the step is running inside a Linux sandbox (`bwrap` on Linux / WSL), **not** your outer shell. Git Bash or PowerShell won't produce that exact message.

### Root Cause

`src/cli/spells/core/bwrap-sandbox.ts` isolates the network by default:

```ts
if (!hasNet && !needsToolHomeAccess(options.permissionLevel)) {
  args.push('--unshare-net');   // ← no network, no DNS
}
```

A bash step gets network access **only when one of these is true**:

1. The step declares a `net` capability, **or**
2. The step's `permissionLevel` is `elevated` or `autonomous`.

If neither applies, bwrap runs the command in a namespace with `--unshare-net`, and DNS silently fails. **There is no log line announcing the network was taken away** — you just see the command's own DNS error.

### Fix

For any bash step that does `git pull` / `git push` / `git fetch`, `gh` API calls, `curl`, `npm install`, or any other outbound network call:

```yaml
- id: create-branch
  type: bash
  permissionLevel: elevated       # ← grants network in bwrap
  config:
    command: "git pull origin main && ..."
```

Or declare the `net` capability explicitly if the step doesn't need the full `elevated` profile. **Note:** `bash-command.ts` must include `net` in its declared capabilities for the engine to accept the grant — otherwise you'll see:

```
Capability violation: step type "bash" does not declare capability "net"
```

### Quick Diagnosis Checklist

When a spell's bash step can't reach the network, walk through these in order:

| # | Question | If yes |
|---|----------|--------|
| 1 | Does the same command work in your outer shell? | Sandbox-related, not config — go to #2 |
| 2 | Is the error wording glibc-style (`Temporary failure in name resolution`)? | bwrap is involved — go to #3 |
| 3 | Does the failing step have `permissionLevel: elevated` or a `net` capability? | If no, add one and retry |
| 4 | Does the multi-command step start with `set -e`? | If no, add it (see § Multi-Command `set -e` Traps below) |

---

## Multi-Command `set -e` Traps

A bash step that chains multiple statements without `set -e` will **return exit code 0 even when the real work failed**, producing confusing errors several steps later.

### Symptom

A spell step appears to succeed (`exitCode: 0`), but a later step fails with something that should have been impossible — typically:

- `pathspec did not match` on a branch that was never created
- `nothing to commit` when you expected staged changes
- File operations on paths that don't exist

### Root Cause

Without `set -e`, a multi-command bash step like this:

```yaml
- id: prep-branch
  type: bash
  config:
    command: "git pull origin main && git checkout -b feat/x && git stash pop || true"
```

…will mask a failure in `git pull` (e.g. blocked by `--unshare-net`) because the trailing `git stash pop || true` returns 0 for the whole step. Downstream steps assume the branch exists and produce the confusing `pathspec` error.

### Fix

Lead every multi-command bash step with `set -e`:

```yaml
- id: prep-branch
  type: bash
  permissionLevel: elevated
  config:
    command: |
      set -e
      git pull origin main
      git checkout -b feat/x
      git stash pop || true   # only this one is allowed to fail
```

`set -e` makes the shell exit on any non-zero status, surfacing the real failure at the right step.

---

## Capability Violation Errors

When a spell YAML restricts capabilities a command doesn't declare, or grants new types beyond the command's defaults, the runner blocks execution before the step runs.

| Error | Meaning | Fix |
|-------|---------|-----|
| `Capability violation: step type "X" does not declare capability "Y"` | YAML restricts a capability the step command doesn't list | Add `Y` to the step command's `capabilities` array (in code), or remove the restriction from YAML |
| `CAPABILITY_DENIED at runtime` | A command tried to access a path/host outside its effective scope | Tighten the command, or widen the YAML capability scope to include the resource |

See `.claude/guidance/moflo-spell-sandboxing.md` § Enforcement at Runtime for the two-layer enforcement model.

---

## Step Silently No-Ops

A step appears to run (`exitCode: 0`), produces no output, and downstream steps act as if no work happened.

| Likely cause | Diagnostic |
|--------------|------------|
| Command writes to stdout but bwrap blocks the working directory | Check `permissionLevel`; bwrap restricts `fs:write` to declared scopes |
| Variable interpolation produced an empty string | Run with `dryRun: true` to see resolved configs (see `moflo-spell-runner.md`) |
| `continueOnError: true` is hiding a real failure | Remove `continueOnError` temporarily, re-run, inspect error output |
| Trailing `|| true` on the only critical statement | Restructure with `set -e` and place `|| true` only on cleanup statements |

---

## See Also

- `.claude/guidance/moflo-spell-sandboxing.md` — Capability types, enforcement layers, permission levels (the model these failures exercise)
- `.claude/guidance/moflo-spell-engine.md` — Step definition format and types
- `.claude/guidance/moflo-spell-runner.md` — Dry-run validation, error codes, pause/resume
- `.claude/guidance/moflo-spell-scheduling.md` — Scheduled-spell-specific failure modes (catch-up window, overlap, missing spell auto-disable, daemon-down)
- `.claude/guidance/moflo-yaml-reference.md` — `sandbox:` block in `moflo.yaml` (master toggle, tier selection)
- `src/cli/spells/core/bwrap-sandbox.ts` — Source for `--unshare-net` and namespace setup
- `src/cli/spells/core/permission-resolver.ts` — Capability → permission level derivation
