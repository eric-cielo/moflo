# Pre-Publish Rules — Cross-Platform + Consumer-Install Verification

**Purpose:** Mandatory gates that MUST pass before any moflo `npm publish`. Every change must (a) work on Windows + macOS + Linux, and (b) work when installed as a devDependency in a consumer project (i.e., running from `node_modules/moflo/...`). Reference this doc from the `/publish` skill — it is the single source of truth for the pre-publish posture.

---

## Why this exists

Moflo ships to N consumers via `npm install moflo`. Every change runs from their `node_modules/moflo/...` on their OS. A regression that's invisible inside the moflo repo but breaks for consumers (e.g., `process.cwd()`-anchored paths, POSIX-only commands, missing manifest entries, dropped guidance content) costs us credibility and engineering hours to repair (#860, #854, #586/#798). The gates below are the layered defense.

---

## Layered Gates Overview

| Gate | What it catches | Where it runs |
|------|-----------------|---------------|
| **Lint (`npm run lint`)** | Hardcoded `'..'` chains in `path.resolve/join`, silent `catch {}` blocks, unsafe selectors | Local + CI |
| **Type check (`npm run build`)** | Type errors, missing exports, broken imports | Local + CI |
| **Test suite (`npm test`)** | Unit + integration + alignment guards (hook wiring, manifest, drift detectors) | Local + CI |
| **Doctor (`flo doctor --strict`)** | Runtime config validity, daemon lock, embeddings hygiene, sandbox tier | Local |
| **Smoke harness (`npm run test:smoke`)** | Pack → install → consumer-perspective surface | Local + CI |
| **Populated smoke (`npm run test:smoke:populated`)** | Upgrade-path data preservation against pre-existing consumer state | Local |

**Every gate must be green before publish.** No skipping for "the lint warning is unrelated" or "the smoke flakes on this machine" — that's how #860 and #854 shipped.

---

## Trigger-Based Gating (`/publish` default mode)

The `/publish` skill takes a presence-only `--check` / `-ch` flag. **Default behavior is `--check=false`** because most publishes happen right after a green PR where CI has already run lint, build, tests, and smoke (clean + populated, on three OSes). Re-running them locally pays for a CI workflow that already passed.

| Gate | Default mode (no flag) | `--check` mode | Rationale for default |
|------|------------------------|----------------|----------------------|
| Lint | skip | run | `ci.yml` runs `npm run lint` on every PR with `max-warnings 0` |
| Build | **always run** | run | Confirms the deliverables on disk match the new version; `prepublishOnly` would catch it but earlier is better |
| Tests | skip | run | `ci.yml` runs `npm test` on every PR |
| Doctor | **always run** (`--fix`) | run (`--strict`) | Only check with no CI equivalent — local-only state (daemon, embeddings, vector-stats) |
| Smoke (clean) | skip | run | `consumer-install-smoke.yml` runs on PR + push to main, three OSes |
| Smoke (populated) | skip | run | Same workflow as above |
| Manual gate walk (rows below) | **trigger-based** | run all | A cheap bash fingerprint computes which gates the diff actually touches |

The trigger fingerprint is `.claude/skills/publish/fingerprint.sh`. It diffs `HEAD` against the most recent `chore: install moflo@*` commit and pattern-matches the file list against the manual-gate triggers. Output is one block (~50 tokens), then Claude only walks the gates whose triggers fired.

