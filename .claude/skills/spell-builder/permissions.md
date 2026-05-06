# Spell Permissions — Disclosure & Dry-Run Reporting

Purpose: when authoring or modifying a spell, you MUST surface what each step is allowed to do **before** the spell becomes runnable. This file is the canonical reference for that behaviour and is shared by the `spell-builder` and `connector-builder` skills.

## Permission Levels

Levels control which Claude CLI tools a step's sub-agent receives. Auto-derived from declared `capabilities` unless the step sets `permissionLevel:` explicitly. `autonomous` is never auto-derived — it requires explicit opt-in.

| Level | Tools | Auto-derived when |
|-------|-------|-------------------|
| `readonly` | Read, Glob, Grep | Only `fs:read`, `memory` capabilities |
| `standard` | Edit, Write, Read, Glob, Grep | Has `fs:write` or `agent`, no `shell`/`browser` |
| `elevated` | Edit, Write, Bash, Read, Glob, Grep | Has `shell` or `browser` |
| `autonomous` | All tools | Never auto — explicit opt-in only |

## Risk Classification

| Class | Triggered by | Meaning |
|-------|--------------|---------|
| `[SAFE]` | `fs:read`, `memory` only | No side effects |
| `[SENSITIVE]` | `agent`, `net`, `browser` | Reads external data or spawns processes |
| `[DESTRUCTIVE]` | `shell`, `fs:write`, `browser:evaluate`, `credentials` | Can permanently modify or delete data |

## Capability Warnings

For each destructive or sensitive capability declared on a step, include the matching warning in disclosure output:

| Capability | Warning text |
|------------|--------------|
| `shell` | "Can execute arbitrary shell commands (rm, git push, etc.)" |
| `fs:write` | "Can create, overwrite, or delete files on disk" |
| `credentials` | "Can access stored secrets and API keys" |
| `agent` | "Can spawn autonomous Claude sub-agents" |
| `net` | "Can make network requests to external services" |
| `browser` | "Can drive a browser session, including form submission and downloads" |

## Per-Step Disclosure (REQUIRED on step creation)

After defining or modifying a step, display its permission profile. For destructive/sensitive steps:

```
Permissions for step "deploy-code":
  [DESTRUCTIVE] deploy-code (bash)
    Permission level: elevated
    Allowed tools: Edit, Write, Bash, Read, Glob, Grep
    Warnings:
      !! shell: Can execute arbitrary shell commands (rm, git push, etc.)
      !! fs:write: Can create, overwrite, or delete files on disk
```

For safe steps, still display — with a reassuring tone:

```
Permissions for step "analyze-logs":
  [SAFE] analyze-logs (bash)
    Permission level: readonly
    Allowed tools: Read, Glob, Grep
    No destructive capabilities.
```

When editing an existing step, if the change introduces new destructive capabilities or raises the permission level, call this out explicitly.

## Spell-Wide Dry-Run Report (REQUIRED before first run)

After schema validation passes for a new or updated spell, display the full permission report and require user acceptance before the spell can be cast:

```
Permission Report: <spell-name>
Overall risk: [DESTRUCTIVE] destructive
Permission hash: a1b2c3d4e5f6g7h8

  [SAFE] fetch-config (bash)
    Permission level: readonly
    Allowed tools: Read, Glob, Grep

  [DESTRUCTIVE] implement-story (bash)
    Permission level: elevated
    Allowed tools: Edit, Write, Bash, Read, Glob, Grep
    Warnings:
      !! shell: Can execute arbitrary shell commands (rm, git push, etc.)
      !! fs:write: Can create, overwrite, or delete files on disk

  [SENSITIVE] analyze-results (agent)
    Permission level: standard
    Allowed tools: Edit, Write, Read, Glob, Grep
    Warnings:
      ! agent: Can spawn autonomous Claude sub-agents

--- DESTRUCTIVE STEPS ---
1 step(s) can make destructive changes:
  - implement-story: shell, fs:write

These steps can modify files, run shell commands, or access credentials.
Review the spell definition before accepting.
```

Then ask:

> The spell requires the permissions shown above. Do you accept? (y/n)

On acceptance the permission hash is stored. Subsequent runs do NOT re-prompt unless the spell's permissions change. Regular runs (not dry-runs) skip this verbose output and silently check the stored hash.

## See Also

- [SKILL.md](SKILL.md) — main spell-builder skill
- [preflight.md](preflight.md) — preflight check authoring
- [architecture.md](architecture.md) — three-layer model (spell → step → connector)
