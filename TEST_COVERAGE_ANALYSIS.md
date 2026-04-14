# Test Coverage Gap Analysis

Generated: 2026-04-14

## Executive Summary

This analysis identifies critical test coverage gaps across the MoFlo V3 codebase. While some modules have excellent coverage (spells, CLI, security), several critical components have **zero or minimal** test coverage.

### Coverage Status by Priority

| Priority | Module | Coverage | Status |
|----------|--------|----------|--------|
| 🔴 **CRITICAL** | Core Orchestrator | 0% | ❌ No tests |
| 🔴 **CRITICAL** | Claims MCP Tools | 0% | ❌ No tests |
| 🔴 **CRITICAL** | AIDefence Learning | 0% | ❌ No tests |
| 🟡 **HIGH** | AIDefence Integration | 20% | ⚠️ Basic only |
| 🟡 **HIGH** | RVFA Edge Cases | 60% | ⚠️ Missing edge cases |
| 🟢 **MEDIUM** | Claims Service | 80% | ✅ Good coverage |
| 🟢 **LOW** | GGUF Edge Cases | 70% | ✅ Good coverage |

---

## 1. 🔴 Core Orchestrator Module (CRITICAL)

**Status:** Zero test coverage  
**Risk:** High - Core infrastructure with no validation  
**Files:** `src/core/orchestrator/**/*.ts`

### Missing Test Coverage

#### TaskManager (0% coverage)
- ❌ Task creation and lifecycle
- ❌ Task queue management (priority queue)
- ❌ Task dependency resolution
- ❌ Task cancellation
- ❌ Metrics collection (active, completed, duration, failure rate)

#### SessionManager (0% coverage)
- ❌ Session creation and lifecycle
- ❌ Session state storage and retrieval
- ❌ Session persistence to disk
- ❌ Session restoration from disk
- ❌ Session expiration and TTL
- ❌ Session isolation

#### AgentPool (0% coverage)
- ❌ Agent registration and validation
- ❌ Agent lifecycle (start, stop, crash recovery)
- ❌ Agent selection (by capability, load balancing)
- ❌ Agent metrics (utilization, success rate)

#### HealthMonitor (0% coverage)
- ❌ Health check registration
- ❌ Periodic health check execution
- ❌ Health status aggregation (healthy/degraded/unhealthy)
- ❌ Failure detection and alerting
- ❌ Auto-recovery and restart logic
- ❌ Exponential backoff

#### EventCoordinator (0% coverage)
- ❌ Event publishing and subscription
- ❌ Event filtering
- ❌ Event ordering and concurrency
- ❌ Event persistence (ADR-007 event sourcing)
- ❌ Event replay from store
- ❌ Event snapshots

#### Integration Tests (0% coverage)
- ❌ Component initialization and wiring
- ❌ End-to-end task flow
- ❌ Graceful shutdown with state persistence
- ❌ Performance targets (<500ms startup, 100+ concurrent tasks)

### Test Skeleton Created
✅ `src/core/__tests__/orchestrator.test.ts` (117 test cases)

### Recommended Approach
1. **Phase 1:** TaskManager + TaskQueue (2 days)
2. **Phase 2:** SessionManager + persistence (2 days)
3. **Phase 3:** AgentPool + lifecycle (2 days)
4. **Phase 4:** HealthMonitor + EventCoordinator (2 days)
5. **Phase 5:** Integration tests (1 day)

**Estimated Effort:** 9 days

---

## 2. 🔴 Claims Module - MCP Tools (CRITICAL)

**Status:** Zero test coverage for MCP tools  
**Risk:** High - 14+ tools with no validation  
**Files:** `src/modules/claims/src/api/mcp-tools.ts`

### Missing Test Coverage

#### Core Claiming Tools (7 tools) - 0% coverage
1. ❌ `claims/issue_claim` - Issue claiming
2. ❌ `claims/issue_release` - Claim release
3. ❌ `claims/issue_handoff` - Handoff requests
4. ❌ `claims/issue_status_update` - Status updates
5. ❌ `claims/issue_list_available` - List unclaimed issues
6. ❌ `claims/issue_list_mine` - List my claims
7. ❌ `claims/issue_board` - Claim board view

#### Work Stealing Tools (4 tools) - 0% coverage
1. ❌ `claims/issue_mark_stealable` - Mark claim as stealable
2. ❌ `claims/issue_steal` - Steal stealable issue
3. ❌ `claims/issue_get_stealable` - List stealable issues
4. ❌ `claims/issue_contest_steal` - Contest a steal

