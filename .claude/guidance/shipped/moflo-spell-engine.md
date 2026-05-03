# Spell Engine — Running, Creating, and Customizing Spells

**Purpose:** How to run spells via MCP tools, create new spell definitions, register custom step commands, and understand the shipped vs user override layering system. Reference when a user asks to run, create, or modify spells.

---

## Claude's Role During Spell Execution

**Claude MUST treat the spell definition as a strict contract — execute only what it specifies, using only the capabilities it declares.** This applies equally whether the spell is run manually, via MCP, or on a schedule by the daemon.

| Constraint | Detail |
|-----------|--------|
| Step config is the complete instruction | Do not add commands, flags, arguments, or actions beyond what `config` contains |
| Capability restrictions are absolute | If a step restricts `fs:read` to `["./src/"]`, do not read files outside `./src/` even if helpful |
| `CAPABILITY_DENIED` means stop | Do not attempt workarounds — report the denial and halt the step |
| No improvisation between steps | Do not perform actions outside of step boundaries, even if "obvious" (e.g., do not auto-fix a failing step's output before passing it to the next step unless the spell defines a step for that) |

See `.claude/guidance/shipped/moflo-spell-sandboxing.md` for the full Execution Constraint Principle and capability type reference.

---

## Running a Spell via MCP Tools

**Use `mcp__moflo__spell_cast` to execute a spell from a YAML/JSON file.** The bridge layer handles parsing, validation, and runner lifecycle automatically.

| MCP Tool | Purpose |
|----------|---------|
| `mcp__moflo__spell_cast` | Run spell from file content (YAML/JSON) |
| `mcp__moflo__spell_execute` | Execute a spell definition object directly |
| `mcp__moflo__spell_cancel` | Cancel a running spell by ID |
| `mcp__moflo__spell_status` | Check if a spell is currently running |
| `mcp__moflo__spell_suspend` | Pause a running spell for later resumption |
| `mcp__moflo__spell_resume` | Resume a previously paused spell |

**Dry-run mode validates without executing.** Pass `dryRun: true` to check definition validity, argument resolution, and step config schemas before committing to execution.

---

## Spell Definition Format

**Spells are YAML or JSON files.** YAML is preferred for readability. Every definition must have `name` and `steps`.

```yaml
name: deploy-staging
arguments:
  environment:
    type: string
    required: true
    description: Target environment
  dry_run:
    type: boolean
    default: false
steps:
  - id: check-branch
    type: bash
    config:
      command: "git branch --show-current"
  - id: run-tests
    type: bash
    config:
      command: "npm test"
      failOnError: true
  - id: deploy
    type: bash
    config:
      command: "deploy.sh {args.environment}"
    continueOnError: false
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique spell identifier |
| `steps` | array | Ordered list of step definitions |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `arguments` | object | Typed arguments with `type`, `required`, `default`, `enum`, `description` |
| `description` | string | Human-readable spell description |

### Step Definition Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique step identifier (used in variable interpolation) |
| `type` | string | Yes | Step command type (see Step Command Types below) |
| `config` | object | Yes | Type-specific configuration |
| `output` | string | No | Variable name to store step output |
| `continueOnError` | boolean | No | Continue spell if this step fails (default: false) |
| `timeout` | number | No | Step timeout in ms (overrides runner default of 300s) |

---

## Variable Interpolation

**Use `{reference}` syntax to reference previous step outputs and arguments.** Variables are resolved at execution time, not parse time.

| Pattern | Resolves To |
|---------|-------------|
| `{args.environment}` | Spell argument value |
| `{check-branch.stdout}` | Output field from step `check-branch` |
| `{credentials.API_KEY}` | Credential value (redacted in logs) |

Interpolation works in all string values within step `config`. Nested object values and arrays are interpolated recursively.

```yaml
steps:
  - id: fetch-url
    type: bash
    config:
      command: "curl -s {args.api_url}"
  - id: process
    type: agent
    config:
      prompt: "Analyze this response: {fetch-url.stdout}"
```

---

## Step Command Types

**Nine built-in step types are registered automatically.** Each implements `execute()`, `validate()`, `describeOutputs()`, and optional `rollback()`. Additional step types can be added via pluggable step discovery — see `moflo-spell-custom-steps.md` for the JS/TS, YAML, and npm-package extension paths.

### bash — Run a Shell Command

```yaml
- id: build
  type: bash
  config:
    command: "npm run build"    # Required. Shell command to execute.
    timeout: 30000              # Optional. Timeout in ms (default: 30000).
    failOnError: true           # Optional. Fail step on non-zero exit (default: true).
```

**Outputs:** `stdout` (string), `stderr` (string), `exitCode` (number).

---

### agent — Spawn a Claude Subagent

```yaml
- id: research
  type: agent
  config:
    agentType: "researcher"     # Required. Agent type (researcher, coder, tester, etc.).
    prompt: "Find all API endpoints in {args.directory}"  # Required. Task prompt.
    background: false           # Optional. Run in background (default: false).
```

**Outputs:** `result` (string), `agentType` (string), `prompt` (string).

---

### condition — Branch Spell Execution

```yaml
- id: check-env
  type: condition
  config:
    if: "{args.environment} === 'production'"  # Required. Expression to evaluate.
    then: "deploy-prod"                        # Optional. Step ID to jump to if true.
    else: "deploy-staging"                     # Optional. Step ID to jump to if false.
```

**Outputs:** `result` (boolean), `branch` (string: "then" or "else"), `nextStep` (string).

The runner uses `nextStep` to jump to the target step ID. Jumps can go forward or backward. A max-iteration guard (`steps.length * 10`) prevents infinite loops.

---

### loop — Iterate Over an Array

```yaml
- id: process-files
  type: loop
  config:
    over: ["{args.files}"]        # Required. Array to iterate (or variable reference).
    maxIterations: 100            # Optional. Safety limit (default: 100).
    itemVar: "file"               # Optional. Current item variable name (default: "item").
    indexVar: "idx"               # Optional. Current index variable name (default: "index").
  steps:                          # Nested steps run for each item.
    - id: process-one
      type: bash
      config:
        command: "process.sh {file}"
```

**Outputs:** `totalItems` (number), `iterations` (number), `truncated` (boolean), `items` (array).

Nested `steps` are defined on the step definition (not inside `config`). The runner executes all nested steps per iteration, injecting `itemVar` and `indexVar` into the variable context. Previous values are saved and restored after the loop completes.

---

### memory — Read, Write, or Search Shared State

```yaml
- id: load-config
  type: memory
  config:
    action: "read"              # Required. One of: read, write, search.
    namespace: "workflow-state"  # Required. Memory namespace.
    key: "last-deploy"          # Required for read/write. Memory key.
    value: "{deploy.stdout}"    # Required for write. Value to store.
    query: "deploy status"      # Required for search. Semantic query.
```

**Outputs:** `value` (object), `found` (boolean), `written` (boolean), `results` (array), `count` (number).

---

### prompt — Ask User for Input

```yaml
- id: confirm
  type: prompt
  config:
    message: "Deploy to {args.environment}?"  # Required. Question text.
    options: ["yes", "no"]                    # Optional. Multiple choice options.
    default: "no"                              # Optional. Default if no input.
    outputVar: "user_choice"                   # Optional. Variable to store response.
```

**Outputs:** `response` (string), `message` (string), `outputVar` (string).

---

### wait — Pause Execution

```yaml
- id: cooldown
  type: wait
  config:
    duration: 5000  # Required. Wait duration in milliseconds.
```

**Outputs:** `waited` (number — actual wait time in ms).

---

### browser — Web Automation (Requires Playwright)

```yaml
- id: screenshot
  type: browser
  config:
    action: "navigate"          # Required. navigate, click, fill, screenshot, etc.
    url: "https://example.com"  # Required for navigate.
    selector: "#login"          # Required for click/fill.
    value: "username"           # Required for fill.
```

**Outputs:** `html` (string), `screenshot` (string — base64), `text` (string).

Requires `playwright` as a peer dependency. The command checks for Playwright availability at execution time and returns a clear error if missing.

---

### github — GitHub CLI Operations

```yaml
- id: create-issue
  type: github
  config:
    action: "create-issue"      # Required. create-issue, create-pr, add-label, comment, etc.
    title: "Bug: {args.title}"  # Required for create-issue/create-pr.
    body: "Details here"        # Optional. Issue/PR body.
    repo: "owner/repo"          # Optional. Defaults to current repo.
```

**Outputs:** `url` (string), `number` (number), `action` (string).

Supports 8 actions: `create-issue`, `create-pr`, `add-label`, `remove-label`, `comment`, `close-issue`, `close-pr`, `merge-pr`. Requires `gh` CLI installed and authenticated.

---

## Custom Step Commands

**To register custom step types, see `moflo-spell-custom-steps.md`.** That doc covers the three extension paths (JS/TS step files, YAML composite steps, `moflo-step-*` npm packages), priority ordering, and how to configure `createRunner()` for discovery.

---

## Shipped vs User Definition Layering

**Shipped definitions are bundled defaults. User definitions override shipped ones by name match.**

| Tier | Source | Priority |
|------|--------|----------|
| Shipped | Bundled in moflo package source (`workflows/shipped/`) | Lower |
| User | Project-local path (configurable via `moflo.yaml`) | Higher — overrides shipped by name |

### How Layering Works

1. `loadSpellDefinitions()` loads shipped definitions first
2. Then loads user definitions from configured directories
3. If a user definition has the same `name` as a shipped one, the user version wins
4. New names in user directories are additive (they extend, not replace, the set)

### Loading Definitions Programmatically

```typescript
import { loadSpellDefinitions, loadSpellByName } from 'moflo/dist/src/cli/spells/index.js';

const { spells, errors } = loadSpellDefinitions({
  shippedDir: 'node_modules/moflo/workflows/shipped',
  userDirs: ['.claude/workflows', 'workflows/'],
});
const result = loadSpellByName('deploy-staging', { /* same options */ });
```

---

## Error Handling and Rollback

**The runner collects errors without throwing.** `SpellResult` always returns — check `result.success` and `result.errors`.

| Error Code | Meaning |
|------------|---------|
| `DEFINITION_VALIDATION_FAILED` | Invalid YAML/JSON or schema violation |
| `ARGUMENT_VALIDATION_FAILED` | Missing required argument or type mismatch |
| `UNKNOWN_STEP_TYPE` | No step command registered for this type |
| `STEP_VALIDATION_FAILED` | Step config fails command's schema validation |
| `STEP_EXECUTION_FAILED` | Step threw during execution |
| `STEP_TIMEOUT` | Step exceeded its timeout |
| `STEP_CANCELLED` | Spell cancelled via AbortSignal |
| `CONDITION_TARGET_NOT_FOUND` | Condition branch references nonexistent step ID |
| `PAUSED_STATE_NOT_FOUND` | No paused state for spell ID on resume |
| `PAUSED_STATE_EXPIRED` | Paused state exceeded stale timeout |
| `ROLLBACK_FAILED` | Rollback of completed steps failed |
| `SPELL_CANCELLED` | Entire spell was cancelled |

### continueOnError

**Set `continueOnError: true` on a step to keep running after failure.** The failed step is recorded in results but execution continues. Without this flag, a step failure triggers rollback of completed steps and terminates the spell.

---

## Pause and Resume

**Pause serializes spell state to memory. Resume reconstructs and continues from where it left off.**

```typescript
import { buildPausedState, persistPausedState, resumeSpell } from 'moflo/dist/src/cli/spells/index.js';

// Pause after step 2 of 5
const state = buildPausedState(spellId, definition, 2, variables, completedResults, args);
await persistPausedState(state, memory);

// Later: resume from step 3
const result = await resumeSpell(spellId, { memory, variables: { override: 'value' } });
```

**Stale timeout is 24 hours by default.** Paused state older than this is rejected on resume and cleaned up. Use `cleanupStalePaused(memory)` to sweep expired entries.

**Variable overrides on resume** allow injecting or modifying context between pause and resume (e.g., user edits a value in between).

---

## Creating New Spell Definitions

**To create a spell for a user, write a `.yaml` file in their project's spell directory** (typically `.claude/workflows/` or a path configured in `moflo.yaml`).

1. Start with `name` and `steps`
2. Add `arguments` for any user-provided values
3. Use `{args.argName}` and `{stepId.outputKey}` for interpolation
4. Set `continueOnError: true` on non-critical steps
5. Add `timeout` on steps that may hang (network calls, long builds)

### Validation Checklist

| Check | How |
|-------|-----|
| All step IDs are unique | Validator enforces this |
| All step types are registered | Dry-run catches unknown types |
| Condition `then`/`else` reference valid step IDs | Runner checks at branch time |
| Loop `over` resolves to an array | Loop command validates at execution |
| No circular condition jumps | Max-iteration guard catches these |

---

## Dry-Run Validation

**Always dry-run before executing a new or modified spell.** Dry-run validates the definition, resolves arguments, and checks step configs without executing anything.

```typescript
import { runSpellFromContent } from 'moflo/dist/src/cli/spells/index.js';

const result = await runSpellFromContent(yamlContent, 'my-spell.yaml', { dryRun: true });
if (!result.success) {
  console.error('Validation errors:', result.errors);
}
```

Via MCP: pass `dryRun: true` to `mcp__moflo__spell_cast`.

---

## Credential Handling

**Credentials are accessed via `{credentials.KEY}` in interpolation.** The credential accessor is injected into the runner at creation time — spells never store credentials directly.

Credential values listed in `RunnerOptions.credentialValues` are automatically redacted from step output to prevent accidental exposure in logs or results.

---

## See Also

- `.claude/guidance/shipped/moflo-spell-custom-steps.md` — Pluggable step commands: JS/TS, YAML, and `moflo-step-*` npm packages
- `.claude/guidance/shipped/moflo-spell-connectors.md` — Connectors: resource adapters, registry, step-vs-connector decision
- `.claude/guidance/shipped/moflo-spell-sandboxing.md` — Capability-based security for steps
- `.claude/guidance/shipped/moflo-spell-engine-architecture.md` — Architecture decisions for Epic #100
- `.claude/guidance/shipped/moflo-core-guidance.md` — CLI, hooks, swarm, memory reference
- `.claude/guidance/shipped/moflo-subagents.md` — Subagents protocol
