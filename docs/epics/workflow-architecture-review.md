# Epic: Workflow & Steps/Tools Plugin Architecture Review

**Date:** 2026-03-29
**Status:** Draft
**Priority:** High
**Scope:** `src/packages/workflows/`, `src/packages/cli/src/mcp-tools/workflow-tools.ts`, `src/packages/cli/src/commands/workflow.ts`

---

## Summary

Full architectural review of the workflow engine, step commands, workflow tools, and CLI/MCP surface. This epic captures verified findings, suspected issues requiring deeper investigation, and improvement opportunities across the three-layer workflow system.

---

## Architecture Context

The workflow system has three layers:

| Layer | Path | Lines | Role |
|-------|------|-------|------|
| **Engine** | `src/packages/workflows/` | ~8,000 | Real execution: WorkflowRunner, step commands, tools, registries |
| **MCP Tools** | `src/packages/cli/src/mcp-tools/workflow-tools.ts` | 671 | MCP tool handlers exposed to Claude sessions |
| **CLI** | `src/packages/cli/src/commands/workflow.ts` | 742 | CLI subcommands that call MCP tools via `callMCPTool()` |

The engine also exposes a **Runner Bridge** (`src/packages/workflows/src/factory/runner-bridge.ts`) intended as the integration point for MCP tools, but the current MCP layer does not use it.

---

## Issue 1: MCP Workflow Tools Do Not Use the Real Engine

**Severity:** HIGH
**Files:** `src/packages/cli/src/mcp-tools/workflow-tools.ts`

### Analysis

The 10 MCP tools (`workflow_run`, `workflow_execute`, `workflow_status`, etc.) maintain their own file-based store at `.claude-flow/workflows/store.json` with their own `WorkflowRecord`/`WorkflowStep` types (lines 16-45). They do NOT import or call the real `WorkflowRunner` from `@claude-flow/workflows`.

Key evidence:
- **`workflow_execute` handler (line 252-299):** Loops through steps and immediately marks each as `completed` without executing anything:
  ```typescript
  // For now, mark as completed (real implementation would execute actual tasks)
  step.status = 'completed';
  step.completedAt = new Date().toISOString();
  step.result = { executed: true, stepType: step.type };
  ```
- **`workflow_resume` handler (line 450-489):** Same mock pattern — iterates steps and marks completed without execution.
- **`workflow_run` handler (line 103-177):** Creates stages from hardcoded template names (`feature`, `bugfix`, `refactor`, `security`) but never parses YAML or invokes the engine.
- **No imports** from `@claude-flow/workflows` anywhere in the file.

Meanwhile, `runner-bridge.ts` (97 lines) exists specifically to provide `bridgeRunWorkflow()`, `bridgeExecuteWorkflow()`, and `bridgeCancelWorkflow()` as the engine's MCP-facing API — but nothing calls it except the epic command.

### Verification Instructions

1. **Confirm no engine imports:** `grep -n "workflows" src/packages/cli/src/mcp-tools/workflow-tools.ts` — expect zero hits
2. **Confirm mock execution:** Read `workflow-tools.ts` lines 274-284 — the comment on line 281 explicitly says "real implementation would execute actual tasks"
3. **Confirm bridge exists unused:** `grep -rn "bridgeRunWorkflow\|bridgeExecuteWorkflow" src/packages/cli/` — expect hits only in epic-related files, not in workflow-tools.ts
4. **Confirm epic uses real engine:** Check `src/packages/cli/src/commands/epic/runner-adapter.ts` for the dynamic import of `runWorkflowFromContent`

### Recommended Fix

Wire the MCP tool handlers to the real engine via runner-bridge.ts. The bridge already handles AbortController tracking for cancellation. Replace the file-based store with the engine's own result/status tracking.

---

## Issue 2: Composite Step Command Does Not Execute Actions

**Severity:** MEDIUM
**Files:** `src/packages/workflows/src/commands/composite-command.ts`

### Analysis

The composite command (created from YAML step definitions) collects action specs but returns them as data without invoking tools or running shell commands. From `execute()` at line 46-69:

```typescript
async execute(config: CompositeStepConfig, context: WorkflowContext): Promise<StepOutput> {
  const results: Record<string, unknown>[] = [];
  for (let i = 0; i < def.actions.length; i++) {
    const action = def.actions[i];
    const resolvedParams = interpolateParams(action.params ?? {}, config);
    results.push({
      index: i,
      tool: action.tool,
      action: action.action,
      command: action.command,
      params: resolvedParams,
    });
  }
  return { success: true, data: { actionCount: def.actions.length, results, inputs: config } };
}
```