#### Load Balancing Tools (3 tools) - 0% coverage
1. ❌ `claims/agent_load_info` - Agent load statistics
2. ❌ `claims/swarm_load_overview` - Swarm-wide load
3. ❌ `claims/swarm_rebalance` - Trigger rebalancing

#### Additional Tools (3 tools) - 0% coverage
1. ❌ `claims/claim_history` - Claim history
2. ❌ `claims/claim_metrics` - Claiming metrics
3. ❌ `claims/claim_config` - Configuration updates

### Missing Validation Tests
- ❌ Input schema validation (claimant types, priorities, statuses)
- ❌ Required field validation
- ❌ Authorization checks
- ❌ Error handling (service unavailable, not found, concurrent claims)
- ❌ Context integration (session ID, service injection)

### Test Skeleton Created
✅ `src/modules/claims/__tests__/mcp-tools.test.ts` (60+ test cases)

### Recommended Approach
1. **Phase 1:** Core claiming tools (3 days)
2. **Phase 2:** Work stealing tools (2 days)
3. **Phase 3:** Load balancing tools (2 days)
4. **Phase 4:** Additional tools + validation (2 days)

**Estimated Effort:** 9 days

---

## 3. 🔴 AIDefence - Learning Service (CRITICAL)

**Status:** Zero test coverage for learning features  
**Risk:** High - Self-learning system with no validation  
**Files:** `src/modules/aidefence/src/domain/services/threat-learning-service.ts`

### Missing Test Coverage

#### Pattern Learning (0% coverage)
- ❌ Learn new patterns from detections
- ❌ Update effectiveness scores on repeated detections
- ❌ Confidence decay for false positives
- ❌ Pattern metadata storage (source, context)

#### Vector Search / HNSW (0% coverage)
- ❌ Search similar threat patterns
- ❌ Similarity threshold filtering
- ❌ K-nearest neighbor limiting
- ❌ Integration with AgentDB for 150x-12,500x speedup

#### Mitigation Strategy Learning (0% coverage)
- ❌ Track mitigation effectiveness
- ❌ Adapt strategy based on success rate
- ❌ Per-threat-type mitigation tracking
- ❌ Meta-learning recursion depth (strange-loop)

#### Learning Trajectories - ReasoningBank (0% coverage)
- ❌ Record complete detection trajectories
- ❌ Calculate trajectory rewards
- ❌ Experience replay for learning

#### InMemoryVectorStore (0% coverage)
- ❌ Store and retrieve values
- ❌ Embedding support
- ❌ Namespace-based search
- ❌ Entry deletion
- ❌ Namespace isolation

### Test Skeleton Created
✅ `src/modules/aidefence/__tests__/threat-learning.test.ts` (40+ test cases)

### Recommended Approach
1. **Phase 1:** InMemoryVectorStore tests (1 day)
2. **Phase 2:** Pattern learning tests (2 days)
3. **Phase 3:** Vector search tests (1 day)
4. **Phase 4:** Mitigation strategy tests (2 days)
5. **Phase 5:** Trajectory tests (2 days)

**Estimated Effort:** 8 days

---

## 4. 🟡 AIDefence - Integration Tests (HIGH)

**Status:** Basic detection tests only (20% coverage)  
**Risk:** Medium - Missing end-to-end workflows  
**Files:** `src/modules/aidefence/src/index.ts`

### Missing Test Coverage

#### Detection + Learning Flow (20% coverage)
- ✅ Basic detection works
- ❌ Detection → Learn → Improve feedback loop
- ❌ Detection + mitigation + feedback integration

#### Trajectory-Based Learning (0% coverage)
- ❌ Multi-step detection trajectories
- ❌ Failed trajectory handling
- ❌ Partial success trajectories

#### Statistics and Monitoring (40% coverage)
- ✅ Detection count tracking
- ❌ Learned patterns count
- ❌ Mitigation strategies count
- ❌ Average mitigation effectiveness

#### Quick Scan Mode (60% coverage)
- ✅ Basic quick scan works
- ✅ Faster than full detect
- ❌ Confidence scoring

#### PII Detection (40% coverage)
- ✅ Basic PII detection
- ❌ Configuration-based behavior
- ❌ Integration with full scan

#### Configuration (0% coverage)
- ❌ Custom vector store integration
- ❌ Confidence threshold enforcement
- ❌ enablePIIDetection flag

