# Spell Engine — Definition Format & Step Types

**Purpose:** How to define a spell (YAML/JSON schema, arguments, steps, variable interpolation) and a reference for the nine built-in step command types. For execution mechanics (running, dry-run, error codes, pause/resume, layering, credentials), see `.claude/guidance/moflo-spell-runner.md`.

---

## Claude's Role During Spell Execution

**Treat the spell definition as a strict contract — execute only what it specifies, using only the capabilities it declares.** This applies whether the spell runs manually, via MCP, or on a schedule.

| Constraint | Detail |
|-----------|--------|
| Step config is the complete instruction | Do not add commands, flags, arguments, or actions beyond what `config` contains |
| Capability restrictions are absolute | If a step restricts `fs:read` to `["./src/"]`, do not read files outside `./src/` even if helpful |
| `CAPABILITY_DENIED` means stop | Do not attempt workarounds — report the denial and halt the step |
| No improvisation between steps | Do not perform actions outside step boundaries, even if "obvious" |

See `.claude/guidance/moflo-spell-sandboxing.md` for the full Execution Constraint Principle and capability type reference.

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
| `{credentials.API_KEY}` | Credential value (redacted in logs — see `moflo-spell-runner.md`) |

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

**Nine built-in step types are registered automatically.** Each implements `execute()`, `validate()`, `describeOutputs()`, and optional `rollback()`. To add new step types via JS/TS files, YAML composite steps, or `moflo-step-*` npm packages, see `.claude/guidance/moflo-spell-custom-steps.md`.

### bash — Run a Shell Command

```yaml
- id: build
  type: bash
  config:
    command: "npm run build"    # Required.
    timeout: 30000              # Optional. Default 30000.
    failOnError: true           # Optional. Fail step on non-zero exit (default: true).
```

**Outputs:** `stdout` (string), `stderr` (string), `exitCode` (number).

---

### agent — Spawn a Claude Subagent

```yaml
- id: research
  type: agent
  config:
    agentType: "researcher"     # Required. researcher, coder, tester, etc.
    prompt: "Find all API endpoints in {args.directory}"  # Required.
    background: false           # Optional. Default false.
```

**Outputs:** `result` (string), `agentType` (string), `prompt` (string).

---

### condition — Branch Spell Execution

```yaml
- id: check-env
  type: condition
  config:
    if: "{args.environment} === 'production'"  # Required.
    then: "deploy-prod"                        # Optional. Step ID to jump to if true.
    else: "deploy-staging"                     # Optional. Step ID to jump to if false.
```

**Outputs:** `result` (boolean), `branch` (string: "then" or "else"), `nextStep` (string).

The runner uses `nextStep` to jump to the target step ID. Jumps may go forward or backward. A max-iteration guard (`steps.length * 10`) prevents infinite loops.

---

### loop — Iterate Over an Array

```yaml
- id: process-files
  type: loop
  config:
    over: ["{args.files}"]        # Required. Array or variable reference.
    maxIterations: 100            # Optional. Default 100.
    itemVar: "file"               # Optional. Default "item".
    indexVar: "idx"               # Optional. Default "index".
  steps:                          # Nested steps run for each item.
    - id: process-one
      type: bash
      config:
        command: "process.sh {file}"
```

**Outputs:** `totalItems` (number), `iterations` (number), `truncated` (boolean), `items` (array).

Nested `steps` go on the step definition (not inside `config`). The runner injects `itemVar` and `indexVar` per iteration; previous values are saved and restored after the loop.

---

### memory — Read, Write, or Search Shared State

```yaml
- id: load-config
  type: memory
  config:
    action: "read"              # Required. read | write | search.
    namespace: "workflow-state"  # Required.
    key: "last-deploy"          # Required for read/write.
    value: "{deploy.stdout}"    # Required for write.
    query: "deploy status"      # Required for search.
```

**Outputs:** `value` (object), `found` (boolean), `written` (boolean), `results` (array), `count` (number).

---

### prompt — Ask User for Input

```yaml
- id: confirm
  type: prompt
  config:
    message: "Deploy to {args.environment}?"  # Required.
    options: ["yes", "no"]                    # Optional. Multiple choice.
    default: "no"                              # Optional.
    outputVar: "user_choice"                   # Optional.
```

**Outputs:** `response` (string), `message` (string), `outputVar` (string).

---

### wait — Pause Execution

```yaml
- id: cooldown
  type: wait
  config:
    duration: 5000  # Required. Milliseconds.
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
    action: "create-issue"      # Required.
    title: "Bug: {args.title}"  # Required for create-issue/create-pr.
    body: "Details here"        # Optional.
    repo: "owner/repo"          # Optional. Defaults to current repo.
```

**Outputs:** `url` (string), `number` (number), `action` (string).

Supported actions: `create-issue`, `create-pr`, `add-label`, `remove-label`, `comment`, `close-issue`, `close-pr`, `merge-pr`. Requires `gh` CLI installed and authenticated.

---

## Creating New Spell Definitions

To create a spell, write a `.yaml` file in the project's spell directory (typically `.claude/workflows/`, or the path configured in `moflo.yaml`).

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

**Always dry-run before executing a new or modified spell** (see `.claude/guidance/moflo-spell-runner.md` § Dry-Run Validation).

---

## See Also

- `.claude/guidance/moflo-spell-runner.md` — Running spells, MCP tools, dry-run, error codes, pause/resume, credentials, definition layering
- `.claude/guidance/moflo-spell-sandboxing.md` — Capability-based security for steps; required reading before authoring
- `.claude/guidance/moflo-spell-custom-steps.md` — Pluggable step commands: JS/TS files, YAML composites, `moflo-step-*` packages
- `.claude/guidance/moflo-spell-connectors.md` — Connectors: resource adapters, registry, step-vs-connector decision
- `.claude/guidance/moflo-spell-troubleshooting.md` — Common failure modes (sandbox/network, permission gaps, environment)
- `.claude/guidance/moflo-core-guidance.md` — CLI, hooks, swarm, memory reference
