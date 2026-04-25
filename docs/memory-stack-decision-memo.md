# Decision memo: agentdb removal (epic #464)

> **Historical — pre-epic #527 (2026-04-22).** This memo captured the agentdb-removal decision before epic #527 landed. The "three-tier fallback `agentic-flow → @xenova/transformers → mock`" described below is no longer the live architecture: epic #527 removed every hash/mock fallback and swapped `@xenova/transformers` for `fastembed`. Kept as the point-in-time record of the Option-B decision. See [ADR-EMB-001](./adr/ADR-EMB-001-neural-embeddings-mandatory.md) for the current embedding architecture.

Date: 2026-04-20
Status: **shipped — agentdb removed in 4.8.80, `@xenova/transformers` replaced in #527**
Research gates: Gate 1 ✅, Gate 2 ✅, Gate 3 ✅

## TL;DR

Recommend **Option B** (remove + rely on fallbacks). Research shows it's safe, the payoff is large (~310 MB install-size cut for consumers), and the downside is scoped and recoverable.

## What the research found

### Gate 1 — Consumer-surface audit (`docs/memory-stack-audit-consumer-surface.md`)
All 14 actively-used agentdb controllers have working fallbacks wired in `memory-bridge.ts` (sql.js writes to `memory_entries`, in-memory stubs, or clean `null` returns that callers already handle). All 11 "dead" controllers have zero call sites — confirmed safe to delete with the code.

### Gate 2 — Neural + hooks audit (`docs/memory-stack-audit-neural-hooks.md`)
- **Embeddings**: three-tier auto fallback `agentic-flow → @xenova/transformers → mock` is wired and tested. Transformers is a direct `dependencies` entry — it's always present.
- **SONA**: persists to `.swarm/sona-patterns.json`, never touched agentdb. Zero impact from removal.
- **ReasoningBank (neural/)**: brute-force cosine fallback at `reasoning-bank.ts:277` is wired; persistence lost without agentdb (data lives in process-local `Map`).
- **agentic-flow subprocess**: **zero static imports** across the repo. All 8 references are dynamic `import('agentic-flow/…').catch(() => null)` — removal-safe.
- Key caveat: every fallback degrades silently. No user-visible warning when features downgrade.

### Gate 3 — Consumer smoke harness (`harness/consumer-smoke/`)
Baseline harness runs **green: 14/14 checks** against `moflo@4.8.80-rc.7`. Measured:

| Metric | Baseline (today) |
|---|---|
| moflo install footprint | 8.7 MB |
| `node_modules/agentic-flow` | 276 MB |
| `node_modules/@ruvector/*` | 30 MB (17 scoped sub-packages incl. native `.msvc` binaries) |
| `node_modules/agentdb` | 5.1 MB |
| `node_modules/onnxruntime-*` | 3 packages (node + web + common) |
| `.swarm/` after `memory init` | `memory.db` + `schema.sql` |
| Stray `*.rvf` in consumer root | 0 (Phase A fix working) |
| `flo memory init / store / retrieve / search` | all exit 0 |

Harness is re-runnable (`node harness/consumer-smoke/run.mjs`) and will execute the same checks against any post-removal build.

## The three options

### Option A — Punt
Pin `agentdb@3.0.0-alpha.10` forever, accept future alpha churn, do nothing else.

- **Cost**: ~0 dev time now
- **Ongoing**: one fire-drill per upstream alpha bump; consumer-visible behavior can change without our control
- **What stays**: 276 MB of `agentic-flow` + 30 MB of `@ruvector/*` + 5 MB of agentdb in every consumer install
- **Recommendation**: **reject** unless another priority makes the removal cost prohibitive. Phase A already pinned alpha.10 — this is the status quo.

### Option B — Remove, rely on fallbacks (RECOMMENDED)
Drop `agentdb` and `agentic-flow` from both `package.json` files. Delete `agentdb-backend.ts`, delete the agentdb branch in `reasoning-bank.ts`, delete the 11 dead controllers from `controller-registry.ts`. Keep the existing `memory-bridge.ts` fallbacks (they already handle missing controllers via `if (controller) { … } else { fallback }`).