#### Error Handling (20% coverage)
- ✅ Empty input
- ❌ Very long input (100k+ chars)
- ❌ Special characters
- ❌ Null/undefined inputs

#### Performance Benchmarks (0% coverage)
- ❌ <10ms detection time maintenance
- ❌ Concurrent detection handling

### Test Skeleton Created
✅ `src/modules/aidefence/__tests__/aidefence-integration.test.ts` (50+ test cases)

### Recommended Approach
1. **Phase 1:** Detection + learning flow (2 days)
2. **Phase 2:** Trajectory tests (2 days)
3. **Phase 3:** Configuration tests (1 day)
4. **Phase 4:** Error handling + performance (2 days)

**Estimated Effort:** 7 days

---

## 5. 🟡 RVFA/GGUF - Edge Cases (HIGH)

**Status:** Good basic coverage (60-70%), missing edge cases  
**Risk:** Medium - Production robustness concerns  
**Files:** `src/__tests__/appliance/*.test.ts`

### Missing Test Coverage

#### GGUF Edge Cases (30% missing)
- ✅ Basic parsing works
- ❌ Truncated file handling
- ❌ Invalid magic bytes
- ❌ Corrupted metadata
- ❌ Mismatched checksums
- ❌ Partial tensor data
- ❌ Large files >1GB (memory efficiency)
- ❌ Streaming for large files
- ❌ Models with 1000+ tensors
- ❌ Concurrent reads/writes
- ❌ Reader-writer contention
- ❌ Unsupported GGUF versions
- ❌ Unknown tensor types
- ❌ Unknown metadata keys (forward compatibility)
- ❌ Memory limits during parsing
- ❌ Timeout on slow reads
- ❌ Size limit enforcement

#### RVFA Edge Cases (40% missing)
- ✅ Basic build/read works
- ✅ Section checksums validate
- ❌ Duplicate section IDs
- ❌ Missing required sections
- ❌ Zero-size sections
- ❌ Sections exceeding max size
- ❌ Compression failures
- ❌ Decompression of corrupted data
- ❌ Compression ratio limits (decompression bombs)
- ❌ Mixed compression modes
- ❌ Wrong signing key
- ❌ Expired signatures
- ❌ Signature verification timeout
- ❌ Unsigned RVFA when signing required

#### RVFA Patch Edge Cases (50% missing)
- ✅ Basic patch creation works
- ❌ Patch for wrong appliance name
- ❌ Patch for wrong version
- ❌ Patch with invalid section
- ❌ Patch application failure + rollback
- ❌ Double-application prevention (idempotency)

#### Profile Validation (0% coverage)
- ❌ Invalid profile rejection
- ❌ Profile capability enforcement (ruvllm)
- ❌ Boot configuration validation per profile

#### API Key Encryption Edge Cases (30% missing)
- ✅ Basic encryption/decryption works
- ❌ Wrong passphrase rejection
- ❌ Corrupted encrypted data
- ❌ Minimum passphrase strength
- ❌ Empty .env file
- ❌ API key format validation

#### Concurrent Operations (0% coverage)
- ❌ Prevent concurrent builds
- ❌ Allow concurrent reads
- ❌ Prevent concurrent patch applications

#### Network Operations - RvfaPublisher (0% coverage)
- ❌ Failed upload retry logic
- ❌ Upload timeout
- ❌ Network interruption recovery
- ❌ Post-upload checksum verification

#### Resource Limits (0% coverage)
- ❌ Total RVFA size limit
- ❌ Section count limit
- ❌ Memory usage during build
- ❌ Operation timeout

#### Integration Edge Cases (0% coverage)
- ❌ GGUF embedding in RVFA (offline profile)
- ❌ GGUF validation before embedding
- ❌ GGUF extraction at runtime
- ❌ GGUF compression efficiency

#### Cross-Platform Compatibility (0% coverage)
- ❌ Linux-specific behavior
- ❌ macOS-specific behavior
- ❌ Windows-specific behavior
- ❌ Path separator handling

#### Version Migration (0% coverage)
- ❌ RVFA v1 → v2 upgrade
- ❌ Data preservation during migration
- ❌ Downgrade prevention

### Test Skeleton Created
✅ `src/__tests__/appliance/edge-cases.test.ts` (80+ test cases)

### Recommended Approach
1. **Phase 1:** File corruption and validation (2 days)
2. **Phase 2:** Large files and performance (2 days)
3. **Phase 3:** Concurrent operations (1 day)
4. **Phase 4:** Network operations (2 days)
5. **Phase 5:** Cross-platform and migration (2 days)