The `context.tools` accessor is available but never called. Actions with `command` fields are never executed via shell. The result is an array of _descriptions_ of what should happen, not actual execution results.

### Verification Instructions

1. **Read the execute method:** `composite-command.ts` lines 46-69 — confirm no `context.tools.execute()` or shell execution calls
2. **Check if any caller processes the results:** Search for consumers that receive composite step output and dispatch it — `grep -rn "composite\|CompositeStep" src/packages/workflows/`
3. **Check test expectations:** Read `tests/` for composite command tests — do they assert actual execution or just data shape?
4. **Check if this is intentional:** The YAML step loader creates composite commands — is there an outer orchestrator that was planned to dispatch these action specs?

### Recommended Fix

Implement actual execution: for `action.tool`, call `context.tools.execute(action.tool, action.action, resolvedParams)`; for `action.command`, delegate to the bash step command or use `child_process.exec`.

---

## Issue 3: Three Inconsistent Error Handling Patterns

**Severity:** MEDIUM
**Files:** All three layers

### Analysis

Each layer handles errors differently:

**Engine** (`runner.ts`, `runner.types.ts`): Returns typed `WorkflowError[]` in `WorkflowResult`:
```typescript
{ success: false, errors: [{ code: 'DEFINITION_VALIDATION_FAILED', message: '...', details: [...] }] }
```

**MCP tools** (`workflow-tools.ts`): Returns inline error strings:
```typescript
return { workflowId, error: 'Workflow not found' };
```

**CLI** (`workflow.ts`): Catches `MCPClientError` and generic errors:
```typescript
if (error instanceof MCPClientError) { ... } else { ... }
```

No shared error type flows from engine through MCP to CLI.

### Verification Instructions

1. **Catalog engine errors:** `grep -n "WorkflowError\|errors:" src/packages/workflows/src/types/runner.types.ts`
2. **Catalog MCP error returns:** `grep -n "error:" src/packages/cli/src/mcp-tools/workflow-tools.ts` — count inline error returns
3. **Catalog CLI error handling:** `grep -n "catch\|MCPClientError\|printError" src/packages/cli/src/commands/workflow.ts`
4. **Check if engine errors propagate:** If Issue 1 is fixed and MCP tools call the engine, do the `WorkflowResult.errors` get relayed to the CLI or swallowed?

### Recommended Fix

Once MCP tools call the real engine, forward `WorkflowResult` (or a serialized form) through the MCP response. Define a shared error contract for workflow operations.

---

## Issue 4: Connector Registry SOURCE_PRIORITY Default for Unknown Sources

**Severity:** MEDIUM
**Files:** `src/packages/workflows/src/registry/connector-registry.ts` (formerly `tool-registry.ts`)

### Analysis

The priority map is:
```typescript
const SOURCE_PRIORITY: Record<string, number> = { npm: 0, shipped: 1, user: 2 };
```

When comparing candidates, unknown sources fall back to `0`:
```typescript
if (existing && (SOURCE_PRIORITY[candidate.source] ?? 0) <= (SOURCE_PRIORITY[existing.source] ?? 0)) {
  continue;
}
```

If a new `ToolSource` type is added (e.g., `'plugin'`) without updating `SOURCE_PRIORITY`, it defaults to priority 0 (same as npm / lowest). This might not be the intended behavior.

### Verification Instructions

1. **Check the ToolSource type:** `grep -n "ToolSource" src/packages/workflows/src/types/workflow-tool.types.ts` — what values are in the union?
2. **Check if only 3 sources exist:** If `ToolSource = 'npm' | 'shipped' | 'user'` is a closed union, this isn't a real bug — TypeScript would catch a new value at compile time
3. **Check runtime usage:** `grep -rn "source:" src/packages/workflows/src/registry/` — are sources always from the three known values?
4. **Check if priority ever uses `<=` incorrectly:** The `<=` means equal priority keeps the first-seen (earlier candidate). Is that correct for the scan order (shipped first, then user, then npm)?

### Recommended Fix

If `ToolSource` is a closed union type, this is low-risk. If it's `string`, either close the type or add a safeguard (e.g., throw on unknown source).

---

## Issue 5: StepCommandRegistry.registerOrReplace() Silently Overrides

**Severity:** LOW
**Files:** `src/packages/workflows/src/core/step-command-registry.ts` lines 67-75

### Analysis

`registerOrReplace()` silently replaces existing commands. This is used by `loadFromDirectories()` and `loadFromNpm()`. The design intent is clear (later sources override earlier ones), but there's no logging — if a user step accidentally shadows a built-in, it's invisible.

The strict `register()` method (line 24-31) throws on duplicates, so this is a deliberate two-tier design.