| Trigger flag | Manual check | Diff signal |
|--------------|--------------|-------------|
| `split-newlines` | Gate 1 — `.split(/\r?\n/)` | TS/JS file containing `readFile`/`fs.read*` was changed |
| `homedir-tmpdir` | Gate 1 — `os.homedir()`/`os.tmpdir()` | Code touches `process.env.HOME`/`TMPDIR`/`TMP`/`TEMP` or `'/tmp/'` literal |
| `bwrap-permissions` | Gate 1 — `permissionLevel: elevated` for net | Spell YAML or spell bash step changed |
| `posix-only-spell-bash` | Gate 1 — no `mkdir`/`rm`/`cp` in spell bash | Spell bash step changed |
| `bin-scriptfiles-sync` | Gate 2 — `scriptFiles` array (3 sites) | New file added to `bin/` |
| `helper-static-files` | Gate 2 — helpers ship as static files | `bin/` or `init/` script-gen logic changed |
| `shipped-guidance-prefix` | Gate 2 — `moflo-` prefix + shipped/internal partition | New file added to `.claude/guidance/shipped/` |
| `files-glob-coverage` | Gate 6 — `npm pack --dry-run` review | New file class under `.claude/{skills,guidance/shipped,scripts,hooks}/` |
| `info-loss-audit` | Gate 6 — bullet-by-bullet destination check | Any file deleted or renamed |

If the trigger set is empty AND `--check=false`: the manual walk is skipped entirely, with explicit "Triggered manual checks: none" in the publish summary.

**When to use `--check=true`:** publishes that didn't go through a green PR, broad refactors, infrastructure surface changes, or belt-and-suspenders for risky releases. The flag forces the full ten-item TL;DR walk regardless of triggers.

**Why "errs toward triggering":** the fingerprint script prefers false positives (one extra cheap manual check) over false negatives (a real bug class slipping). The trigger map is the source of truth — whenever a manual-check row is added to a gate below, the matching trigger MUST be added to `fingerprint.sh` in the same commit.

---

## Gate 1 — Cross-Platform Compatibility

**Every code change MUST work on Windows + macOS + Linux.** The full rule set lives in `shipped/moflo-cross-platform.md`. Pre-publish, verify:

| Check | Why it's required | Pre-publish action |
|-------|------------------|--------------------|
| No hardcoded `\` separators or drive letters | Breaks on Linux | `npm run lint` (ESLint catches this) |
| `path.join` / `path.resolve` not chained `'..', '..', '..'` | Source-vs-installed depths differ; `bin/` scripts run from `bin/` in dev and `.claude/scripts/` in consumers | ESLint rule from #782 |
| `pathToFileURL()` for dynamic imports — never string-concatenated `file://` | Fails on Windows | Type check + lint |
| `.split(/\r?\n/)` for file content reads | Windows-created files have `\r\n` | Manual review on diffs |
| `os.homedir()` / `os.tmpdir()` — never raw `process.env.HOME` / `/tmp` | Platform-specific env vars | Manual review |
| Bash steps under bwrap declare `permissionLevel: elevated` when net is needed | bwrap unshares network by default | `feedback_bwrap_unshare_net` memory |
| Spell bash steps avoid POSIX-only commands (`mkdir`, `rm`, `cp`) on Windows | Windows lacks them on PATH | Use `node -e` with `fs`/`os` (`feedback_spell_bash_minimal_path`) |

**Verification on every change**: run `npm run lint` AND mentally walk the diff against the cross-platform table. The lint covers the mechanical traps; the manual walk covers everything else.

---

## Gate 2 — Consumer-Install Posture

**Every feature must work from `node_modules/moflo/...` paths in a consumer project**, not from source paths anchored on the moflo repo's `process.cwd()`.

