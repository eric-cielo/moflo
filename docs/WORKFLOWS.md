# Workflow Engine

MoFlo includes a generalized workflow engine that lets you define multi-step automation as YAML or JSON files. Each step in a workflow is executed by a typed **step command** — a pluggable unit that knows how to run a shell command, spawn an agent, branch on a condition, loop over items, and more.

The engine is what powers `/flo` under the hood, but you can also use it directly to build your own workflows for any repeatable process: deployment pipelines, data processing, code generation, review flows, or anything else you'd otherwise script by hand.

## How It Works

A workflow is a definition file (YAML or JSON) plus a runner that executes it step by step.

```
                  ┌─────────────────────────┐
                  │   Workflow Definition    │
                  │   (YAML / JSON file)     │
                  └────────────┬────────────┘
                               │ parse + validate
                               v
                  ┌─────────────────────────┐
                  │    WorkflowRunner        │
                  │    Sequential executor   │
                  └────────────┬────────────┘
                               │ for each step
                               v
               ┌───────────────────────────────┐
               │     StepCommandRegistry       │
               │  Looks up command by type      │
               └───────┬───────┬───────┬───────┘
                       │       │       │
                 ┌─────┘  ┌────┘  ┌────┘
                 v        v       v
              [bash]  [agent] [condition] [loop] [memory] ...
              Each step command implements:
                execute()  — run the step
                validate() — check config before running
                rollback() — undo on failure (optional)
```

1. **Parse** — The runner reads your YAML/JSON file and validates it against the workflow schema.
2. **Resolve arguments** — Typed arguments (with defaults, enums, and required flags) are resolved from caller-provided values.
3. **Execute steps** — Steps run sequentially. Each step's output is available to later steps via variable interpolation. If a step fails, the runner rolls back completed steps (unless `continueOnError` is set).
4. **Return results** — The runner returns a structured result with per-step status, outputs, errors, and timing.

## Writing a Workflow

Here's a complete example — a deployment workflow that checks the branch, runs tests, and deploys:

```yaml
name: deploy
description: Build, test, and deploy to a target environment

arguments:
  environment:
    type: string
    required: true
    description: Target environment (staging or production)
    enum: [staging, production]
  skip_tests:
    type: boolean
    default: false
    description: Skip the test step (use with caution)

steps:
  - id: check-branch
    type: bash
    config:
      command: git branch --show-current

  - id: guard-production
    type: condition
    config:
      if: "{args.environment} === 'production' && {check-branch.stdout} !== 'main'"
      then: abort-wrong-branch
      else: run-tests

  - id: abort-wrong-branch
    type: bash
    config:
      command: "echo 'Production deploys must be from main branch' && exit 1"

  - id: run-tests
    type: bash
    config:
      command: npm test
      timeout: 120000
    continueOnError: false

  - id: deploy
    type: bash
    config:
      command: "./scripts/deploy.sh {args.environment}"
      timeout: 300000

  - id: notify
    type: memory
    config:
      action: write
      namespace: deployments
      key: "last-deploy-{args.environment}"
      value: "{deploy.stdout}"
```

### Definition Structure

Every workflow definition needs two things: a `name` and a list of `steps`.

