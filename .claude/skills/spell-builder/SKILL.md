---
name: "spell-builder"
description: "Create, edit, and validate spell definitions (YAML/JSON) that compose connectors and step commands into end-to-end spells. Use when building new spell definitions, modifying existing ones, or exploring available spell components."
---

# Spell Builder

Create production-ready spell definitions (YAML/JSON) that compose step commands and connectors into end-to-end automated spells, with proper data flow, validation, and engine integration.

## Architecture — Read First

**Before creating or modifying spells, read [architecture.md](architecture.md).** It defines the three-layer model (spell → step command → connector) and when to create what. Putting logic in the wrong layer is the most common mistake.

## Prerequisites

- MoFlo project with `cli/spells` package
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
| **MoFlo Level** | Optional | Override spell-level mofloLevel (can only narrow, not escalate) |
| **Permission Level** | Optional | `readonly`, `standard`, `elevated`, `autonomous` — controls Claude CLI tools when this step spawns a sub-agent. Auto-derived from capabilities when omitted. |

**Data flow between steps:** Use `{stepId.outputKey}` syntax to reference output from a previous step. For example, if step `fetch-data` outputs a `url` field, a later step can use `{fetch-data.url}` in its config.

#### REQUIRED: Permission Disclosure on Step Creation

**After defining each step, you MUST display its permission requirements.** This is not optional — users must understand what each step can do before it becomes part of a spell.

For each step, determine and display:

1. **Permission level** — derived from capabilities or explicit `permissionLevel`:
   - `readonly` (Read, Glob, Grep) — safe, analysis only
   - `standard` (Edit, Write, Read, Glob, Grep) — can modify files
   - `elevated` (Edit, Write, Bash, Read, Glob, Grep) — can run shell commands
   - `autonomous` (all tools) — unrestricted, requires explicit opt-in

2. **Risk classification** — based on the step's capabilities:
   - **[SAFE]** — `fs:read`, `memory` only — no side effects
   - **[SENSITIVE]** — `agent`, `net`, `browser` — can read external data or spawn processes
   - **[DESTRUCTIVE]** — `shell`, `fs:write`, `browser:evaluate`, `credentials` — can permanently modify/delete data

3. **Specific warnings** — for each destructive or sensitive capability, explain:
   - `shell`: "Can execute arbitrary shell commands (rm, git push, etc.)"
   - `fs:write`: "Can create, overwrite, or delete files on disk"
   - `credentials`: "Can access stored secrets and API keys"
   - `agent`: "Can spawn autonomous Claude sub-agents"
   - `net`: "Can make network requests to external services"

**Display format (show after every step definition):**

```
Permissions for step "deploy-code":
  [DESTRUCTIVE] deploy-code (bash)
    Permission level: elevated
    Allowed tools: Edit, Write, Bash, Read, Glob, Grep
    Warnings:
      !! shell: Can execute arbitrary shell commands (rm, git push, etc.)
      !! fs:write: Can create, overwrite, or delete files on disk
```

If the step is safe, still display the permissions but with a reassuring tone:

```
Permissions for step "analyze-logs":
  [SAFE] analyze-logs (bash)
    Permission level: readonly
    Allowed tools: Read, Glob, Grep
    No destructive capabilities.
```

**Special variable references:**
- `{args.name}` — references a spell argument
- `{credentials.NAME}` — references a credential (resolved at runtime)
- `{stepId.outputKey}` — references output from a previous step

#### REQUIRED: Preflight checks with human-readable hints

When a step depends on runtime state the user controls (clean git tree, logged-in CLI, reachable host, etc.), declare a `preflight:` block so the spell fails fast with a helpful message BEFORE any side effects occur.

**Every preflight MUST include a `hint:` field.** The hint is what the end user will see when the check fails. Without it they get raw shell output (`command "git diff --quiet" exited with 1, expected 0`), which looks like a bug in the spell engine.

Good hints:
- Speak in plain English (no command names, exit codes, or tool jargon).
- State the problem AND the fix in one or two sentences.
- Assume a non-technical reader.

```yaml
steps:
  - id: create-branch
    type: bash
    preflight:
      - name: "working tree clean (tracked changes)"
        command: "git diff --quiet"
        hint: "You have uncommitted changes to tracked files. Commit them or stash them (git stash) before running this spell."
      - name: "gh cli authenticated"
        command: "gh auth status"
        hint: "The GitHub CLI isn't signed in. Run: gh auth login"
    config:
      command: "git checkout -b feature/new"
```