| Check | Why it's required | Pre-publish action |
|-------|------------------|--------------------|
| `bin/` scripts use `findProjectRoot()` for project root, not `__dirname`-relative `..` | `__dirname` resolves differently in `bin/` vs synced `.claude/scripts/` | `internal/consumer-project-paths.md` rule + lint |
| Runtime imports of moflo internals use `import.meta.url` via `mofloPath()`/`mofloUrl()`, not `process.cwd()` | Consumer's `cwd` is their project root, not moflo's | `feedback_consumer_path_resolution` + lint smoke stderr scan |
| Helper scripts ship as static files in `bin/`, not generated at runtime | Static-files rule from `internal/session-start.md` § Adding a new helper script | Manual review |
| New `bin/` script is added to the `scriptFiles` array in `session-start-launcher.mjs` AND in `init/moflo-init.ts`'s sync helper AND any third sync site | Missing entries cause silent sync drift (#777) | `feedback_scriptfiles_sync` |
| New shipped guidance file is in `.claude/guidance/shipped/` with `moflo-` prefix | Filename collisions in consumer projects + auto-discovery requires the prefix | `internal/guidance-rules.md` rules #1–#2 |
| `package.json` `files` glob covers any new shipped file class | Otherwise the file ships nowhere; npm install grabs zero copies | Inspect `npm pack --dry-run` output |

**Verification**: run the smoke harness (Gate 5) — it packs, installs, and exercises the consumer surface end-to-end. If you've changed any path-resolution code, run `npm run test:smoke` BEFORE you commit.

---

## Gate 3 — Tests + Lint + Build

The build and test commands run as the first three steps of `/publish`. Pre-publish:

```bash
npm run lint       # ESLint, max-warnings 0
npm run build      # tsc, must exit 0
npm test           # 0 failed test files (broken-window theory)
```

**Broken-window theory** applies: every red signal is a publish-blocker. No "probably flaky" without individual re-verification. If a test fails in the full suite, retest individually — if it still fails, fix it; if it doesn't fail individually, the suite has cumulative pressure (per `internal/testing-performance.md`) and that pressure must be removed BEFORE publish.

---

## Gate 4 — Doctor

```bash
npx moflo doctor --strict
```