- **Cost**: ~2–3 dev days
- **Consumer payoff**: ~310 MB install shrinkage (agentic-flow 276 MB + @ruvector 30 MB + agentdb 5 MB + transitives). Dozens of packages + native `-msvc` binaries gone.
- **Behavioral change**: HNSW vector search → brute-force cosine (sub-100ms at N=1k; perceptible at N=10k+). Pattern persistence moves to sql.js (still durable, different shape). ReasoningBank's in-process store loses cross-restart persistence — resolve by consolidating on the hooks-layer ReasoningBank which writes via the bridge.
- **Risks** (scoped):
  - Silent degradation — add a one-time init warning telling users what changed
  - Pattern recall quality drops on semantically-similar-but-lexically-different queries (M)
  - `causalGraph` multi-hop walks become O(N²) via sql.js (unknown real-world frequency)
- **Verification**: rerun Gate 3 harness. Expect all 14 checks green; expect `node_modules/agentdb` and `node_modules/agentic-flow` absent.

### Option C — Remove + reimplement 14 used controllers
Option B plus build moflo-owned implementations of the 14 used controllers under `src/modules/memory/src/controllers/`: reflexion, skills, causalGraph, reasoningBank, hierarchicalMemory, memoryConsolidation, learningSystem, nightlyLearner, semanticRouter, contextSynthesizer, batchOperations, mutationGuard, attestationLog, causalRecall.

- **Cost**: ~3–5 dev weeks per the design doc (`docs/memory-stack-migration.md`)
- **Consumer payoff**: same ~310 MB shrinkage as Option B
- **Added value over B**: preserves HNSW-quality retrieval + pattern-promotion loops + causal graph walks — features users on today's moflo actually experience
- **Risk**: silent behavior drift from reimplementations (mitigate with snapshot tests); scope creep into "let's do it properly"
- **Recommendation**: **defer**. Do Option B first; if a specific feature gap surfaces (measurable via Gate 3 harness runs with richer workloads), reimplement only that controller. Pre-paying 3-5 weeks for features users may not even invoke is not a good trade.

## Decision required

Pick one:
- **A** — do nothing, accept ongoing upstream risk (0 days)
- **B** — remove agentdb + agentic-flow, rely on wired fallbacks, add init-time degradation warning (2–3 days) **[recommended]**
- **C** — Option B + reimplement 14 controllers as moflo-owned modules (3–5 weeks)

## What's uncommitted right now

Phase A (pin agentdb@alpha.10, `*.rvf` gitignore, design doc) is committed in `f1aa2f2a8`.

New files from Gate 1-3 research (this session, uncommitted):
- `docs/memory-stack-audit-consumer-surface.md` — Gate 1 output
- `docs/memory-stack-audit-neural-hooks.md` — Gate 2 output
- `harness/consumer-smoke/run.mjs`, `README.md`, `.gitignore` — Gate 3 harness
- `docs/memory-stack-decision-memo.md` — this file

Suggest committing all four as one "chore(docs): agentdb removal research gates (#464)" before any Option-B code changes, so the research is preserved separately from the removal.

## If Option B is chosen — concrete next steps

1. Add init-time warning in `agentdb-backend.ts` → make it a pure export that logs "agentdb not available; using sql.js fallback with reduced pattern recall" on first import failure.
2. Delete `agentdb-backend.ts`, `@moflo/neural/reasoning-bank.ts` agentdb branch (lines 203-225, 262-274).
3. Delete 11 dead controller registrations from `controller-registry.ts` (lines 685-914 per audit).
4. Remove `agentdb` + `agentic-flow` from `package.json` and `src/modules/memory/package.json` (check both).
5. Strip the `AgentDBControllerName` type to only the 14 used controllers (or drop the distinction entirely).
6. Rerun `npm run build && npm test`.
7. Rerun `node harness/consumer-smoke/run.mjs` — expect 14/14 green + agentdb/agentic-flow reported as "absent".
8. Publish as `4.8.81-rc.0` via the `/publish` skill, install into a real consumer, smoke-check manually.
9. If green for a week, drop the `-rc` suffix.

## Open questions (for decision time)

1. **Deprecation warning for advanced users**: some consumers may actually be invoking `hooks_intelligence_learn` / `learningSystem` paths and getting meaningful value. Should we emit a one-time console notice pointing at a doc explaining what changed? Recommended: yes.
2. **ReasoningBank split**: neural/ and hooks/ have different backends (in-process Map vs bridge). Option B should consolidate on the bridge-backed version; should we file a follow-up issue or bundle into Option B's scope?
3. **causalGraph walks**: Gate 1 / Gate 2 didn't trace how deep real causal-graph queries go. Before Option B ships, spot-check 2-3 representative queries against the sql.js fallback to confirm latency is acceptable.
