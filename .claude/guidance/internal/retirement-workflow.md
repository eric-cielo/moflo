# Retirement Workflow — Removing Shipped Agents and Skills

**Purpose:** Document the steps for retiring a `.claude/agents/**/*.md` or `.claude/skills/**/*.md` file from moflo so that consumers who already have it on disk get it auto-pruned on their next upgrade. Without this workflow, retired files linger in consumer `node_modules/` for months because Claude Code keeps loading them as available subagents.

This is a moflo-only doc — the workflow only makes sense inside the moflo source repo.

---

## When to Use This Workflow

Whenever a PR DELETES one of:

- `.claude/agents/**/*.md`
- `.claude/skills/**/*.md`

Examples that triggered this workflow:

- #932 retired 49 ruflo-aspirational agents
- #945 retired `skill-builder` and others
- #938 retired ruflo skill cruft

Renaming a file counts as deletion-plus-creation — record the old path as retired even though new content ships under a different path.

---

## Two Mechanisms, One Workflow

The launcher closes the gap two ways. You don't pick — both run on every consumer upgrade.

| Mechanism | Closes | Coverage |
|-----------|--------|----------|
| Manifest sync (#948) | Future retirements (post-#948 PRs) | Automatic — `bin/session-start-launcher.mjs` walks `node_modules/moflo/.claude/agents/**/*.md` + `.claude/skills/**/*.md`, records each in `installed-files.json`, and the cleanup loop drops files that disappear from the new manifest on next upgrade |
| `retired-files.json` (#948) | Pre-#948 retirements + customization-safe prune | Static list of `{path, retiredIn, retiredBy, knownContentHashes[]}`. Launcher hash-matches each entry against the consumer file and only prunes when the hash is one moflo actually shipped — customized files survive with a one-line preserve notice |

For PRs landing AFTER #948, **Mechanism A handles cleanup automatically**. You only need the workflow below when you want belt-and-suspenders: the static `retired-files.json` entry catches consumers who jump multiple versions and miss the one-bump-at-a-time manifest diff.

---

## The Steps

### 1. Delete the file in your PR

Standard `git rm <path>` and commit. The deletion lands in moflo source.

### 2. Record it in `retired-files.json`

Run `flo retire <path>` from inside the moflo source repo, once per deleted path:

```sh
flo retire .claude/agents/v3/performance-engineer.md --retired-by '#932'
flo retire .claude/skills/skill-builder/SKILL.md --retired-by '#945'
```

`flo retire`:

- Validates you are inside the moflo source repo (refuses to run elsewhere).
- Walks git history for the path, computing sha256 of the last 3 unique content versions before deletion.
- Appends or updates the entry in `retired-files.json` with `retiredIn` (current package.json version), `retiredBy` (the `--retired-by` flag), and `knownContentHashes[]`.
- Sorts entries by path so the diff is reviewable in PRs.

If you forget `--retired-by`, the entry is still valid — only `path` and `knownContentHashes` are load-bearing; `retiredBy` is metadata for humans reading the file later.

### 3. Commit `retired-files.json`

```sh
git add retired-files.json
git commit -m "chore: record <path> in retired-files.json (#NNN)"
```

The file ships to consumers via `package.json` `files` (line `"retired-files.json"`). On next upgrade after publish, the launcher loads it, hash-matches every entry, and prunes safely.

### 4. Verify (optional but recommended)

The launcher prune logic has unit tests at `tests/bin/launcher-948-retired-prune.test.ts`. If your retirement is a notable batch (e.g. >10 files), spot-check one entry manually:

```sh
node -e "
  import('./bin/lib/retired-files.mjs').then(m => {
    const r = m.loadRetiredManifest('./retired-files.json');
    const entry = r.entries.find(e => e.path === '.claude/agents/v3/performance-engineer.md');
    console.log(entry);
  });
"
```

### 5. Bulk seed (uncommon)

If you somehow miss recording entries for a batch retirement, regenerate from git history:

```sh
node scripts/build-retired-files.mjs --seed
```

This walks every commit that deleted a `.claude/agents/**/*.md` or `.claude/skills/**/*.md` and reconciles `retired-files.json` against git. Existing entries are preserved (and merged with any newly-discovered hashes); missing entries are appended. Run, review the diff, commit.

---

## What NOT To Do

- **Don't delete `retired-files.json` entries** to "clean up" old retirements. Consumers may still be on a moflo version old enough to have those files; pruning them from the manifest reverts the cleanup. Entries can be expired only after we're confident no consumer is on an affected version (~12 months minimum).
- **Don't hand-edit `knownContentHashes[]`** unless you're fixing a verified mistake. The hashes come from git's authoritative content; rewriting them by hand is how silent-prune-of-customized-file regressions happen.
- **Don't run `flo retire` from outside moflo's source repo.** It will refuse. The `retired-files.json` lives at the moflo package root and doesn't ship to consumer `node_modules/` for editing.
- **Don't add a `retired-files.json` entry for a deleted file that is later restored.** Either remove the entry in the same PR that restores the file, or leave both — but never ship a manifest entry for a path that exists in `node_modules/moflo/`. The entry would be a no-op for unmodified consumers (file matches a hash, gets pruned, then restored on next sync) and a destructive flap for customized consumers (prune notice, restore, prune notice every upgrade).

---

## See Also

- `bin/session-start-launcher.mjs` — section 3 manifest sync (Mechanism A) + retired-files prune block (Mechanism B)
- `bin/lib/retired-files.mjs` — `loadRetiredManifest`, `classifyRetiredFile`, `applyRetiredPrune`
- `scripts/build-retired-files.mjs` — `--seed` (bulk) and `--add` (single-path) entry points
- `src/cli/commands/retire.ts` — `flo retire <path>` thin wrapper that calls the seed script with `--add`
- `tests/bin/launcher-948-retired-prune.test.ts` — unit tests for the prune helper
- `tests/bin/install-manifest.test.ts` — Mechanism A coverage (agents/skills walk + cleanup loop)
- `internal/consumer-bound-references.md` — why we ship `retired-files.json` at the package root, not under `dist/`