### Verification Instructions

1. **Confirm intent:** Read the JSDoc on `registerOrReplace()` (line 62-66) — it explicitly documents the silent override as intentional
2. **Check call sites:** `grep -n "registerOrReplace" src/packages/workflows/` — confirm it's only used in discovery paths
3. **Check if there's a logger available:** Does the registry have access to a logger that could emit debug-level messages?
4. **Test: create a user step with type "bash"** — does it silently override the built-in? What breaks?

### Recommended Fix

Add optional debug logging when an override occurs. Not a correctness issue — just an observability gap.

---

## Issue 6: StepCommandRegistry loadFromNpm Has Wrong Priority

**Severity:** MEDIUM
**Files:** `src/packages/workflows/src/core/step-command-registry.ts` lines 98-104

### Analysis

The `loadFromNpm()` method calls `registerOrReplace()` for every discovered npm step. But `registerOrReplace()` always overwrites. This means if npm steps are loaded _after_ built-in and user steps, npm steps **override** them — the opposite of the documented priority (npm should be lowest).

The documented intent (line 93-95):
> npm steps have lowest priority — they are overridden by built-in and user steps.

But the code unconditionally calls `registerOrReplace()`, which overwrites whatever was there.

### Verification Instructions

1. **Check loading order in runner-factory.ts:** Read `src/packages/workflows/src/factory/runner-factory.ts` — what order does it call `register()`, `loadFromDirectories()`, and `loadFromNpm()`?
2. **If npm is loaded first:** Then built-in and user steps override npm (correct priority). The method comment would be misleading but the behavior correct.
3. **If npm is loaded last:** Then npm silently overrides everything (wrong priority).
4. **Compare with tool registry:** The tool registry handles this correctly with a priority map in `scan()`. The step registry has no equivalent.

### Recommended Fix

Either enforce loading order (npm first, then built-in, then user) or add priority-aware logic like the tool registry uses.

---

## Issue 7: CLI Templates vs Engine WorkflowDefinitions are Different Systems

**Severity:** MEDIUM
**Files:** `src/packages/cli/src/commands/workflow.ts`, `src/packages/workflows/src/types/workflow-definition.types.ts`

### Analysis

The CLI defines templates as simple metadata objects with stage names and agent lists (lines 12-21):
```typescript
const WORKFLOW_TEMPLATES = [
  { value: 'development', label: 'Development', hint: 'Standard development workflow' },
  ...
];
```

The engine uses `WorkflowDefinition` with typed arguments, step sequences, capability declarations, and MoFlo levels. These are completely different schemas — a CLI template cannot be fed to the engine.

The engine has its own definition loader (`loaders/definition-loader.ts`) and registry (`registry/workflow-registry.ts`) with two-tier discovery (shipped + user YAML/JSON files). The CLI doesn't use either.

### Verification Instructions

1. **Read CLI template handling:** `workflow.ts` lines 12-21 and the `run` handler — how are templates mapped to stages?
2. **Read engine definition loader:** `src/packages/workflows/src/loaders/definition-loader.ts` — does it discover YAML files that could serve as templates?
3. **Check if engine has shipped definitions:** `ls src/packages/workflows/definitions/` or similar — are there bundled workflow YAML files?
4. **Check workflow-registry.ts:** Does it provide a `list()` or `get()` method that the CLI could call instead of hardcoded templates?

### Recommended Fix

Part of Issue 1 fix — once MCP tools use the engine, templates should be engine-level WorkflowDefinitions (YAML/JSON) discovered via the definition loader, not hardcoded CLI arrays.

---

## Issue 8: Duck-Typing Validation Doesn't Check Function Signatures

**Severity:** LOW
**Files:** `src/packages/workflows/src/loaders/directory-step-loader.ts`, `src/packages/workflows/src/registry/connector-registry.ts`

### Analysis

Both registries validate plugins via duck-typing (checking property names and `typeof === 'function'`). This catches completely wrong exports but won't catch a function with the wrong parameter count or return type.

For steps (`directory-step-loader.ts`), the check verifies: `type`, `description`, `validate`, `execute`, `describeOutputs`, `configSchema` exist and have correct `typeof`.

For connectors (`connector-registry.ts`), the check verifies: `name`, `description`, `version`, `capabilities`, `initialize`, `dispose`, `execute`, `listActions`.

### Verification Instructions