**Top-level fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for this workflow |
| `description` | No | Human-readable explanation |
| `arguments` | No | Typed inputs the workflow accepts (see [Arguments](#arguments)) |
| `steps` | Yes | Ordered list of steps to execute |

**Step fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier within the workflow (used in interpolation) |
| `type` | Yes | Which step command to run (`bash`, `agent`, `condition`, etc.) |
| `config` | Yes | Type-specific configuration (see [Step Types](#step-types)) |
| `output` | No | Variable name to store this step's output under |
| `continueOnError` | No | If `true`, workflow continues even if this step fails |
| `timeout` | No | Step-specific timeout in ms (overrides the runner's 5-minute default) |
| `steps` | No | Nested step definitions (used by `loop` type only) |

### Arguments

Arguments let callers pass typed values into a workflow. Each argument has a name, type, and optional constraints:

```yaml
arguments:
  target:
    type: string          # string, number, boolean, or array
    required: true
    description: Deployment target
    enum: [dev, staging, prod]
  retries:
    type: number
    default: 3
  verbose:
    type: boolean
    default: false
```

The runner validates arguments before execution — missing required args or type mismatches produce a structured error without running any steps.

### Variable Interpolation

Steps can reference outputs from earlier steps and workflow arguments using `{reference}` syntax:

| Pattern | What it resolves to |
|---------|-------------------|
| `{args.environment}` | A workflow argument |
| `{check-branch.stdout}` | The `stdout` field from step `check-branch`'s output |
| `{run-tests.exitCode}` | The `exitCode` field from step `run-tests` |
| `{credentials.API_KEY}` | A credential value (redacted in logs) |

Interpolation happens at execution time, just before each step runs. It works recursively in all string values inside `config` — including strings nested inside objects and arrays.

```yaml
- id: greet
  type: bash
  config:
    command: "echo 'Deploying {args.environment} from branch {check-branch.stdout}'"
```

If a referenced variable doesn't exist, interpolation throws — catching typos early rather than passing broken values through.

## Step Types

The engine ships with eight built-in step commands. Each one handles a specific kind of work.

### `bash` — Run a Shell Command

Executes a command in a child process and captures stdout, stderr, and the exit code.

```yaml
- id: build
  type: bash
  config:
    command: npm run build       # The shell command to run
    timeout: 60000               # Kill after 60s (default: 30s)
    failOnError: true            # Fail the step on non-zero exit (default: true)
```

**Outputs:** `stdout`, `stderr`, `exitCode`

Set `failOnError: false` to capture the exit code without failing the workflow — useful for commands where a non-zero exit is informational rather than fatal.

### `agent` — Spawn a Claude Subagent

Delegates a task to a Claude subagent and captures its response.

```yaml
- id: research
  type: agent
  config:
    agentType: researcher        # Agent specialization
    prompt: "Find all API endpoints in the project"
    background: false            # Wait for completion (default: false)
```

**Outputs:** `result`, `agentType`, `prompt`

The `agentType` maps to your AI client's agent types — `researcher`, `coder`, `tester`, `reviewer`, etc.

### `condition` — Branch the Workflow

Evaluates an expression and jumps to a different step based on the result.

```yaml
- id: check-env
  type: condition
  config:
    if: "{args.environment} === 'production'"
    then: production-deploy      # Step ID to jump to if true
    else: staging-deploy         # Step ID to jump to if false
```

**Outputs:** `result` (boolean), `branch` ("then" or "else"), `nextStep` (target step ID)

**How branching works:** When a condition step executes, the runner doesn't just continue to the next step — it jumps to the step ID specified in `then` or `else`. This means steps between the condition and its target are skipped. Jumps can go forward or backward in the step list.

**Infinite loop protection:** A max-iteration guard (`total steps x 10`) prevents condition chains that loop forever. If the guard trips, the workflow terminates with an error.

The `if` expression supports JavaScript-style comparisons. The condition command evaluates the interpolated expression and returns `true` or `false`.

### `loop` — Iterate Over Items

Runs a set of nested steps once per item in an array.

```yaml
- id: process-files
  type: loop
  config:
    over: "{args.files}"         # Array to iterate over
    itemVar: file                # Variable name for current item (default: "item")
    indexVar: idx                # Variable name for current index (default: "index")
    maxIterations: 50            # Safety cap (default: 100)
  steps:
    - id: process-one
      type: bash
      config:
        command: "process.sh {file}"
    - id: log-progress
      type: bash
      config:
        command: "echo 'Done with item {idx}: {file}'"
```

**Outputs:** `totalItems`, `iterations`, `truncated`, `items`

Nested steps are defined on the step itself (the `steps` field), not inside `config`. For each iteration, the runner injects `itemVar` and `indexVar` into the variable context, runs all nested steps, then moves to the next item. If those variable names already exist in the workflow context, the runner saves their values before the loop and restores them after.

### `memory` — Read, Write, or Search Shared State

Interacts with MoFlo's memory database during workflow execution.

```yaml
# Write
- id: save-result
  type: memory
  config:
    action: write
    namespace: my-workflow
    key: last-run
    value: "{build.stdout}"

# Read
- id: load-prev
  type: memory
  config:
    action: read
    namespace: my-workflow
    key: last-run

# Search
- id: find-related
  type: memory
  config:
    action: search
    namespace: patterns
    query: "deployment failures"
```

**Outputs:** `value`, `found` (for read), `written` (for write), `results`, `count` (for search)

### `prompt` — Ask for User Input

Pauses the workflow to ask the user a question.

```yaml
- id: confirm
  type: prompt
  config:
    message: "Deploy to {args.environment}? This cannot be undone."
    options: [yes, no]           # Multiple choice (optional)
    default: "no"                # Default if no input (optional)
```

**Outputs:** `response`, `message`

### `wait` — Pause Execution

Delays the workflow for a specified duration. Useful for rate limiting, cooldowns, or waiting for external processes.

```yaml
- id: cooldown
  type: wait
  config:
    duration: 5000               # Milliseconds to wait
```

**Outputs:** `waited` (actual elapsed time in ms)

### `browser` — Web Automation

Drives a browser via Playwright for scraping, testing, or interaction.

```yaml
- id: screenshot
  type: browser
  config:
    action: navigate
    url: "https://example.com"

- id: login
  type: browser
  config:
    action: fill
    selector: "#username"
    value: "{credentials.USERNAME}"
```

**Outputs:** `html`, `screenshot` (base64), `text`

Requires `playwright` as a peer dependency — the step checks for it at runtime and returns a clear error if it's not installed.

## Error Handling

The runner never throws. It always returns a structured `WorkflowResult` with a `success` flag, per-step results, and an `errors` array.

### What happens when a step fails

By default, a step failure triggers this sequence:

1. The failed step is recorded with status `failed`
2. The runner attempts to **rollback** all previously completed steps (calling each command's `rollback()` method in reverse order)
3. Remaining steps are marked as `skipped`
4. The workflow result has `success: false`

### `continueOnError`

Set `continueOnError: true` on a step to skip the rollback-and-abort behavior for that step. The failure is still recorded, but execution continues with the next step.

```yaml
- id: optional-lint
  type: bash
  config:
    command: npm run lint
  continueOnError: true          # Lint failures don't block the workflow

- id: required-tests
  type: bash
  config:
    command: npm test
  # continueOnError defaults to false — test failure stops everything
```

### Error codes

Each error in the result carries a code that tells you what went wrong:

| Code | Meaning |
|------|---------|
| `DEFINITION_VALIDATION_FAILED` | The YAML/JSON is malformed or violates the schema |
| `ARGUMENT_VALIDATION_FAILED` | A required argument is missing or has the wrong type |
| `UNKNOWN_STEP_TYPE` | A step uses a type that isn't registered |
| `STEP_VALIDATION_FAILED` | A step's config doesn't match its command's schema |
| `STEP_EXECUTION_FAILED` | A step threw an error during execution |
| `STEP_TIMEOUT` | A step exceeded its timeout |
| `STEP_CANCELLED` | The workflow was cancelled while this step was running |
| `CONDITION_TARGET_NOT_FOUND` | A condition's `then`/`else` references a step ID that doesn't exist |
| `ROLLBACK_FAILED` | Rollback of a completed step failed |
| `WORKFLOW_CANCELLED` | The entire workflow was cancelled via AbortSignal |

## Dry Run

Dry-run mode validates everything without executing anything. It checks:

- Definition schema validity
- Argument resolution (types, required flags, enums)
- Step config validation against each command's schema
- That all referenced step types are registered

```yaml
# Run via MCP with dryRun: true, or programmatically:
```

```typescript
import { runWorkflowFromContent } from '@claude-flow/workflows';

const result = await runWorkflowFromContent(yamlContent, 'deploy.yaml', {
  dryRun: true,
  args: { environment: 'staging' },
});

if (!result.success) {
  console.error(result.errors);
}
```

Use dry run to catch definition errors before committing to execution — especially useful when building or modifying workflows.

## Pause and Resume

Long-running workflows can be paused mid-execution and resumed later — even in a different conversation or session. The engine serializes the workflow's state (completed step results, variable context, position) to memory, then reconstructs it on resume.

### How it works

1. **Pause** — The engine snapshots the current state: which steps completed, what their outputs were, the current variable context, and which step comes next. This snapshot is serialized to MoFlo's memory database.

2. **Wait** — The paused state sits in memory with a configurable stale timeout (default: 24 hours). After that, it's considered expired and will be cleaned up.

3. **Resume** — The engine loads the snapshot from memory, reconstructs the workflow definition, merges any variable overrides the caller provides, and creates a new runner that picks up from the next unexecuted step. Completed step results from before the pause are prepended to the final result, so the caller sees the full execution history.

### Variable overrides on resume

When resuming, you can inject or modify variables — useful when a human needs to review intermediate results and provide input before the workflow continues:

```typescript
const result = await resumeWorkflow('wf-12345', {
  memory,
  variables: { approved: true, reviewer: 'alice' },
});
```

The override merges with the paused variable context (overrides win on conflict), and the resumed steps see the combined result.

## Definition Layering

Workflow definitions use a two-tier system, following the same pattern as MoFlo's guidance files:

| Tier | Source | Priority |
|------|--------|----------|
| **Shipped** | Bundled with MoFlo (built-in workflows) | Lower |
| **User** | Your project's workflow directory | Higher |

If you create a workflow with the same `name` as a shipped one, your version wins. New names are additive — they extend the available set without replacing anything.

The loader checks for `.yaml`, `.yml`, and `.json` files. Invalid files produce warnings but don't block loading of valid ones.

### Where to put your workflows

By default, user workflows live in `.claude/workflows/` or a path you configure in `moflo.yaml`. Create a YAML file there and it's automatically available:

```
.claude/workflows/
  deploy.yaml          # Your custom deploy workflow
  data-pipeline.yaml   # Your data processing workflow
```

## Using the MCP Tools

Your AI client interacts with the workflow engine through MCP tools:

| Tool | What it does |
|------|-------------|
| `mcp__moflo__workflow_run` | Run a workflow from YAML/JSON content |
| `mcp__moflo__workflow_execute` | Execute a workflow definition object directly |
| `mcp__moflo__workflow_cancel` | Cancel a running workflow by ID |
| `mcp__moflo__workflow_status` | Check if a workflow is running |
| `mcp__moflo__workflow_pause` | Pause a running workflow |
| `mcp__moflo__workflow_resume` | Resume a paused workflow |

Each running workflow gets a unique ID (e.g., `wf-1711644123456`) that you can use to check status, cancel, or resume.

## Programmatic Usage

You can also use the workflow engine directly from TypeScript:

```typescript
import { createRunner, runWorkflowFromContent } from '@claude-flow/workflows';

// Option 1: Run from YAML content (parse + validate + execute in one call)
const result = await runWorkflowFromContent(yamlString, 'my-workflow.yaml', {
  args: { environment: 'staging' },
});

// Option 2: Create a runner and execute a definition object
const runner = createRunner({ memory: myMemoryAccessor });
const result = await runner.run(definition, args, {
  workflowId: 'my-custom-id',
  signal: abortController.signal,        // For cancellation
  onStepComplete: (step, i, total) => {   // Progress callback
    console.log(`Step ${i + 1}/${total}: ${step.stepId} — ${step.status}`);
  },
});

console.log(result.success);     // true or false
console.log(result.steps);       // Per-step results
console.log(result.errors);      // Structured errors (if any)
console.log(result.duration);    // Total execution time in ms
```

`createRunner()` registers all eight built-in step commands automatically. The runner accepts optional `memory` and `credentials` accessors — if you don't provide them, it uses no-op defaults (memory reads return null, credential lookups return undefined).

## Further Reading

- [Workflow Sandboxing](WORKFLOW-SANDBOXING.md) — Capability-based security for workflow steps
