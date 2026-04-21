# Consumer-surface audit — agentdb controllers
Date: 2026-04-20
Epic: #464 Gate 1

## Summary

Removal safety assessment: Moderate risk with clear mitigation path.

- 14 actively-consumed controllers: All have explicit fallbacks or no-op stubs. Removing agentdb would degrade behavior but not crash.
- 11 supposedly-dead controllers: Verified zero consumer calls in CLI/MCP/hooks. Safe to omit.
- Consumer regression on removal: Search/store work via sql.js (slower); hierarchical memory uses in-memory stubs; learning/causal/routing return null/no-op.
- Verdict: Option B-safe for removal if consumer code accepts degraded (not broken) UX.

## Per-controller breakdown

### Actively consumed (14 controllers)

#### 1. reflexion (ReflexionMemory)
- memory-bridge methods: bridgeSessionStart() line 1424-1470, bridgeSessionEnd() line 1475-1537
- CLI consumers: commands/memory.ts via MCP wrappers
- Fallback: Falls back to bridgeSearchEntries() and bridgeStoreEntry()
- Consumer-visible on removal: Degraded (no episodic replay, but sessions tracked in SQL)
- Verdict: Safe to remove.

#### 2. skills (SkillLibrary)
- memory-bridge methods: bridgeRecordFeedback() line 1341-1347
- CLI consumers: Via hooks_post-task feedback recording
- Fallback: If unavailable, skips promote() call; feedback still recorded
- Verdict: Safe to remove.

#### 3. reasoningBank (Trajectory storage)
- memory-bridge methods: bridgeStorePattern() line 1189, bridgeSearchPatterns() line 1234, bridgeRecordFeedback() line 1321
- MCP tools: agentdbPatternStore, agentdbPatternSearch
- Fallback: Falls back to bridgeStoreEntry() and bridgeSearchEntries()
- Verdict: Safe to remove.

#### 4. hierarchicalMemory (Tiered short/long/meta)
- memory-bridge methods: bridgeHierarchicalStore() line 1644, bridgeHierarchicalRecall() line 1676
- Fallback: createTieredMemoryStub() at controller-registry.ts:974-1011 (in-memory Maps, keyword matching)
- Verdict: Safe to remove.

#### 5. memoryConsolidation (Promote short-long, dedup)
- memory-bridge methods: bridgeConsolidate() line 1715-1724
- Fallback: createConsolidationStub() at controller-registry.ts:1017-1023 (no-op)
- Verdict: Safe to remove with caveats (manual cleanup needed).

#### 6. learningSystem (Reward/gradient learning)
- memory-bridge methods: bridgeRecordFeedback() line 1302, bridgeRouteTask() line 1574
- Fallback: If unavailable, feedback still records; routing returns null
- Verdict: Safe to remove.

#### 7. nightlyLearner (Batch offline learning)
- Called from bridgeSessionEnd() line 1525-1531
- Fallback: If unavailable, skips consolidate trigger; session still ends
- Verdict: Safe to remove.

#### 8. semanticRouter (Route queries by semantics)
- memory-bridge methods: bridgeRouteTask() line 1545, bridgeSemanticRoute() line 1814
- Fallback: If unavailable, returns null; caller falls back to local router
- Verdict: Safe to remove.

#### 9. causalGraph / causalRecall (Graph edges & walks)
- memory-bridge methods: bridgeRecordCausalEdge() line 1374-1416
- Fallback: Falls back to raw SQL insert into memory_entries table
- Verdict: Safe to remove.

#### 10. mutationGuard (Detect anomalous writes)
- memory-bridge methods: guardValidate() helper line 282-297
- Fallback: If unavailable, returns allowed:true; if throws, allowed:false (fail-closed)
- Verdict: Safe to remove.

#### 11. attestationLog (Append-only audit log)
- memory-bridge methods: logAttestation() helper line 304-322
- Fallback: If unavailable, silently no-ops
- Verdict: Safe to remove.

#### 12. contextSynthesizer (Summarize retrieval for context)
- memory-bridge methods: bridgeContextSynthesize() line 1776-1807
- Fallback: If unavailable, returns error
- Verdict: Safe to remove.

#### 13. batchOperations (Bulk insert/update/delete)
- memory-bridge methods: bridgeBatchOperation() line 1732-1770
- Fallback: If unavailable, returns error
- Verdict: Safe to remove.

#### 14. hierarchicalMemory (also consumed by contextSynthesizer)
- See item 4 above.

---

### Dead controllers (11) — Verified zero consumer calls

All have zero calls in memory-bridge.ts:

1. sonaTrajectory: controller-registry.ts:685-694
2. gnnService: controller-registry.ts:864-875
3. graphTransformer: controller-registry.ts:801-809
4. explainableRecall: controller-registry.ts:781-789
5. guardedVectorBackend: controller-registry.ts:888-903
6. rvfOptimizer: controller-registry.ts:877-886
7. vectorBackend: controller-registry.ts:905-914
8. graphAdapter: controller-registry.ts:905-914
9. federatedSession: controller-registry.ts:735-737 (returns null)
10. mmrDiversityRanker: controller-registry.ts:831-838
11. causalRecall: controller-registry.ts:761-769 (causalGraph called at line 1385, but not causalRecall)

All 11 are safe to remove.

---

## Consumer paths mapping

CLI commands: commands/memory.ts routes via memory-initializer.ts to memory-bridge.ts

MCP tools: agentdb-tools.ts wraps 15+ bridge functions

Hooks: hooks_post-task calls bridgeRecordFeedback()

---

## Key findings

All actively-consumed controllers have fallback logic in memory-bridge.ts. When registry is unavailable, methods return null and callers handle degradation gracefully. The 11 supposedly-dead controllers have zero call sites in the consumer surface (CLI commands, MCP tools, hooks).

## Recommendations

1. Phase 1: Keep memory-bridge as-is; make agentdb true optional dependency
2. Phase 2: Reimplement Low controllers as moflo-owned classes
3. Phase 3: Verify causalGraph usage; decide on graph walk support
4. Phase 4: Remove agentdb dependency; simplify controller-registry