**Estimated Effort:** 9 days

---

## 6. Additional Identified Gaps

### Claims Module - Domain Layer
**Status:** Good coverage (80%) based on existing tests  
**Files:** `src/modules/claims/tests/*.test.ts`  
**Gaps:**
- ❌ Complex handoff scenarios (multi-hop)
- ❌ Concurrent claim attempts (race conditions)
- ❌ Claim expiration edge cases
- ❌ Auto-assignment algorithm validation

**Estimated Effort:** 2 days

### Memory Module
**Status:** Good coverage based on grep results  
**Gaps:**
- ❌ HNSW index corruption recovery
- ❌ Vector quantization edge cases
- ❌ Concurrent memory operations stress tests

**Estimated Effort:** 3 days

### Swarm Module
**Status:** Good coverage based on grep results  
**Gaps:**
- ❌ Byzantine fault scenarios
- ❌ Network partition recovery
- ❌ Leader election edge cases

**Estimated Effort:** 4 days

---

## Summary: Total Test Gaps by Category

| Category | Test Cases Needed | Estimated Effort |
|----------|-------------------|------------------|
| 🔴 Core Orchestrator | 117 | 9 days |
| 🔴 Claims MCP Tools | 60+ | 9 days |
| 🔴 AIDefence Learning | 40+ | 8 days |
| 🟡 AIDefence Integration | 50+ | 7 days |
| 🟡 RVFA/GGUF Edge Cases | 80+ | 9 days |
| 🟢 Claims Domain | 20+ | 2 days |
| 🟢 Memory Module | 30+ | 3 days |
| 🟢 Swarm Module | 40+ | 4 days |
| **TOTAL** | **437+** | **51 days** |

---

## Prioritization Recommendations

### Sprint 1 (2 weeks) - Critical Infrastructure
1. Core Orchestrator basics (TaskManager, SessionManager)
2. Claims MCP Tools (Core claiming + Work stealing)
3. AIDefence Learning (InMemoryVectorStore + Pattern learning)

### Sprint 2 (2 weeks) - Integration & Learning
1. Core Orchestrator advanced (AgentPool, HealthMonitor, EventCoordinator)
2. Claims MCP Tools (Load balancing + Additional tools)
3. AIDefence Learning (Mitigation strategies + Trajectories)

### Sprint 3 (2 weeks) - End-to-End & Edge Cases
1. Core Orchestrator integration tests
2. AIDefence integration tests
3. RVFA/GGUF edge cases (high-priority items)

### Sprint 4 (1 week) - Polish & Additional Coverage
1. RVFA/GGUF remaining edge cases
2. Claims domain edge cases
3. Memory and Swarm module gaps

---

## Metrics to Track

### Code Coverage Targets
- **Critical modules:** 90%+ coverage
- **High priority:** 80%+ coverage
- **Medium priority:** 70%+ coverage

### Quality Metrics
- **Test execution time:** <2 minutes for full suite
- **Test reliability:** 99%+ pass rate (no flaky tests per Broken Window Theory)
- **Coverage delta:** +5% minimum per sprint

### Performance Benchmarks
- Core Orchestrator startup: <500ms
- AIDefence detection: <10ms
- RVFA build: <2s for typical appliance
- Test suite: <2 minutes total

---

## Test Skeleton Files Created

1. ✅ `src/modules/aidefence/__tests__/threat-learning.test.ts`
2. ✅ `src/modules/aidefence/__tests__/aidefence-integration.test.ts`
3. ✅ `src/modules/claims/__tests__/mcp-tools.test.ts`
4. ✅ `src/core/__tests__/orchestrator.test.ts`
5. ✅ `src/__tests__/appliance/edge-cases.test.ts`

**Total:** 437+ test case placeholders ready for implementation

---

## Next Steps

1. **Review this analysis** with the team
2. **Prioritize sprints** based on risk and dependencies
3. **Assign test implementation** to team members
4. **Set up coverage tracking** in CI/CD
5. **Implement Broken Window Theory** - fix all failing tests before adding new ones
6. **Track progress** against coverage targets

## Notes

- All test skeletons follow the existing patterns (Vitest for new modules, node:test for appliance)
- Placeholders marked with `// TODO:` for easy grep: `grep -r "// TODO:" src/**/*.test.ts`
- Each test skeleton includes structure and descriptions for rapid implementation
- Integration tests focus on end-to-end workflows, not unit-level duplication
