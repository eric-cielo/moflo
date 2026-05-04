# Authoring MoFlo MCP Tools

**Purpose:** How to add or edit MCP tools under `src/cli/mcp-tools/`. Codifies the coordinator-backed contract that CLAUDE.md's ⛔ block enforces (epic #798) so the rule lives in the corpus Claude searches before it edits, not just in CLAUDE.md prose. Internal-only — consumers do not author moflo MCP tools.

> The CLAUDE.md ⛔ "Protected functionality — swarm + hive-mind" block is the load-bearing version of these rules. This doc is the indexed reference; CLAUDE.md is the project entry point. They must stay aligned.

---

## 1. File Layout and Tool Surface

**Group tools by domain in `src/cli/mcp-tools/<domain>-tools.ts`.** Each file exports an `MCPTool[]` array. Domains today: `agent`, `aidefence`, `coordination`, `github`, `hive-mind`, `hooks`, `memory`, `moflodb`, `neural`, `performance`, `security`, `session`, `spell`, `swarm`, `system`, `task`. Add a new file when the new tool's domain is genuinely separate; do not invent a 16th domain to host one tool.

| File | What lives there |
|------|-------------------|
| `src/cli/mcp-tools/<domain>-tools.ts` | `MCPTool[]` array — `name`, `description`, `category`, `inputSchema`, `handler` |
| `src/cli/mcp-tools/<domain>-coordinator-singleton.ts` | Singleton accessor for the underlying coordinator (one per domain) |
| `src/cli/mcp-tools/types.ts` | Shared `MCPTool` type — never redefine inline |
| `src/cli/mcp-tools/_helpers.ts` (under `__tests__/`) | Test helpers like `getSwarmTool`, `getAgentTool` — reuse, don't fork |

**Canonical example for the wired-coordinator pattern: `src/cli/mcp-tools/swarm-tools.ts`.** Read it before writing a new MCP tool. The post-#798 surface is the contract.

---

## 2. The Coordinator-Backed Contract

**Every handler that owns runtime state MUST route through its domain coordinator — never a JSON-store write, never a hardcoded literal, never `Date.now()`-suffixed fake IDs.** This is the rule epic #798 (10 stories) was opened to repair after handlers were silently stubbed during a "simplification" pass.

| Anti-pattern | What's wrong | Correct pattern |
|--------------|--------------|-----------------|
| `return { swarmId: 'swarm-' + Date.now() }` | Synthetic ID, no coordinator state | `await coordinator.initialize(...)` returns the real ID |
| `return { agentCount: 0, taskCount: 0 }` | Hardcoded literal, lies about live state | `coordinator.getState()` / `coordinator.getAgents()` |
| `await fs.writeFile(stateFile, JSON.stringify(...))` | File-based bypass of coordinator | `coordinator.spawnAgent(...)` and let the coordinator persist |
| `if (!coordinator) return { success: true }` | "We'll wire it later" — silent stub | Throw or return `success: false` with a real error |

**Verification on every change to `src/cli/mcp-tools/{swarm,agent,task,hive-mind}-tools.ts`** (see CLAUDE.md ⛔ for the canonical list):

1. `agent_spawn` invokes `coordinator.spawnAgent(...)`
2. `swarm_init` invokes `coordinator.initialize(...)`
3. `swarm_status` / `swarm_health` query the coordinator (not literals)
4. `task_*` invokes `coordinator.distributeTasks` / `executeTask` / `cancelTask`
5. `hive-mind_*` routes through `MessageBus` + `WriteThroughAdapter`; workers register with the shared coordinator
6. `tests/system/swarm-restoration-e2e.test.ts` exercises the wired path end-to-end

---

## 3. Tool Definition Structure

**Use inline JSONSchema in `inputSchema`.** There is no shared validator library across MCP tools today (valibot is used for config, not for tool inputs). Inline schema keeps the tool self-describing for the MCP client.

```ts
export const swarmTools: MCPTool[] = [
  {
    name: 'swarm_init',
    description: 'Initialize the swarm coordinator (idempotent — returns the existing swarmId on re-init)',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', description: 'Swarm topology (...)' },
        maxAgents: { type: 'number', description: 'Maximum number of agents' },
      },
    },
    handler: async (input) => {
      const coordinator = await getSwarmCoordinator({ /* config */ });
      // ... real coordinator call ...
      return { success: true, swarmId: coordinator.id, /* live state */ };
    },
  },
];
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Snake_case, domain-prefixed (`swarm_init`, `agent_spawn`); the MCP wire name |
| `description` | yes | One sentence. State the contract (idempotent? side-effecting?) |
| `category` | yes | Matches the file's domain (`'swarm'`, `'agent'`, etc.) |
| `inputSchema` | yes | Inline JSONSchema; document every property |
| `handler` | yes | `async (input) => result`; validate `input` defensively (cast unknown to typed via guards) |

**Idempotent operations MUST say so in the description and prove it in the handler.** `swarm_init` is the canonical example: re-init returns the existing swarmId rather than creating a new swarm.

---

## 4. Path Resolution Inside Handlers

**Always use `findProjectRoot()` from `../services/project-root.js` for the project root** — never `process.cwd()` (the daemon-launched MCP server inherits cwd from wherever it was spawned). Compose project-relative paths via `MOFLO_DIR` from `../services/moflo-paths.js`, never literal `'.moflo'`.

```ts
import { findProjectRoot } from '../services/project-root.js';
import { MOFLO_DIR } from '../services/moflo-paths.js';

