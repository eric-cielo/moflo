## Parent Epic

Part of #223 (Workflow & Steps/Tools Plugin Architecture Review)

## Problem

Doctor has two workflow checks that both pass, giving a false sense of health:

1. **`checkWorkflowEngine`** (doctor.ts:1212) — Verifies core engine **files exist** on disk. Always passes because the engine source is well-structured.
2. **`checkWorkflowExecution`** (doctor-checks-deep.ts:201) — Runs a real minimal workflow (`echo doctor-ok`) through `runWorkflowFromContent()`. Passes because the engine itself works correctly.

**Neither check validates that the MCP tool layer actually calls the engine.**

The 10 MCP workflow tools in `src/packages/cli/src/mcp-tools/workflow-tools.ts` maintain their own file-based mock store (`.claude-flow/workflows/store.json`) and simulate step completion without invoking `WorkflowRunner`. Line 281 explicitly says:

```typescript
// For now, mark as completed (real implementation would execute actual tasks)
step.status = 'completed';
```

So doctor reports workflows as healthy, but `workflow_execute` / `workflow_run` / `workflow_resume` called via MCP don't actually execute anything.

## Expected Behavior

Doctor should have an integration check that:
1. Calls the MCP `workflow_execute` tool (or its handler directly)
2. Verifies the result includes real step output (e.g., stdout from a bash step), not just `{ executed: true }`
3. Fails if the MCP layer returns mock/simulated results

## Verification

```bash
# Confirm the mock pattern exists
grep -n "real implementation would execute" src/packages/cli/src/mcp-tools/workflow-tools.ts

# Confirm no engine imports in MCP tools
grep -c "WorkflowRunner\|runner-bridge\|runner-factory\|@claude-flow/workflows" src/packages/cli/src/mcp-tools/workflow-tools.ts
# Expected: 0

# Confirm deep check only tests engine directly, not MCP layer
grep -n "runWorkflowFromContent\|workflow_execute\|workflow_run" src/packages/cli/src/commands/doctor-checks-deep.ts
# Expected: only runWorkflowFromContent hits (direct engine), no MCP tool calls
```

## Severity

**Critical** — Users and CI rely on doctor to validate system health. A passing doctor check implies workflows work end-to-end, but MCP-invoked workflows are no-ops.

## Files

- `src/packages/cli/src/commands/doctor.ts` — checkWorkflowEngine (file existence only)
- `src/packages/cli/src/commands/doctor-checks-deep.ts` — checkWorkflowExecution (engine-direct only)
- `src/packages/cli/src/mcp-tools/workflow-tools.ts` — mock implementations that bypass engine
