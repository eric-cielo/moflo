# Consumer smoke-test harness

Epic #464 Gate 3 — prove that a fresh consumer install of moflo exercises the Claude-Code-facing surface end-to-end. Re-run the same harness against a post-removal build to catch agentdb-removal regressions.

## Run

```bash
# from repo root
node harness/consumer-smoke/run.mjs

# skip the pack step (reuse last tarball)
node harness/consumer-smoke/run.mjs --skip-pack

# keep the consumer .work/consumer dir for inspection
node harness/consumer-smoke/run.mjs --keep
```

## What it does

1. `npm pack` the repo root into `harness/consumer-smoke/.work/`.
2. Create `.work/consumer/` with a minimal `package.json` installing moflo from the tarball.
3. `npm install` into the consumer dir.
4. Run a sequence of `flo …` subcommands and assert exit codes + round-trip behavior:
   - `flo --version`
   - `flo doctor --json`
   - `flo memory store / get / search`
   - `flo spell list`
5. Assert consumer invariants:
   - No stray `*.rvf` files in consumer root
   - No `agentdb.rvf` written unexpectedly
   - Report `.swarm/` contents
   - Report presence/absence of `node_modules/agentdb` and `node_modules/agentic-flow`

## Exit codes

- `0` — every smoke check passed
- `1` — at least one smoke check failed
- `2` — harness itself aborted before running checks (pack/install failure)

## Baseline expectations (moflo@4.8.80-rc.7, pre-removal)

Expected state today:
- `node_modules/agentdb`: **present** (it's in optionalDependencies)
- `node_modules/agentic-flow`: **present** (same)
- `.swarm/memory.db` created on first memory op
- No `*.rvf` in consumer root (fixed in Phase A by pinning to alpha.10 and `*.rvf` gitignore)

## Re-using against post-removal build

When Option B/C is picked and implemented:
1. Rerun `node harness/consumer-smoke/run.mjs`
2. Expected deltas:
   - `node_modules/agentdb`: **absent**
   - `node_modules/agentic-flow`: **absent**
   - All other smoke checks still pass (or a delta is documented)

## Limitations

- MCP tools can only be tested via a running Claude Code client; this harness checks that the MCP-server bin starts, not that tool calls succeed end-to-end.
- Spell execution is not exercised — the spell engine requires an LLM call which is out of scope. `spell list` is the proxy for "spell engine loads."
- Embedding generation via `@xenova/transformers` requires a model download on first run (~80 MB). The harness does **not** exercise this; cover it in Gate 3 followup if needed.
