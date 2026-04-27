# Consumer smoke-test harness

Proves that a fresh consumer install of moflo exercises the Claude-Code-facing
surface end-to-end. Built for **epic #464 Gate 3** and now the passing gate
for **epic #501 Story 2 / Story 3** (verify the shipped agentdb-removal build
against this harness before closing #464).

## Run

```bash
npm run test:smoke              # from repo root — full run
npm run test:smoke -- --keep    # keep .work for inspection
npm run test:smoke -- --verbose # stream subprocess stdout/stderr
npm run test:smoke -- --json    # JSON summary for CI ingestion
```

Takes ~30–60 seconds; most of it is `npm install` in the scratch consumer.

## What it checks

| Phase | Step | Verifies |
|-------|------|----------|
| Pack | `pack` | `npm pack` produces a tarball |
| Install | `install` | Tarball installs cleanly into a scratch consumer |
| Forbidden deps | `forbidden-deps` | `node_modules` + full dep tree free of `agentdb`, `agentic-flow`, `@ruvector/*`, `ruvector`, `@xenova/transformers`, `fastembed` |
| Required deps | `required-deps` | `onnxruntime-node` and `@anush008/tokenizers` are present (embedding stack intact) |
| CLI | `cli-version` | `flo --version` reports a semver |
| CLI | `doctor` | `flo doctor --json` runs (exit 0 or 1) |
| Memory | `memory-init` | `flo memory init` initializes the sql.js+HNSW store |
| Memory | `memory-store/retrieve/search/list/delete` | CRUD round-trips |
| Spell | `spell-list` | `flo spell list` runs (exit 0 or 1) |
| MCP | `mcp-tools:moflodb` | `flo mcp tools` lists `moflodb_*` tools |
| MCP | `mcp-tools:no-legacy` | No `agentdb_*` tools left from the old naming |
| CLI | `flo-search` | `flo-search` binary loads |
| Hooks | `hooks-list / pre-task / post-edit` | Hook commands succeed end-to-end |
| Skill | `flo-skill` | `.claude/skills/fl/SKILL.md` ships inside the package |
| Invariants | `no-stray-rvf`, `no-agentdb-rvf` | No surprise `.rvf` files at consumer root |
| Surface | `moflo-install-size` | Enforces installed size budget (warn > 95 MB, fail > 110 MB) |

## Exit codes

- `0` — every check passed (warnings for known regressions allowed)
- `1` — at least one hard-fail check failed
- `2` — harness aborted before checks could run (pack/install failure)

## Known regressions (WARN, do not block)

`KNOWN_FORBIDDEN_REGRESSIONS` in `lib/checks.mjs` lists forbidden deps that
still leak through pending a dedicated fix. Currently empty — every entry on
the `FORBIDDEN_DEPS` list is a hard fail.

## Cross-platform

Runs on Linux, macOS, and Windows. Uses Node built-ins only (no POSIX-specific
shell commands), invokes moflo via `node <path>/bin/cli.js` to avoid the
Windows `.cmd` wrapper / PATHEXT resolution issue, and uses `path.join`
throughout.

One Windows-specific tolerance: `flo memory list` currently crashes at process
teardown with a libuv async-handle assertion (`src/win/async.c:76`) after
printing correct output. The harness marks this as WARN when the table is
present in stdout and the crash is only at exit. The underlying moflo bug
should be fixed separately.

## CI

Runs in `.github/workflows/ci.yml` as the `smoke` job across an
`ubuntu-latest` / `macos-latest` / `windows-latest` matrix. Failures block PR
merge.

## Options

- `--keep` — Keep the scratch consumer directory after the run.
- `--skip-pack` — Reuse the last tarball in `.work/` (faster iteration).
- `--verbose` / `-v` — Stream subprocess stdout/stderr instead of capturing.
- `--tarball <path>` — Use an existing tarball. Useful for Story 3:
  ```bash
  # validate the published build
  npm pack moflo@latest --pack-destination /tmp
  node harness/consumer-smoke/run.mjs --tarball /tmp/moflo-*.tgz
  ```
- `--json` — Print machine-readable JSON summary (pass/fail/warn counts plus
  the full results array).

## Environment variables

- `MOFLO_INSTALL_SIZE_WARN_MB` — Override the install-size warn threshold
  (default: 95 MB). Non-positive or non-numeric values fall back to the default.
- `MOFLO_INSTALL_SIZE_MAX_MB` — Override the install-size fail threshold
  (default: 110 MB). Use deliberately (e.g. a model bump) and land the new
  ceiling in the same PR as a README note so the budget stays a real contract.

## When to run

- Before every `/publish` — part of the publish preflight gate.
- On any PR that touches `package.json`, `bin/`,
  `src/cli/mcp-tools/`, or `.claude/skills/fl/`.
- As the last gate in Story 3 of epic #501 — run against the shipped build
  via `--tarball` and close #464 when it passes clean (zero WARN is the bar).

## Structure

```
harness/consumer-smoke/
  run.mjs            # entry: arg parsing + pipeline orchestration
  lib/
    proc.mjs         # spawn helpers (cross-platform npm + node invocation)
    report.mjs       # structured status/summary output
    checks.mjs       # all individual checks + KNOWN_FORBIDDEN_REGRESSIONS list
  .work/             # scratch tarballs + consumer dirs (gitignored)
  README.md          # this file
```