Must exit 0. The `--strict` flag (from epic #781 #784) treats warnings as failures unless explicitly allow-listed via `--allow-warn <names>`. If a warning is environmentally legitimate (e.g., "Sandbox Tier" without Docker on a Windows dev box), allow-list it — never silence it globally.

The doctor checks Node version (≥20), Git, config validity, daemon status, memory database, API keys, MCP servers, disk space, TypeScript compile state, and `vector-stats.json` freshness.

---

## Gate 5 — Smoke Harness

```bash
npm run test:smoke              # ~30–60s — clean install profile
npm run test:smoke:populated    # ~60s — upgrade-path profile
```

These run the harness in `harness/consumer-smoke/`. They:

1. `npm pack` produces a tarball
2. Install the tarball into a scratch consumer project
3. Verify `node_modules/...` is free of forbidden deps (`agentdb`, `agentic-flow`, `@ruvector`, `ruvector`, `@xenova/transformers`, `fastembed`)
4. Verify required deps are present (`onnxruntime-node`, `@anush008/tokenizers`)
5. Run `flo --version` and `flo doctor --json` from the consumer
6. Exercise the MCP/CLI surface end-to-end
7. **Populated profile**: also verifies upgrade-path data preservation (rows survive, `.claude-flow/` → `.moflo/` migration, embeddings re-vectorise, soft-delete tombstones purged, ephemeral-namespace rows purged, legacy DB retained as `.bak`)

If either profile fails, do not publish. The whole point is to catch consumer-only regressions BEFORE they hit npm.

---

## Gate 6 — Manifest Sanity (No Information Loss)

When you split, rename, or remove a shipped file, the consumer cleanup must work:

| Layer | Check | How |
|-------|-------|-----|
| Filesystem (consumer) | New shipped files are in `package.json` `files` glob | `npm pack --dry-run \| grep <new-file>` |
| Filesystem (consumer) | Removed shipped files are pruned via launcher manifest diff (Section 3) and Section 3b marker prune | `internal/guidance-sync.md` Layer 1 |
| DB (consumer) | Indexer's `cleanStaleEntries` prunes orphan `doc-*` keys | Live verify per `internal/guidance-sync.md` § Verification Recipe |
| HNSW (consumer) | Phantom-skip filter at search time hides deleted IDs until next embedding round triggers rebuild | Documented gap (`internal/guidance-sync.md`) |

**No information loss rule**: if you delete or move content, audit the original sections against destinations to confirm every piece has a home. Bullet-by-bullet, not section-by-section. (This is what we did for the core-guidance split — found the cross-platform bullets had no destination, merged them into `moflo-cross-platform.md`.)

---

## Gate 7 — Source-Code Hygiene

`npm run lint` enforces the bulk of this; remaining manual checks:

- No `console.log` debugging in shipped code (`shared/utils/error-detail.ts` is the standard error formatter)
- No silent `catch {}` blocks — always log, re-throw, or return error details (`feedback_no_silent_failures`, ESLint rule from #785)
- No layered workarounds for symptoms that have a known root cause (`feedback_no_layered_workarounds`)
- Files under 500 lines (`internal/coding-style.md`)
- Internal paths use `mofloPath()`/`mofloUrl()` anchors (`feedback_path_safety_gates`)

---

## TL;DR — The Pre-Flight Checklist

Before invoking `/publish`, the gates run in two layers depending on the `--check` flag.

### Default mode (`/publish`, no flag) — runs always

1. [ ] `npm run build` — exits 0 (Step 2 of the skill, never skippable)
2. [ ] `npx moflo doctor --fix` — exits 0 (only check with no CI equivalent)
3. [ ] Trigger fingerprint computed; manual walk performed only on triggered gates

The default mode trusts CI for items 4–7 below. Use it when publishing right after a merged green PR — the common case.

### Full mode (`/publish --check` or `-ch`) — runs everything

In addition to the three above:

4. [ ] `npm run lint` — exits 0, max-warnings 0
5. [ ] `npm test` — 0 failed test files; flakes investigated individually
6. [ ] `npm run test:smoke` — green
7. [ ] `npm run test:smoke:populated` — green
8. [ ] Cross-platform diff walk — no `\\`, no chained `'..'`, no string `file://`, no `.split('\n')` on file content
9. [ ] Consumer-install posture — `bin/` scripts use `findProjectRoot()`, runtime imports anchor on `import.meta.url`
10. [ ] Manifest sanity — `npm pack --dry-run` includes new shipped files; removed files trace through guidance-sync layers cleanly
11. [ ] Information-loss audit on any split/move — bullet-by-bullet destination check

Use `--check` when the publish didn't go through a green PR, when the change is risky (broad refactor, packaging, infrastructure), or for belt-and-suspenders.

---

## See Also

- `.claude/guidance/shipped/moflo-cross-platform.md` — Full rule set for cross-platform code (Gate 1)
- `.claude/guidance/internal/consumer-project-paths.md` — `findProjectRoot()` rule for `bin/` scripts (Gate 2)
- `.claude/guidance/internal/upgrade-contract.md` — "User never re-runs init" invariant the smoke harness exercises (Gate 5)
- `.claude/guidance/internal/guidance-sync.md` — Three-layer guidance pipeline + cleanup paths (Gate 6)
- `.claude/guidance/internal/testing-performance.md` — Broken-window posture + no-flaky-tests standing decision (Gate 3)
- `.claude/guidance/internal/dogfooding.md` — Why moflo's dogfood loop catches consumer regressions first
- `.claude/guidance/shipped/moflo-source-hygiene.md` — Source-code hygiene rules consumed at lint time (Gate 7)
- `.claude/skills/publish/SKILL.md` — The `/publish` skill that references this doc
- `.claude/skills/publish/fingerprint.sh` — Trigger-fingerprint script that drives default-mode gating
- `harness/consumer-smoke/README.md` — Smoke harness profiles + checks (Gate 5)
- `docs/BUILD.md` — Step-by-step build/publish process the `/publish` skill follows
- `.github/workflows/ci.yml` — Lint/build/test gates default mode skips
- `.github/workflows/consumer-install-smoke.yml` — Smoke gates default mode skips
