# Verbose Command Filtering — Filter at Source, Never Tee-Then-Read

**Purpose:** Pipe long verbose commands (smoke runs, full test suites, builds with `--verbose`) through a filter at execution time so only relevant lines reach the model context. Never tee output to disk and `tail`/`grep` it later — every follow-up read re-loads the full file into context (~5K tokens per round-trip).

---

## The Rule

| Pattern | Verdict |
|---------|---------|
| `cmd 2>&1 \| grep -E "FAIL\|Summary"` (run_in_background) | ✅ Filter at source |
| `cmd 2>&1 \| tee .tmp.log` then later `tail`/`grep` `.tmp.log` | ❌ Tee-then-read |

Tee-then-read is the silent context killer. The Bash tool surfaces stdout into context, so each follow-up `grep`/`tail` of a tee'd file re-reads the file fresh on every call. Three follow-ups burn 15K+ tokens before any decision lands. Filtering at source emits the matching lines once.

## When to Apply

Smoke harness runs, full `vitest`/`jest` suites, builds with `--verbose`, anything passing `--trace`, any `node ... --verbose` invocation. If you genuinely need the full log for post-mortem, write it to disk but inspect it OUTSIDE the model loop (have the user open it, attach it to an issue) — do NOT pipe a tee'd file back through Bash.

## Concrete Examples

```bash
# ✅ Smoke harness
node harness/consumer-smoke/run.mjs 2>&1 | grep -E "FAIL|Summary|Zombie"
# ❌ node harness/consumer-smoke/run.mjs 2>&1 | tee .tmp.log; tail .tmp.log

# ✅ Vitest full suite
npm test -- --reporter=verbose 2>&1 | grep -E "FAIL|✗|Error:"
# ❌ npm test 2>&1 | tee .test.log; grep FAIL .test.log

# ✅ Build with verbose
npm run build -- --verbose 2>&1 | grep -E "error TS|Failed|Cannot find"
# ❌ npm run build 2>&1 | tee .build.log; grep "error TS" .build.log
```

## Why It Matters

Case study: issue #903 burned ~25K tokens across 5 tee-then-grep round-trips where a single grep-at-source would have surfaced the same signal once. Filtering at source is not an optimization — it is the default shape for any verbose command whose full output you do not need in your context.

---

## See Also

- `.claude/guidance/moflo-core-guidance.md` — Hub for moflo's CLI/MCP surface and runtime conventions
- `.claude/guidance/moflo-memory-strategy.md` — Companion rules on RAG indexing and context discipline