Bad hint (don't do this):
```yaml
hint: "git diff --quiet failed with exit code 1"   # leaks command name + exit code
hint: "Precondition violated"                       # tells user nothing actionable
```

Preflights with no `hint` still work but produce unfriendly default output — flag this to the user as a quality issue before saving the spell.

##### Fatal vs warning severity

By default every preflight is `severity: fatal` — if it fails, the spell aborts. Some preflights are better expressed as `severity: warning`: the user gets to choose how to handle the problem, and the spell continues if they pick a resolution.

Use `warning` ONLY when:
- The underlying problem has a safe, one-step fix the user might reasonably want to apply.
- Proceeding is viable either way — the step itself is robust to the condition.

Warning preflights MUST declare `resolutions:` — a list of options the user can pick from. Each resolution has a `label` and an optional `command` to run before continuing. If `command` is omitted, picking the resolution just proceeds (useful for "I'll handle it myself").

```yaml
preflight:
  - name: "working tree clean (tracked changes)"
    command: "git diff --quiet"
    severity: "warning"
    hint: "You have uncommitted changes. If you want them carried onto the new branch, pick 'Stash and carry over'."
    resolutions:
      - label: "Stash changes and carry them onto the new branch"
        command: "git stash push --include-untracked --message 'pre-spell autostash'"
      - label: "Commit changes to the current branch first, then continue"
        command: "git commit -am 'wip: pre-spell snapshot'"
```

In non-interactive contexts (CI, daemons, scheduled spells) warnings automatically behave like fatals, because there is no one to prompt. Don't use `warning` as a way to silently ignore a problem — if ignoring it is always safe, the check shouldn't be there.

### Step 4: Generate the Spell YAML

Assemble the definition into YAML format following this structure:

```yaml
name: <spell-name>
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
11. **`permissionLevel`** (if declared) must be one of: `readonly`, `standard`, `elevated`, `autonomous`

If validation fails, show the specific errors and guide the user to fix them.

### Step 5b: REQUIRED — Permission Dry-Run Report

**After schema validation passes, you MUST display a full permission report for the spell.** This is mandatory for new spells and updated spells — users must see and accept the permission profile before the spell can be run.

Display the report in this format:

```
Permission Report: <spell-name>
Overall risk: [DESTRUCTIVE] destructive
Permission hash: a1b2c3d4e5f6g7h8

  [SAFE] fetch-config (bash)
    Permission level: readonly
    Allowed tools: Read, Glob, Grep

  [DESTRUCTIVE] implement-story (bash)
    Permission level: elevated
    Allowed tools: Edit, Write, Bash, Read, Glob, Grep
    Warnings:
      !! shell: Can execute arbitrary shell commands (rm, git push, etc.)
      !! fs:write: Can create, overwrite, or delete files on disk

  [SENSITIVE] analyze-results (agent)
    Permission level: standard
    Allowed tools: Edit, Write, Read, Glob, Grep
    Warnings:
      ! agent: Can spawn autonomous Claude sub-agents

--- DESTRUCTIVE STEPS ---
1 step(s) can make destructive changes:
  - implement-story: shell, fs:write

These steps can modify files, run shell commands, or access credentials.
Review the spell definition before accepting.
```

**After showing the report, ask the user:**

> The spell requires the permissions shown above. Do you accept? (y/n)

If the user accepts, the permission hash is stored and subsequent runs will not prompt again (unless the spell's permissions change).

**Regular runs** (not dry-runs) do NOT show this verbose permission output — they just run quietly. The acceptance gate checks the stored hash and only blocks if it doesn't match.

### Step 6: Write the File

Ask the user where to save the spell:

- **Project spells:** `spells/<name>.yaml` (user-level, project-specific)
- **Claude spells:** `.claude/spells/<name>.yaml` (Claude Code integration)

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
| **Add/remove arguments** | Modify spell argument definitions |
| **Update metadata** | Change name, description, version, abbreviation, mofloLevel |

After each change, re-validate the definition and show any errors introduced.

**REQUIRED: When adding or modifying a step, display its permission report** (same format as Section 1, Step 3 — Permission Disclosure on Step Creation). If the change introduces new destructive capabilities or raises the permission level, explicitly call this out to the user.

### Step 4: Save

Write the updated YAML back to the original file (or a new path if requested).

---

## Section 3: Discover Available Spell Components

### Step Commands

**Each step type has its own directory with a self-contained README.** To discover available steps, scan the `steps/` directory within this skill:

```
.claude/skills/spell-builder/steps/
  <step-name>/README.md    — config, outputs, usage examples, source path
```

**To find what steps are available:** Use `Glob` on `.claude/skills/spell-builder/steps/*/README.md` and read the H1 heading of each file. Each README is self-contained — it has everything needed to use that step type.

**Runtime source:** `src/cli/spells/commands/` — each step is a TypeScript file registered in `index.ts`.

**Adding a new step:** Create a directory under `steps/<name>/` with a `README.md`. Follow `.claude/guidance/internal/guidance-rules.md` and use existing step READMEs as templates. The step command source goes in `src/cli/spells/commands/` and is registered in `index.ts`. No changes to this SKILL.md needed.

### Connectors

**Each connector has its own directory with a self-contained README.** To discover available connectors, scan the `connectors/` directory:

```
.claude/skills/spell-builder/connectors/
  <connector-name>/README.md    — actions, capabilities, usage, source path
```

**To find what connectors are available:** Use `Glob` on `.claude/skills/spell-builder/connectors/*/README.md`.

**Runtime source:** `src/cli/spells/connectors/` — each connector is a TypeScript file registered in `index.ts`.

**Adding a new connector:** Create a directory under `connectors/<name>/` with a `README.md`. Follow `.claude/guidance/internal/guidance-rules.md` and use existing connector READMEs as templates. The connector source goes in `src/cli/spells/connectors/` and is registered in `index.ts`. No changes to this SKILL.md needed.

**When to create a new connector vs composing existing ones:** See [architecture.md](architecture.md) for the decision tree.

---

## Section 4: Validate an Existing Spell

### Step 1: Load and Parse

Read the spell file (YAML or JSON). The parser auto-detects format.

### Step 2: Run Validation

Check against all engine validation rules:

- Required fields: `name` (string), `steps` (non-empty array)
- Step integrity: unique IDs, valid types, valid config structure
- Variable references: no forward references, no undefined arguments
- MoFlo levels: valid values, step-level cannot exceed the spell-level
- Circular jumps: condition steps must not form cycles
- Arguments: valid types, defaults match declared type, enum consistency

### Step 3: Report Results

- **Valid:** Confirm the spell passes all checks
- **Invalid:** List each error with its path and message, then offer to fix

---

## Reference

### Type Definitions

- **Spell definition:** `src/cli/spells/types/spell-definition.types.ts` — `SpellDefinition`, `StepDefinition`, `ArgumentDefinition`, `ArgumentType`
- **Step command interface:** `src/cli/spells/types/step-command.types.ts` — `StepCommand`, `StepConfig`, `StepOutput`, `CastingContext`, `MofloLevel`, `CapabilityType`
- **Connector interface:** `src/cli/spells/types/spell-connector.types.ts` — `SpellConnector`, `ConnectorAction`, `ConnectorOutput`, `ConnectorAccessor`

### Engine Components

- **Schema validator:** `src/cli/spells/schema/validator.ts` — `validateSpellDefinition()`
- **YAML/JSON parser:** `src/cli/spells/schema/parser.ts` — `parseSpell()`
- **Grimoire (registry):** `src/cli/spells/registry/spell-registry.ts` — `Grimoire`
- **Definition loader:** `src/cli/spells/loaders/definition-loader.ts` — two-tier loading (shipped + user)

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
| `recursive` | Full + nested spell invocation |

### Variable Reference Syntax

| Pattern | Description | Example |
|---------|-------------|---------|
| `{args.name}` | Spell argument | `{args.target}` |
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
    preflight:
      - name: "npm available"
        command: "npm --version"
        hint: "npm isn't installed or isn't on your PATH. Install Node.js from https://nodejs.org and try again."
      - name: "target directory exists"
        command: "test -d \"{args.target}\""
        hint: "The directory you passed as --target doesn't exist. Check the path and try again."
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