const dir = join(findProjectRoot(), MOFLO_DIR);  // correct
const dir = join(process.cwd(), '.moflo');       // wrong — cwd is unstable
```

See `internal/consumer-project-paths.md` for the cross-cutting rule.

---

## 5. Healer Probe Contract

**Any MCP tool whose correctness depends on coordinator state MUST be exercised by a `flo healer` functional probe.** The probe lives in `src/cli/commands/doctor-checks-<domain>.ts` (e.g. `doctor-checks-swarm.ts`) and runs in CI on every release. If a regression turns a real handler into a stub, healer fails — that is the whole point.

| Probe shape | Purpose |
|-------------|---------|
| `swarm_init` returns `success: true` with a non-stub `swarmId` from `UnifiedSwarmCoordinator` | Catches synthetic-ID stubs |
| `swarm_status` returns `agentCount > 0` after a real spawn | Catches `0`-literal stubs |
| `agent_list` includes the just-spawned agentId | Catches JSON-store-only writes |
| `agent_terminate` with `terminated: true` removes from coordinator state | Catches no-op handlers |

The healer JSON output (`flo healer --json`) shows each subcheck's `expected` and `observed` — model new probes after the existing entries in `doctor-checks-swarm.ts` and `doctor-checks-hive-mind.ts`.

---

## 6. Test Contract — Both Levels

**Two test layers are required for any tool that owns runtime state.** Skipping the system E2E is the failure mode that allowed #798 to ship.

| Layer | File pattern | Asserts |
|-------|--------------|---------|
| Unit | `src/cli/__tests__/mcp-tools/<tool-name>.test.ts` | Per-handler input validation, schema enforcement, error paths |
| System E2E | `tests/system/<domain>-restoration-e2e.test.ts` | Full lifecycle through real coordinator; afterEach resets singletons via `_resetXForTest()` |

**The system E2E pattern (from `tests/system/swarm-restoration-e2e.test.ts`):**

```ts
afterEach(async () => {
  _setSwarmPersistenceForTest(null);
  await _resetSwarmCoordinatorForTest();
});

it('init → spawn × 3 → orchestrate × 5 → status reflects everything', async () => {
  const init = (await getSwarmTool('swarm_init').handler({ topology: 'mesh' })) as { swarmId: string };
  // ... lifecycle assertions on live coordinator state ...
});
```

If the unit test passes but the E2E catches a regression, the unit test was mocking the coordinator. Tighten the unit test until the regression would have been visible there too.

---

## 7. Adding a New Tool — Checklist

Before opening a PR that adds an MCP tool:

1. **File chosen** by domain; reusing existing `<domain>-tools.ts` if domain already exists, new file only if genuinely separate.
2. **`MCPTool` shape** — `name`, `description`, `category`, `inputSchema`, `handler`.
3. **Coordinator-backed** — handler invokes the real coordinator method; no synthetic literals.
4. **Path resolution** — `findProjectRoot()` + `MOFLO_DIR`, never `process.cwd()` or `'.moflo'`.
5. **Unit test** at `src/cli/__tests__/mcp-tools/<tool>.test.ts`.
6. **System E2E entry** in `tests/system/<domain>-restoration-e2e.test.ts` if state-owning.
7. **Healer probe** in `doctor-checks-<domain>.ts` with `expected` / `observed` shape matching siblings.
8. **CLAUDE.md ⛔ list** — if the new tool is part of swarm/agent/task/hive-mind, ensure the verification list still covers it.
9. **Smoke** — `flo healer` passes locally; `npm test` green; the system E2E green individually (`vitest run tests/system/<file>`).

---

## 8. Editing an Existing Tool — Regression Risks

**Before changing an existing handler, name what would break for someone on `moflo@<previous>` picking the change up via `npm install`.** The MCP wire name is part of the public surface. Rename = breaking. Removing a property from `inputSchema` = breaking. Tightening a description without behavior change = safe.

| Change type | Consumer impact | Action |
|-------------|------------------|--------|
| Rename `name` field | Breaks existing callers | Don't — add a new tool, alias the old |
| Remove `inputSchema` property | Breaks callers passing it | Don't — make it optional with a deprecation note |
| Tighten validation (was permissive) | May reject previously-accepted input | Surface in CHANGELOG; consider grace-period default |
| Add new optional property | Backward-compatible | Safe; document in description |
| Refactor handler internals | Invisible if behavior preserved | Run system E2E to confirm |

**The healer probe is the regression net.** If a refactor makes the probe fail, the refactor changed observable behavior — investigate before "fixing" the probe.

---

## See Also

- `CLAUDE.md` (root) — ⛔ Protected functionality block; load-bearing version of section 2
- `.claude/guidance/internal/hook-authoring.md` — Sibling rules for `.claude/helpers/` hook handlers
- `.claude/guidance/internal/testing-conventions.md` — Vitest patterns, isolation list, and the bootstrap rules cited in section 6
- `.claude/guidance/internal/coding-style.md` — Decomposition + DRY rules that apply to MCP tool source files
- `.claude/guidance/internal/consumer-project-paths.md` — Why `findProjectRoot()` not `process.cwd()`
- `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md` — Consumer-facing description of the swarm/agent/task surface this doc authors
- `.claude/guidance/shipped/moflo-error-handling.md` — Imperative-vs-defensive style applied to handler bodies