1. **Read the validation functions:** Check both `isStepCommand()` in directory-step-loader.ts and `isValidConnector()` in connector-registry.ts
2. **Check if TypeScript helps:** When loading from directories, files are `import()`ed — if they're compiled `.js`, there's no type checking. If `.ts`, does the build catch mismatches?
3. **Write a test:** Create a file exporting `{ type: 'bad', description: 'x', validate: () => 'wrong return', execute: () => 'not a promise', describeOutputs: () => 42, configSchema: {} }` — does it register successfully?
4. **Assess real-world risk:** How often do third-party step authors get the interface wrong? Are there better alternatives (like a `createStepCommand()` factory function that enforces types)?

### Recommended Fix

Consider providing a `createStepCommand()` helper that enforces the interface at authoring time. Duck-typing at registration is fine as a safety net.

---

## Issue 9: No Circular Step Dependency Detection

**Severity:** LOW
**Files:** `src/packages/workflows/src/core/runner.ts`, `src/packages/workflows/src/schema/validator.ts`

### Analysis

Steps can reference other steps via condition `then`/`else` targets. If step A jumps to step B and B jumps to A, the runner would loop until the max iteration guard kicks in. The validator checks that target step IDs exist but doesn't build a jump graph to detect cycles.

### Verification Instructions

1. **Read the condition command:** `src/packages/workflows/src/commands/condition-command.ts` — how does it signal a jump? (returns `nextStep` in output?)
2. **Read the runner's step loop:** `runner.ts` — how does it handle `nextStep`? Is there a max iteration guard?
3. **Read the validator:** `src/packages/workflows/src/schema/validator.ts` — search for `nextStep` or `then` or `else` — does it build a graph?
4. **Test with circular workflow:** Create a YAML with two conditions pointing at each other — does the runner eventually terminate via the iteration guard?
5. **Assess risk:** If the iteration guard works, this is a UX issue (confusing error message) not a correctness issue.

### Recommended Fix

Add cycle detection during validation (topological sort of jump targets). Low priority if the iteration guard already prevents infinite loops.

---

## Issue 10: Plugin Registry Doesn't Topologically Sort Dependencies

**Severity:** LOW
**Files:** `src/packages/plugins/src/registry/plugin-registry.ts`

### Analysis

The broader plugin system (`@claude-flow/plugins`) supports a `dependencies` field on plugins. The registry collects plugins but may not initialize them in dependency order.

Note: This is in the **plugins** package, not the **workflows** package. It affects the general plugin system, not just workflow steps/tools.

### Verification Instructions

1. **Read plugin-registry.ts:** Check if there's initialization ordering logic
2. **Check the dependencies field:** `grep -n "dependencies\|topolog\|sort" src/packages/plugins/src/registry/plugin-registry.ts`
3. **Check if any plugins declare dependencies:** `grep -rn "dependencies:" src/packages/plugins/` — are there actual consumers?
4. **Assess scope:** If no plugins currently declare dependencies, this is a latent issue, not an active bug

### Recommended Fix

If plugins with dependencies exist or are planned, add topological sort before initialization. Otherwise, document the limitation.

---

## Previously Reported Issues Found to be Non-Issues

### Capability Scope Uses Exact Match Only — FALSE

The initial report claimed scope matching was exact-string only. After reading `capability-validator.ts` lines 178-184, scope enforcement uses **prefix matching**:

```typescript
const allowed = cap.scope.some(pattern => {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  return normalizedResource === normalizedPattern
    || normalizedResource.startsWith(normalizedPattern);
});
```

`./config/` correctly matches `./config/sub/file.txt`. This is working as intended.

---

## Work Items Summary

| # | Issue | Severity | Effort | Depends On |
|---|-------|----------|--------|------------|
| 1 | MCP tools don't use real engine | HIGH | Large | — |
| 2 | Composite command doesn't execute | MEDIUM | Medium | — |
| 3 | Inconsistent error handling | MEDIUM | Medium | #1 |
| 4 | Tool registry SOURCE_PRIORITY default | MEDIUM | Small | — |
| 5 | Silent registerOrReplace | LOW | Small | — |
| 6 | npm step loading priority order | MEDIUM | Small | — |
| 7 | CLI templates vs engine definitions | MEDIUM | Large | #1 |
| 8 | Duck-typing validation gaps | LOW | Small | — |
| 9 | No circular step dependency detection | LOW | Medium | — |
| 10 | Plugin dependency ordering | LOW | Medium | — |

### Suggested Phases

**Phase 1 — Connect the layers (Issues 1, 3, 7)**
Wire MCP tools to the real engine via runner-bridge.ts. Unify error handling. Replace CLI templates with engine WorkflowDefinitions.

**Phase 2 — Fix plugin gaps (Issues 2, 4, 6)**
Implement composite command execution. Fix priority logic in both registries.

**Phase 3 — Harden (Issues 5, 8, 9, 10)**
Add logging, cycle detection, dependency ordering, and validation helpers.
