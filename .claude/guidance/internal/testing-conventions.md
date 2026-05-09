# MoFlo Vitest Testing Conventions

**Purpose:** General Vitest patterns and discipline rules for moflo's own test suite. Sibling to `internal/testing-performance.md` (parallelism + fork contention) and `internal/testing-sandboxing.md` (Docker-sandbox tests). Internal-only — consumers do not run moflo's test suite.

> The Broken Window Theory rule from `CLAUDE.md` is non-negotiable here: every failing test, every warning, every flake gets fixed before moving on. A red signal is never acceptable as background noise. This doc covers *how* to fix them; CLAUDE.md sets the bar.

---

## 1. The Two Configs

| Config | Purpose | Driven by |
|--------|---------|-----------|
| `vitest.config.ts` | Parallel run with `maxForks=2`; excludes the `isolationTests` array | `npm test` (default) |
| `vitest.isolation.config.ts` | Sequential run of `isolationTests` only | `scripts/test-runner.mjs` second pass |

**`scripts/test-runner.mjs` runs both passes.** The full-suite signal you care about (red/green) is what `npm test` reports, which orchestrates both. Never run `vitest` directly when validating a fix — you'll skip the isolation pass and get a false-green.

---

## 2. The `isolationTests` List Is Not a Park-It-And-Forget Bin

**Adding a test to `isolationTests` is acknowledging a real problem, not avoiding it.** Tests on the list typically suffer from:

- Dynamic-import load + Windows fork contention (`maxForks=2` on Windows isn't enough headroom)
- `process.chdir` per test (cwd is process-global; parallel forks step on each other)
- Singleton/registry resets (module-shared state)
- Performance/timing assertions that bust under parallel load

**Each isolation entry MUST have a comment explaining WHY** — see existing entries in `vitest.config.ts` for the canonical shape. A bare path is a TODO, not a justification.

| Reason | Example entry |
|--------|---------------|
| Dynamic-import load on Windows | `'src/cli/__tests__/doctor-checks-deep.test.ts'` |
| `process.chdir` + module singleton | `'src/cli/__tests__/bridge-entries.test.ts'` |
| Cold-start network/model load | `'src/cli/__tests__/embeddings/fastembed-inline-integration.test.ts'` |
| Timing-based parallelism assertion | `'src/cli/__tests__/spells/preflights.test.ts'` |

**Never bump per-test timeouts above 30s as a workaround** (`feedback_no_test_timeout_bumps`). A slow test is a bug at the source — find the contention and fix it, or move the test to isolation with a real comment. Don't paper over it with `{ timeout: 60_000 }`.

---

## 3. AgentDB / ReasoningBank / GuidanceProvider — beforeAll, Not beforeEach

**Cold-boot of moflo's memory layer is ~5s.** Tests that exercise `ReasoningBank`, `GuidanceProvider`, or any `AgentDB`-backed component MUST initialize the backend in `beforeAll` and use the explicit `_clearForTest()` reset between cases — not `beforeEach` re-init.

```ts
let bank: ReasoningBank;

beforeAll(async () => {
  bank = await ReasoningBank.createForTest();  // ~5s cold boot
});

beforeEach(async () => {
  await bank._clearForTest();  // <50ms; just clears state
});
```

Doing this with `beforeEach` recreates the AgentDB on every test — a 50-test file becomes a 250-second file. See `feedback_reasoningbank_test_bootstrap` for the incident that produced this rule.

---

## 4. The `_helpers.ts` and `_*ForTest()` Pattern

**Test-only helpers and resets live next to the code they exercise, prefixed with `_`.** Examples:

| Path | Purpose |
|------|---------|
| `src/cli/__tests__/mcp-tools/_helpers.ts` | `getSwarmTool(name)`, `getAgentTool(name)`, `spawnAgentForTest()` — reusable across MCP tests |
| `src/cli/__tests__/swarm/_in-memory-persistence.ts` | `createInMemoryPersistence()` — substitute for `SwarmPersistence` in tests |
| `_resetSwarmCoordinatorForTest()` | Module-exported reset for the singleton |
| `_setSwarmPersistenceForTest()` | Module-exported persistence injection |

**The `_` prefix is the export convention for test-only API surface.** Real consumers must never call these. Lint rules block external imports of `_*ForTest()` helpers — keep them internal-only.

---

## 5. System E2E Tests — `tests/system/`

**System E2Es exercise the full wired path through real coordinators.** They are the safety net for the CLAUDE.md ⛔ contract on swarm/agent/task/hive-mind. Pattern:

```ts
afterEach(async () => {
  _setSwarmPersistenceForTest(null);
  await _resetSwarmCoordinatorForTest();
});

it('init → spawn × 3 → orchestrate × 5 → status reflects everything', async () => {
  // Drive the MCP handler through a real lifecycle.
  // Assert real coordinator state at each step.
});
```

| Rule | Reason |
|------|--------|
| Always reset singletons in `afterEach` | Bleed-over masks regressions and flakes neighbors |
| Use real coordinators, real persistence (in-memory variant OK) | Mocked coordinators hid the #798 stub regression for months |
| Assert observable state, not internal calls | Stubs satisfy "method was called" but lie about state |
| Mirror the `flo healer` probe | If both system E2E and healer agree, the surface is wired |

---

## 6. Random-Input / Property Tests — Mismatch Char Outside the Alphabet

**When testing string validators with a "must differ from valid" mismatch, the mismatch character must be OUTSIDE the valid alphabet.** Otherwise random sampling will pick the mismatch char as a valid generated value and the test green-flakes (`feedback_test_mismatch_chars`).

```ts
// Wrong — 'X' is in the valid base64 alphabet, ~1/64 chance the random input is just 'X'
const invalid = original + 'X';

// Right — '!' is never in base64url
const invalid = original + '!';
```

Audit any test with `invalid = valid + <char>` against the validator's accepted set.

---

## 7. Spell / Bash Step Tests — Permissions and Sandbox Constraints

**Bash spell step tests must verify both the capability set AND the `permissionLevel`** (`feedback_double_check_step_permissions`). Spells running under bwrap with default permissions get `--unshare-net`; tests that exercise DNS/SSH must explicitly assert `permissionLevel: elevated`.

| Constraint | Test must assert |
|------------|------------------|
| Bash step needs network | `permissionLevel: 'elevated'` is set |
| Bash step needs `git push` | `GH_TOKEN` is injected and elevated permission held |
| Bash step writes outside `/workspace` | Capability list includes the path |
| Sandbox uses bind-mounted git config | `git config --system` not `--global` (Dockerfile) |

**Never end a Bash step with `cleanup || true`** (`feedback_bash_trailing_or_true`) — the trailing `|| true` masks upstream failures including the very thing the cleanup was meant to handle. Lead with `set -e` and let real failures surface.

---

## 8. Cross-Platform — Tests Run On Windows Too

**No `/dev/null`, no POSIX `mkdir -p`, no bash heredoc in spell-step bash bodies on Windows** (`feedback_spell_bash_minimal_path`). Use `node -e` with `fs`/`os` for file ops in tests that exercise spell steps. The CI matrix runs Windows, macOS, and Linux — tests that pass only on POSIX block releases until rewritten.

See `shipped/moflo-cross-platform.md` for the full universal rule.

---

## 9. Embeddings Are Required, Not Optional

**Hash embeddings are banned** (`project_embeddings_hard_require`). All test fixtures that use vector search must use the real `fastembed`/`onnxruntime-node` runtime. Hash fallbacks made test results meaningless because semantic similarity collapsed to keyword match. The `tests/guards/hash-fallback-guard.test.ts` enforces this — never disable it.

First-run downloads the ~25 MB ONNX model from GCS; subsequent runs hit the cache. The cache-cold path is in `isolationTests` for that reason.

---

## 10. Smoke Harness — `npm run test:smoke`

**The consumer-smoke harness lives in `harness/consumer-smoke/run.mjs` and exercises moflo from a fresh consumer-shaped project.** It catches issues that pure unit tests miss — package files-array drift, postinstall failures, launcher path resolution — before they ship to real consumers.

| When to run | Command |
|-------------|---------|
| Before a publish | `npm run test:smoke` (and `:populated` for the populated-project variant) |
| After editing `bin/`, init/, or settings-generator | Same |
| Routine PR | Not required; CI handles it |

The smoke harness is also a path-safety enforcement point — see `feedback_path_safety_gates`. Internal `process.cwd()` leaks fail the smoke stderr scan.

---

## 11. Test What You Change — Real-Functionality Coverage Is Mandatory

**Any changed functionality must be tested to the degree it can be tested.** A bug fix or feature without a test is incomplete — even when CI is green and the unit tests still pass, "no test for the new path" means you don't know if the change actually does what you think. Default posture: **add the test before declaring done.**

The standard scales with what's testable, not with how much effort feels appropriate:

| Surface | Standard test to add |
|---------|----------------------|
| Pure function (classifier, parser, serializer) | Unit test — happy path + each branch + each negative case |
| Module-level integration (runner ↔ checker, hook ↔ executor) | Integration test exercising the real wiring with fakes only at the I/O boundary |
| Cross-module / system behavior (full spell cast, MCP handler lifecycle) | System E2E in `tests/system/` driving the real coordinator (see §5) |
| Behavior that depends on TTY / network / OS state that the runner can't simulate cleanly | Inject the dependency through an option (e.g. `RunnerOptions.authErrorConfirm` from #1042); test against the injected hook; document the live-machine smoke step the maintainer must run |

**No exceptions for "I can't easily mock this."** If the production code is hard to test, that's design feedback — refactor to an inject-the-dependency shape so the test surface is reachable. The runner's `authErrorConfirm` hook and the prereq resolver's `promptLine` injection are the canonical examples.

### Smoke tests: reliable or not at all

**Smoke tests catch what unit tests can't and pay for themselves only when they're reliable.** A flaky smoke test trains everyone to ignore the smoke signal — the next *real* break gets ignored too (Broken Window applies here as forcefully as anywhere). Before adding a smoke test:

| Constraint | Required answer |
|------------|-----------------|
| Run time | Bounded — under 30s per case, under 2 min for a full smoke pass |
| Determinism | No timing races, no network reachability assumptions, no flakiness on cold cache |
| Failure mode | A red signal means a real bug, not "machine was slow today" |
| Maintenance cost | Lower than the cost of catching the bug class some other way |

If the smoke test can't satisfy all four, **don't add it** — find the unit / integration / system-E2E shape that does, or document the live-machine validation as part of the merge gate (per the AC pattern in #1042: "Real-scenario verification (mandatory before merge)" with explicit step-by-step the maintainer runs).

The consumer-smoke harness (§10) is the existing canonical reliable smoke — if you're adding more smoke surface, model it on that one, not on a one-off shell script that depends on environmental coincidence.

---

## 12. Diagnosing a Failure — Re-Verify Individually

**A test that fails in the full suite is either a real failure or a flake; the way to tell is to re-run it alone.** Per the Broken Window rule:

```bash
# Suite run shows the failure
npm test

# Re-run the file alone to distinguish real vs flake
npx vitest run path/to/the/failing.test.ts
```

| Outcome | Action |
|---------|--------|
| Fails alone too | Real failure — fix it |
| Passes alone | Flake under load — investigate the contention; isolation is a last resort, not a first response |
| Passes only sometimes alone | Genuine race — fix the race, not the symptom |

**Never just re-run the full suite hoping for green.** That's a broken window; the next failing test will be ignored too.

---

## See Also

- `.claude/guidance/internal/testing-performance.md` — Parallelism, fork contention, and per-test perf budgets
- `.claude/guidance/internal/testing-sandboxing.md` — Docker-sandbox-specific test rules
- `.claude/guidance/internal/mcp-tool-authoring.md` — System E2E pattern for MCP tools (section 6 there) is the load-bearing variant
- `.claude/guidance/internal/hook-authoring.md` — Hook tests use `tests/bin/gate-helpers.test.ts` as the canonical target
- `.claude/guidance/internal/coding-style.md` — Decomposition rules apply to test files too; multi-thousand-line test files are a smell
- `.claude/guidance/internal/pre-publish-rules.md` — Pre-publish checks that depend on a clean test suite
- `.claude/guidance/shipped/moflo-cross-platform.md` — Cross-platform constraints applied to test code
- `.claude/guidance/shipped/moflo-error-handling.md` — Imperative error rules; tests must surface real failures, not swallow them
