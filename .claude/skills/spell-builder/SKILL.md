---
name: "Spell Builder"
description: "Create, edit, and validate spell definitions (YAML/JSON) that compose connectors and step commands into end-to-end spells. Use when building new spell definitions, modifying existing ones, or exploring available spell components."
---

# Spell Builder

Create production-ready spell definitions (YAML/JSON) that compose step commands and connectors into end-to-end automated spells, with proper data flow, validation, and engine integration.

## Prerequisites

- MoFlo project with `@moflo/workflows` package
- Familiarity with YAML syntax

## What This Skill Does

1. Guides you through building a **spell definition** (YAML/JSON)
2. Discovers available **step commands** and **connectors** to compose
3. Wires up **data flow** between steps via variable references
4. Validates the generated definition against the engine schema
5. Outputs the spell file to the correct project directory

---

## Quick Start

Ask the user:

> **What would you like to do?**
> 1. **Create** a new spell definition from scratch
> 2. **Edit** an existing spell definition
> 3. **Discover** available step commands and connectors
> 4. **Validate** an existing spell file

Then follow the appropriate section below.

---

## Section 1: Create a New Spell

### Step 1: Gather Spell Metadata

Ask the user for:

| Field | Required | Example |
|-------|----------|---------|
| **Name** | Yes (kebab-case) | `deploy-staging`, `security-audit` |
| **Description** | Recommended | `Deploy to staging with smoke tests` |
| **Version** | Optional (default `1.0`) | `1.0` |
| **Abbreviation** | Optional | `ds` (short lookup key for `/flo -wf ds`) |
| **MoFlo Level** | Optional (default `none`) | `none`, `memory`, `hooks`, `full`, `recursive` |

### Step 2: Define Arguments (Optional)

If the spell needs runtime parameters, define arguments:

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Argument identifier (e.g., `target`, `severity`) |
| **Type** | Yes | `string`, `number`, `boolean`, or `string[]` |
| **Required** | Optional (default `false`) | Whether the argument must be provided |
| **Default** | Optional | Default value if not provided |
| **Enum** | Optional | Allowed values (e.g., `[low, medium, high]`) |
| **Description** | Optional | Help text for the argument |

Arguments are referenced in step configs via `{args.argumentName}`.

### Step 3: Define Steps

Walk the user through adding steps one at a time. For each step, collect:

| Field | Required | Description |
|-------|----------|-------------|
| **ID** | Yes (unique) | Step identifier (kebab-case, e.g., `run-tests`) |
| **Type** | Yes | One of the available step command types (see Discovery section) |
| **Config** | Yes | Type-specific configuration (see per-type docs below) |
| **Output** | Optional | Variable name to store step output (for downstream steps) |
| **Continue on Error** | Optional | `true` to proceed even if this step fails |
| **MoFlo Level** | Optional | Override workflow-level mofloLevel (can only narrow, not escalate) |

**Data flow between steps:** Use `{stepId.outputKey}` syntax to reference output from a previous step. For example, if step `fetch-data` outputs a `url` field, a later step can use `{fetch-data.url}` in its config.

**Special variable references:**
- `{args.name}` — references a workflow argument
- `{credentials.NAME}` — references a credential (resolved at runtime)
- `{stepId.outputKey}` — references output from a previous step

### Step 4: Generate the Spell YAML

Assemble the definition into YAML format following this structure:

```yaml
name: <workflow-name>
abbreviation: <optional-abbreviation>
description: <optional-description>
version: "<version>"
mofloLevel: <optional-level>

arguments:
  <arg-name>:
    type: <string|number|boolean|string[]>
    required: <true|false>
    default: <optional-default>
    enum: [<optional-values>]
    description: <optional-help-text>

steps:
  - id: <unique-step-id>
    type: <step-command-type>
    config:
      <type-specific-config-fields>
    output: <optional-variable-name>
    continueOnError: <optional-true>
    mofloLevel: <optional-level>
```

### Step 5: Validate the Spell

Before writing the file, validate it against the engine schema. The following rules must pass:

1. **`name`** is required and must be a non-empty string
2. **`steps`** is required and must be a non-empty array
3. Each step must have a unique **`id`** (no duplicates)
4. Each step must have a valid **`type`** matching a known step command
5. **Variable references** (`{stepId.outputKey}`) must not be forward references (the referenced step must appear before the current step)
6. **Argument references** (`{args.name}`) must match declared arguments
7. **`mofloLevel`** must be one of: `none`, `memory`, `hooks`, `full`, `recursive`
8. Step-level `mofloLevel` cannot exceed the spell-level `mofloLevel`
9. No **circular condition jumps** (condition steps referencing each other in a loop)
10. **Argument definitions** must have valid types, and defaults must match their declared type

If validation fails, show the specific errors and guide the user to fix them.

### Step 6: Write the File

Ask the user where to save the spell:

- **Project spells:** `workflows/<name>.yaml` (user-level, project-specific)
- **Claude spells:** `.claude/workflows/<name>.yaml` (Claude Code integration)

Use the MCP tool to create the spell if available:
```
mcp__moflo__spell_create — name, definition (YAML string), description
```

Or write the file directly to the chosen directory.

---

## Section 2: Edit an Existing Spell

### Step 1: Load the Spell

Ask for the spell file path, or use `mcp__moflo__spell_list` to browse available spells.

Read the YAML/JSON file and parse the current definition.

### Step 2: Present Current Structure

Show a summary of the spell:
- Name, description, version, abbreviation
- Arguments (if any)
- Steps list with: id, type, output variable, continueOnError

### Step 3: Apply Changes

Support these edit operations:

| Operation | Description |
|-----------|-------------|
| **Add step** | Insert a new step at a given position |
| **Remove step** | Delete a step by id (warn about broken references) |
| **Reorder steps** | Move a step to a new position (warn about broken forward refs) |
| **Update step config** | Modify a step's configuration fields |
| **Update step type** | Change a step's command type (reset config to match) |
| **Add/remove arguments** | Modify workflow argument definitions |
| **Update metadata** | Change name, description, version, abbreviation, mofloLevel |

After each change, re-validate the definition and show any errors introduced.

### Step 4: Save

Write the updated YAML back to the original file (or a new path if requested).

---

## Section 3: Discover Available Spell Components

### Built-in Step Commands

These step command types are available for use in workflow `steps[].type`:

| Type | Description | Key Config Fields |
|------|-------------|-------------------|
| `agent` | Execute a prompt via an AI agent | `prompt`, `model`, `systemPrompt` |
| `bash` | Run a shell command | `command`, `cwd`, `timeout` |
| `condition` | Conditional branching based on expressions | `expression`, `then`, `else`, nested `steps` |
| `prompt` | Display a prompt and collect user input | `message`, `variable`, `type` |
| `memory` | Read/write/search MoFlo memory | `operation` (read/write/search), `namespace`, `key`, `value`, `query` |
| `wait` | Pause execution for a duration | `duration` (ms), `until` (expression) |
| `loop` | Iterate over items or repeat N times | `items`/`times`, nested `steps` |
| `browser` | Browser automation via Playwright | `action`, `url`, `selector`, `value` |
| `github` | GitHub CLI operations | `action` (create-issue, create-pr, etc.), `repo`, params |

**Source:** `src/modules/spells/src/commands/index.ts`

### Built-in Connectors (Generalized I/O Wrappers)

Connectors are generalized I/O wrappers — not per-service adapters. Three ship with moflo, covering HTTP APIs, CLI tools, and browser automation. Service-specific integrations (Slack, Jira, S3, etc.) are composed in workflow YAML using these connectors.

| Connector | Description | Capabilities | Key Actions |
|-----------|-------------|--------------|-------------|
| `http` | HTTP requests to any URL | read, write | `request` (method, url, headers, body) |
| `github-cli` | GitHub CLI (`gh`) operations | read, write, search | `issue-create`, `issue-list`, `pr-create`, `pr-list`, `repo-view` |
| `playwright` | Browser automation | read, write | `navigate`, `click`, `fill`, `screenshot`, `evaluate` |

**Source:** `src/modules/spells/src/connectors/index.ts`

To use a connector in a spell, reference it in an `agent` step's prompt:
```yaml
steps:
  - id: call-api
    type: agent
    config:
      prompt: |
        Use the http connector to GET https://api.example.com/data.
        Access via context.tools.execute('http', 'request', { method: 'GET', url: '...' })
```

### Need a Service Integration?

**Compose existing connectors in spell YAML** — do not create a per-service connector. For example, Slack integration uses the `http` connector with Slack's API URL, not a dedicated `slack` connector.

