# Preflight Checks — Author Guide

Purpose: preflight checks let a step fail fast with a helpful message **before** any side effects occur, when the failure depends on runtime state the user controls (clean git tree, logged-in CLI, reachable host, etc.).

## Required: every preflight has a `hint:` field

The `hint:` is what the end user sees on failure. Without it they get raw shell output (`command "git diff --quiet" exited with 1, expected 0`) which looks like a bug in the spell engine.

Good hints:
- Plain English. No command names, exit codes, internal identifiers.
- State BOTH the problem AND the fix in one or two sentences.
- Assume a non-technical reader.

```yaml
steps:
  - id: create-branch
    type: bash
    preflight:
      - name: "working tree clean (tracked changes)"
        command: "git diff --quiet"
        hint: "You have uncommitted changes to tracked files. Commit them or stash them (git stash) before running this spell."
      - name: "gh cli authenticated"
        command: "gh auth status"
        hint: "The GitHub CLI isn't signed in. Run: gh auth login"
    config:
      command: "git checkout -b feature/new"
```

Bad hints (don't do this):

```yaml
hint: "git diff --quiet failed with exit code 1"   # leaks command name + exit code
hint: "Precondition violated"                       # tells user nothing actionable
```

Preflights without `hint` still work but produce unfriendly default output — flag this as a quality issue before saving the spell.

## Severity: fatal vs warning

Default `severity: fatal` — failure aborts the spell. Use `severity: warning` ONLY when:

- The underlying problem has a safe, one-step fix the user might reasonably want to apply.
- Proceeding is viable either way — the step itself is robust to the condition.

Warning preflights MUST declare `resolutions:` — a list the user can pick from. Each resolution has a `label` and an optional `command` to run before continuing. If `command` is omitted, picking the resolution just proceeds (useful for "I'll handle it myself").

```yaml
preflight:
  - name: "working tree clean (tracked changes)"
    command: "git diff --quiet"
    severity: "warning"
    hint: "You have uncommitted changes. If you want them carried onto the new branch, pick 'Stash and carry over'."
    resolutions:
      - label: "Stash changes and carry them onto the new branch"
        command: "git stash push --include-untracked --message 'pre-spell autostash'"
      - label: "Commit changes to the current branch first, then continue"
        command: "git commit -am 'wip: pre-spell snapshot'"
```

In non-interactive contexts (CI, daemons, scheduled spells) warnings automatically behave like fatals — there is no one to prompt. Don't use `warning` to silently ignore a problem; if ignoring is always safe, the check shouldn't be there.

## Step-Command Preflight Checks (TypeScript)

When authoring a step command (see `connector-builder`), the `preflight:` array on the command takes a `check` function. The `reason` string returned on failure is shown verbatim to end users — same copywriting rules apply.

```typescript
preflight: [
  {
    name: '<service> reachable',
    severity: 'fatal',
    check: async (config, ctx) => {
      const ok = await ping(config.endpoint);
      if (ok) return { passed: true };
      return {
        passed: false,
        reason: `Can't reach ${config.endpoint}. Check your network connection or the service URL in your spell config.`,
      };
    },
  },
  {
    name: 'local cache fresh',
    severity: 'warning',
    resolutions: [
      { label: 'Refresh the cache now', command: '<type>-cli cache refresh' },
      { label: 'Continue with stale cache' },
    ],
    check: async (config) => {
      const stale = await isCacheStale(config.endpoint);
      return stale
        ? { passed: false, reason: 'Your local cache is more than 24 hours old and may produce outdated results.' }
        : { passed: true };
    },
  },
],
```

## See Also

- [SKILL.md](SKILL.md) — main spell-builder skill
- [permissions.md](permissions.md) — permission disclosure & dry-run reporting
- [architecture.md](architecture.md) — three-layer model
