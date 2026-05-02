# moflo 4.9.1 upgrade — what Claude Code saw

Project: `moflo-test-project` (branch: epic/1-epic-add-health-check-version-endpoint-a → main)
Date: 2026-05-02
Upgrade: `moflo` 4.8.70 → 4.9.1 via `npm install moflo@latest --save`

## Happy path

The npm portion was uneventful:

- `package.json` bumped `moflo` from `^4.8.70` to `^4.9.1`
- `package-lock.json` shrank substantially: 14,919 → ~3,000 lines (`+2,921 / -12,000`); 552 packages removed, 6 added, 0 vulnerabilities
- Committed as `Update moflo to 4.9.1`, pushed, merged via existing PR #11, pulled main. Clean.

At that point `git status` looked benign: just the version pin and lock file.

## Where it got interesting

After merging back to main and running `git status`, the working tree was suddenly noisy:

- ~32 modified files under `.claude/` (guidance docs, hook helpers, indexer scripts, `session-start-launcher.mjs` +640 lines)
- 5 new files under `.claude/scripts/lib/`: `daemon-config.mjs`, `db-repair.mjs`, `incremental-write.mjs`, `migrations.mjs`, `moflo-paths.mjs`
- `.claude-flow/installed-files.json` and `.claude-flow/moflo-version` modified

My initial read: 4.8 → 4.9 minor bump = bundled scaffolding refresh, just commit it. The recent `Update moflo to 4.8.x` commits had only touched package files, but those were patch releases, so a bigger surface for a minor bump fit.

That was wrong. It was a **directory migration in disguise**.

## The pivot

When I tried `git add .claude .claude-flow` on a fresh branch, `git status` came back with stuff that should never be staged:

- `.claude-flow/.gitignore` showing as **deleted**
- `.claude-flow/CAPABILITIES.md`, `config.json`, `config.yaml`, `installed-files.json`, `moflo-version`, `security/audit-status.json` — all deleted
- Daemon runtime files appearing as new additions: `daemon.lock`, `daemon.log`, `daemon-state.json`, `background-pids.json`, `daemon-spawn.stamp`, `vector-stats.json`
- 30+ `logs/headless/audit_*_prompt.log` and `_result.log` files staged

The deletion of `.claude-flow/.gitignore` was the smoking gun — that file (per `git show HEAD:.claude-flow/.gitignore`) had been tracking exactly the runtime files that were now demanding to be committed:

```
data/
logs/
sessions/
neural/
*.log
*.tmp
daemon.lock
daemon-state.json
daemon-spawn.stamp
background-pids.json
agents/store.json
vector-stats.json
embeddings.json
metrics/
```

So the pattern was: `.gitignore` got removed → previously-ignored files became eligible → `git add` swept them up.

## What actually happened

Read of `.claude/scripts/lib/moflo-paths.mjs` (one of the 5 new files) was the unlock:

```js
// Pure-JS counterpart to src/cli/services/moflo-paths.ts (#699, #727).
export const MOFLO_DIR = '.moflo';
export const LEGACY_CLAUDE_FLOW_DIR = '.claude-flow';
export const LEGACY_SWARM_DIR = '.swarm';
```

4.9.1 ships a **path migration**: `.claude-flow/` (legacy) → `.moflo/` (new).

Confirmed by enumerating `.moflo/` — 27 files, fully populated:

- Config files moved from `.claude-flow/`: `config.json`, `config.yaml`, `CAPABILITIES.md`, `installed-files.json`, `moflo-version`, `.gitignore`
- Plus DB/index: `moflo.db`, `hnsw.index`, `embeddings.json`, `patterns-hash.txt`, `tests-hash.txt`, `code-map-hash.txt`, `vector-stats.json`, `migrations.json`
- Plus runtime state: `daemon.lock`, `daemon.log`, `daemon-state.json`, `background-pids.json`, `daemon-spawn.stamp`
- Plus subdirs: `metrics/`, `agents/`, `security/`, `accepted-permissions/`

Meanwhile the daemon was still writing to `.claude-flow/` (its lock and log timestamps were ~2 minutes after the migration), which is why those files reappeared as "new untracked" even though the migration had moved them.

## The friction points (UX feedback for moflo 4.9.1)

1. **Migration is silent.** Nothing in the upgrade output (`npm install` summary or first command after) signaled "I just relocated 27 files and your gitignore." From the user's seat it just looks like git went haywire.

2. **The daemon kept writing to the legacy location.** It must have been started before the upgrade and held its old paths in memory. Net effect: the user sees ghost files reappearing in `.claude-flow/` after every operation, which makes it look like the migration is incomplete or broken.

3. **No `.claude-flow/` cleanup.** Migration moved files out but left the directory present, with stale metadata and an actively-written daemon state. Easy for a tool (or a careless `git add .claude-flow`) to commit dead-on-arrival deletions and resurrected runtime files in the same change.

4. **`.gitignore` deletion has a blast radius.** Removing `.claude-flow/.gitignore` *as part of* the migration unmasks every previously-ignored runtime file simultaneously. If the equivalent rules aren't already in place at the new `.moflo/.gitignore` or the repo root before the old one is removed, naive `git add` becomes dangerous. (The new `.moflo/.gitignore` exists and presumably handles this, but only for `.moflo/`. The legacy directory is now unprotected.)

5. **Mixed scaffolding signal.** The `.claude/` source updates (~32 files, +1,514/-1,062) are a real, intentional bundled-source refresh — those *should* be committed. But they're indistinguishable in `git status` from the migration debris until you read `moflo-paths.mjs` and figure out what's going on.

A migration banner — even just `moflo: migrated .claude-flow/ → .moflo/ (27 files); please review git status` on first invocation post-upgrade — would have collapsed all of this into a 30-second task instead of a "Claude is investigating unexpected git state" detour.

## State at end of session

- Sitting on local branch `chore/moflo-4.9.1-scaffolding` with nothing staged or committed
- `main` is at `83d8d98 epic(#1): consolidated epic PR (#11)` (includes the version bump)
- Working tree contains the migration debris and the legitimate `.claude/` source updates, intermingled
- moflo daemon is running and re-writing to `.claude-flow/` periodically

## Suggested cleanup plan (for whenever)

1. Stop moflo daemon (`flo doctor --fix` or equivalent) so it stops re-populating `.claude-flow/`
2. Confirm `.moflo/.gitignore` covers the same runtime files the legacy one did
3. Remove `.claude-flow/` entirely from the working tree and the repo
4. Stage the legitimate `.claude/` source updates plus the new tracked-config files in `.moflo/` (`config.json`, `config.yaml`, `CAPABILITIES.md`, `installed-files.json`, `moflo-version`)
5. Commit, PR, merge

Step 3 is what makes the diff legible: until `.claude-flow/` is gone, every future `git status` will look like a small disaster.