Use **`/connector-builder`** only when you need a new **step command** or a new **generalized I/O connector** for a transport type not covered by the built-ins (e.g., WebSocket, gRPC).

---

## Section 4: Validate an Existing Spell

### Step 1: Load and Parse

Read the spell file (YAML or JSON). The parser auto-detects format.

### Step 2: Run Validation

Check against all engine validation rules:

- Required fields: `name` (string), `steps` (non-empty array)
- Step integrity: unique IDs, valid types, valid config structure
- Variable references: no forward references, no undefined arguments
- MoFlo levels: valid values, step-level cannot exceed spell-level
- Circular jumps: condition steps must not form cycles
- Arguments: valid types, defaults match declared type, enum consistency

### Step 3: Report Results

- **Valid:** Confirm the spell passes all checks
- **Invalid:** List each error with its path and message, then offer to fix

---

## Reference

### Type Definitions

- **Spell definition:** `src/modules/spells/src/types/workflow-definition.types.ts` — `SpellDefinition`, `StepDefinition`, `ArgumentDefinition`, `ArgumentType`
- **Step command interface:** `src/modules/spells/src/types/step-command.types.ts` — `StepCommand`, `StepConfig`, `StepOutput`, `CastingContext`, `MofloLevel`, `CapabilityType`
- **Connector interface:** `src/modules/spells/src/types/workflow-connector.types.ts` — `SpellConnector`, `ConnectorAction`, `ConnectorOutput`, `ConnectorAccessor`

### Engine Components

- **Schema validator:** `src/modules/spells/src/schema/validator.ts` — `validateSpellDefinition()`
- **YAML/JSON parser:** `src/modules/spells/src/schema/parser.ts` — `parseWorkflow()`
- **Grimoire (registry):** `src/modules/spells/src/registry/workflow-registry.ts` — `Grimoire`
- **Definition loader:** `src/modules/spells/src/loaders/definition-loader.ts` — two-tier loading (shipped + user)

### MCP Tools

| Tool | Purpose |
|------|---------|
| `mcp__moflo__spell_create` | Create a new spell definition |
| `mcp__moflo__spell_list` | List available spells |
| `mcp__moflo__spell_cast` | Cast (execute) a spell |
| `mcp__moflo__spell_status` | Check spell execution status |

### MoFlo Integration Levels

| Level | Access |
|-------|--------|
| `none` | No MoFlo integration (default) |
| `memory` | Read/write MoFlo memory |
| `hooks` | Memory + hook triggers |
| `full` | Hooks + swarm/agent spawning |
| `recursive` | Full + nested workflow invocation |

### Variable Reference Syntax

| Pattern | Description | Example |
|---------|-------------|---------|
| `{args.name}` | Workflow argument | `{args.target}` |
| `{credentials.NAME}` | Runtime credential | `{credentials.GITHUB_TOKEN}` |
| `{stepId.key}` | Previous step output | `{fetch-data.url}` |

### Example: Complete Spell

```yaml
name: security-audit
abbreviation: sa
description: Run security checks on a target directory
version: "1.0"
mofloLevel: memory

arguments:
  target:
    type: string
    required: true
    description: Directory to audit
  severity:
    type: string
    default: medium
    enum: [low, medium, high, critical]
    description: Minimum severity to report

steps:
  - id: scan-deps
    type: bash
    config:
      command: "npm audit --json"
      cwd: "{args.target}"
    output: audit-result

  - id: analyze-findings
    type: agent
    config:
      prompt: |
        Analyze the npm audit results and filter for severity >= {args.severity}.
        Audit output: {scan-deps.result}
        Produce a summary of vulnerabilities found.
    output: analysis

  - id: check-critical
    type: condition
    config:
      expression: "{analysis.hasCritical} === true"
      then: report-critical
      else: report-clean

  - id: report-critical
    type: agent
    config:
      prompt: |
        Critical vulnerabilities found. Generate a detailed report
        with remediation steps for: {analysis.criticalItems}

  - id: report-clean
    type: agent
    config:
      prompt: |
        No critical vulnerabilities. Generate a summary report
        of {analysis.totalFindings} findings at {args.severity}+ severity.

  - id: save-report
    type: memory
    config:
      operation: write
      namespace: security
      key: "audit-{args.target}"
      value: "{analysis.summary}"
```

### Related Skills

- [/connector-builder](../connector-builder/) (#238) — scaffold new connectors and step commands when the spell needs a component that doesn't exist yet
