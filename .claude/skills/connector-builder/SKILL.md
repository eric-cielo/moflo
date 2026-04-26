---
name: "connector-builder"
description: "Scaffold new spell step commands and connectors. Use when building new step commands for spells or extending the spell engine with new capabilities. Connectors are for new I/O transport types OR platforms requiring complex multi-step interaction (e.g., browser-based automation)."
---

# Connector Builder

Scaffold production-ready step commands (`StepCommand`) and, when truly needed, generalized I/O connectors (`SpellConnector`) with proper types, tests, and registration.

## Prerequisites

- MoFlo project with `cli/spells` package
- TypeScript 5+
- Vitest for testing

## What This Skill Does

1. Guides you through building a **step command** (spell step logic) or, rarely, a **generalized connector** (new I/O transport)
2. Generates type-safe TypeScript implementing the correct interface
3. Creates a test file with vitest mocks
4. Shows how to register the component and use it in spell YAML

---

## Quick Start

Ask the user:

> **What do you want to build?**
> 1. **Step command** — executes logic within a spell step (transform data, control flow, etc.)
> 2. **Generalized connector** — wraps a new I/O transport type (e.g., WebSocket, gRPC, MQTT)

**Important:** Simple service integrations (Slack webhook, S3 upload, Jira comment) should compose existing connectors (`http`, `github-cli`, `playwright`) in spell YAML — no dedicated connector needed. However, platforms requiring complex multi-step browser interaction (like Outlook.com web UI) DO warrant a dedicated connector. See `.claude/skills/spell-builder/architecture.md` for the decision tree.

**Documentation requirement:** When creating any new step command or connector, you MUST also create a README.md following `.claude/guidance/internal/guidance-rules.md`. Use existing READMEs in `.claude/skills/spell-builder/steps/` or `connectors/` as templates. Apply automatically — the user should never need to ask.

Then follow the appropriate section below.

---

## Building a Generalized Connector (Rare — New I/O Transports Only)

**You almost certainly want a step command, not a connector.** The three built-in connectors (`http`, `github-cli`, `playwright`) cover web APIs, CLI tools, and browser automation. Only create a new connector for a fundamentally new I/O transport (WebSocket, gRPC, MQTT, etc.) that no existing connector supports.

### Step 1: Gather Requirements

Ask the user for:

| Field | Required | Example |
|-------|----------|---------|
| **Name** | Yes | `websocket`, `grpc`, `mqtt` |
| **Description** | Yes | `WebSocket bidirectional messaging` |
| **Version** | Yes (default `1.0.0`) | `1.0.0` |
| **Capabilities** | Yes | `read`, `write`, `search`, `subscribe`, `authenticate` |
| **Actions** | Yes (at least 1) | `connect`, `send`, `receive`, `close` |

For each action, ask:
- Action name (kebab-case)
- Description
- Input parameters (name, type, required?)
- Output fields (name, type)

**Verify the connector is generalized:** The name should describe an I/O transport, not a service. `websocket` is correct; `slack` is not.

### Step 2: Generate Connector Source

Create the file at `src/cli/spells/connectors/<name>.ts`.

Follow this template, using `github-cli.ts` as the reference implementation:

```typescript
/**
 * <Name> Workflow Connector
 *
 * <Description>
 *
 * Actions: <comma-separated action names>
 */

import type {
  SpellConnector,
  ConnectorAction,
  ConnectorOutput,
  ConnectorCapability,
} from '../types/spell-connector.types.js';

export type <Name>Action = '<action-1>' | '<action-2>';

export const VALID_ACTIONS: readonly <Name>Action[] = [
  '<action-1>', '<action-2>',
];

async function execute<Action1>(
  params: Record<string, unknown>,
  start: number,
): Promise<ConnectorOutput> {
  // Implementation
  return { success: true, data: { /* result */ }, duration: Date.now() - start };
}

export function validate<Name>Action(
  action: string,
  params: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  if (!action || !VALID_ACTIONS.includes(action as <Name>Action)) {
    errors.push(`action must be one of: ${VALID_ACTIONS.join(', ')}`);
    return errors;
  }
  switch (action) {
    case '<action-1>':
      if (!params.<requiredParam>) errors.push('<action-1> requires <requiredParam>');
      break;
  }
  return errors;
}

const ACTIONS: ConnectorAction[] = [
  {
    name: '<action-1>',
    description: '<action description>',
    inputSchema: {
      type: 'object',
      properties: {
        // Define input params with types and descriptions
      },
      required: ['<required-param>'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        // Define output fields
      },
    },
  },
];

export const <name>Connector: SpellConnector = {
  name: '<name>',
  description: '<Description>',
  version: '<version>',
  capabilities: [<capabilities>] as readonly ConnectorCapability[],

  async initialize(config: Record<string, unknown>): Promise<void> {
    // Validate prerequisites (CLI tools, auth, API keys, etc.)
  },

  async dispose(): Promise<void> {
    // Clean up connections/resources
  },

  async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
    const start = Date.now();
    const errors = validate<Name>Action(action, params);
    if (errors.length > 0) {
      return { success: false, data: {}, error: errors.join('; '), duration: Date.now() - start };
    }
    switch (action) {
      case '<action-1>':
        return execute<Action1>(params, start);
      default:
        return { success: false, data: {}, error: `Unknown action: ${action}`, duration: Date.now() - start };
    }
  },

  listActions(): ConnectorAction[] {
    return ACTIONS;
  },
};
```

### Step 3: Generate Connector Test

Create at `tests/packages/spells/connectors/<name>.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { <name>Connector, validate<Name>Action } from
  '../../../../src/cli/spells/connectors/<name>.js';

describe('<name>Connector', () => {
  describe('metadata', () => {
    it('has required properties', () => {
      expect(<name>Connector.name).toBe('<name>');
      expect(<name>Connector.description).toBeTruthy();
      expect(<name>Connector.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(<name>Connector.capabilities.length).toBeGreaterThan(0);
    });

    it('lists actions with schemas', () => {
      const actions = <name>Connector.listActions();
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action.name).toBeTruthy();
        expect(action.description).toBeTruthy();
        expect(action.inputSchema).toBeDefined();
        expect(action.outputSchema).toBeDefined();
      }
    });
  });

  describe('validation', () => {
    it('rejects unknown actions', () => {
      const errors = validate<Name>Action('unknown', {});
      expect(errors.length).toBeGreaterThan(0);
    });

    it('validates required params for <action-1>', () => {
      const errors = validate<Name>Action('<action-1>', {});
      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts valid params for <action-1>', () => {
      const errors = validate<Name>Action('<action-1>', { <requiredParam>: 'value' });
      expect(errors).toEqual([]);
    });
  });

  describe('execute', () => {
    it('returns error for unknown action', async () => {
      const result = await <name>Connector.execute('unknown', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    // Add per-action execution tests with mocked externals
  });

  describe('lifecycle', () => {
    it('initializes without error', async () => {
      // Mock prerequisites as available
      await expect(<name>Connector.initialize({})).resolves.not.toThrow();
    });

    it('disposes without error', async () => {
      await expect(<name>Connector.dispose()).resolves.not.toThrow();
    });
  });
});
```

### Step 4: Register the Connector

Add to `src/cli/spells/connectors/index.ts`:

```typescript
import { <name>Connector } from './<name>.js';

export { <name>Connector };

// Add to the builtinConnectors array:
export const builtinConnectors: SpellConnector[] = [
  httpConnector,
  githubCliConnector,
  playwrightConnector,
  <name>Connector,  // <-- add here
];
```

### Step 5: Example Workflow YAML

```yaml
name: example-with-<name>
version: "1.0"
description: Example spell using the <name> connector

connectors:
  - <name>

steps:
  - name: do-something
    type: bash
    config:
      command: "echo 'preparing...'"

  - name: use-<name>
    type: agent
    config:
      prompt: |
        Use the <name> connector to <action-1>.
        Access via context.tools.execute('<name>', '<action-1>', { ... })
```

---

## Building a Step Command

### Step 1: Gather Requirements

Ask the user for:

| Field | Required | Example |
|-------|----------|---------|
| **Type** | Yes (kebab-case) | `transform`, `notify`, `validate-schema` |
| **Description** | Yes | `Transform data using jq-like expressions` |
| **Config fields** | Yes (at least 1) | `expression: string`, `input: object` |
| **Capabilities** | No | `fs:read`, `fs:write`, `net`, `shell`, `memory`, `credentials`, `browser`, `agent` |
| **Permission Level** | No | `readonly`, `standard`, `elevated`, `autonomous` — auto-derived from capabilities when omitted |
| **MoFlo level** | No (default `none`) | `none`, `memory`, `hooks`, `full`, `recursive` |
| **Prerequisites** | No | External CLI tools needed |

#### REQUIRED: Permission Disclosure

**After gathering capabilities, you MUST display the permission implications to the user.** Classify and show:

- **Permission level** — derived from capabilities:
  - `readonly` (Read, Glob, Grep) — no `shell`, `fs:write`, `agent`, `net`, `browser` capabilities
  - `standard` (Edit, Write, Read, Glob, Grep) — has `fs:write` or `agent` but not `shell`/`browser`
  - `elevated` (Edit, Write, Bash, Read, Glob, Grep) — has `shell` or `browser`
  - `autonomous` — requires explicit opt-in, never auto-derived

- **Risk classification:**
  - **[SAFE]** — `fs:read`, `memory` only
  - **[SENSITIVE]** — `agent`, `net`, `browser`
  - **[DESTRUCTIVE]** — `shell`, `fs:write`, `browser:evaluate`, `credentials`

- **Specific warnings** for each destructive/sensitive capability:
  - `shell`: "Can execute arbitrary shell commands (rm, git push, etc.)"
  - `fs:write`: "Can create, overwrite, or delete files on disk"
  - `credentials`: "Can access stored secrets and API keys"
  - `agent`: "Can spawn autonomous Claude sub-agents"
  - `net`: "Can make network requests to external services"

**Example display:**

```
Step command "deploy" capabilities:
  [DESTRUCTIVE]
    Permission level: elevated
    Capabilities: shell, fs:write, fs:read
    Warnings:
      !! shell: Can execute arbitrary shell commands (rm, git push, etc.)
      !! fs:write: Can create, overwrite, or delete files on disk

    Steps using this command will require user acceptance before first run.
```

### Step 2: Generate Step Command Source

Create at `src/cli/spells/commands/<type>-command.ts`.

Follow this template, using `bash-command.ts` as the reference implementation:

```typescript
/**
 * <Type> Step Command — <description>.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  StepCapability,
} from '../types/step-command.types.js';

/** Typed config for the <type> step command. */
export interface <Type>StepConfig extends StepConfig {
  readonly <field1>: <type1>;
  readonly <field2>?: <type2>;
}

export const <type>Command: StepCommand<<Type>StepConfig> = {
  type: '<type>',
  description: '<Description>',
  capabilities: [
    // { type: 'fs:read' },
  ] as readonly StepCapability[],
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      <field1>: { type: '<json-type>', description: '<Field description>' },
      <field2>: { type: '<json-type>', description: '<Field description>' },
    },
    required: ['<field1>'],
  } satisfies JSONSchema,

  validate(config: <Type>StepConfig): ValidationResult {
    const errors = [];
    if (!config.<field1> || typeof config.<field1> !== '<expected-type>') {
      errors.push({ path: '<field1>', message: '<field1> is required and must be a <expected-type>' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: <Type>StepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();
    try {
      // Implementation here
      const result = {}; // compute result

      return {
        success: true,
        data: { result },
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'result', type: 'object', description: 'The computed result' },
    ];
  },

  // Optional: runtime preflight checks — run BEFORE any step executes.
  // Use for validating runtime state (issue open, service reachable, etc).
  // CRITICAL: the `reason` string IS the message the end user sees.
  // Write it in plain English. State the problem AND the fix. No tool
  // jargon, no exit codes, no internal identifiers.
  //
  // Default severity is 'fatal' (abort on failure). Set severity: 'warning'
  // + resolutions when the user can safely choose how to proceed; in
  // interactive runs they'll be prompted, in non-interactive runs warnings
  // behave like fatals.
  //
  // preflight: [
  //   {
  //     name: '<service> reachable',
  //     severity: 'fatal',
  //     check: async (config, ctx) => {
  //       const ok = await ping(config.endpoint);
  //       if (ok) return { passed: true };
  //       return {
  //         passed: false,
  //         reason: `Can't reach ${config.endpoint}. Check your network connection or the service URL in your spell config.`,
  //       };
  //     },
  //   },
  //   {
  //     name: 'local cache fresh',
  //     severity: 'warning',
  //     resolutions: [
  //       { label: 'Refresh the cache now', command: '<type>-cli cache refresh' },
  //       { label: 'Continue with stale cache' },
  //     ],
  //     check: async (config) => {
  //       const stale = await isCacheStale(config.endpoint);
  //       return stale
  //         ? { passed: false, reason: 'Your local cache is more than 24 hours old and may produce outdated results.' }
  //         : { passed: true };
  //     },
  //   },
  // ],

  // Optional: rollback on failure
  // async rollback(config, context) { /* undo side effects */ },
};
```

Alternatively, use the `createStepCommand()` factory from `src/cli/spells/commands/create-step-command.ts` for compile-time type safety.

#### Preflight `reason` strings — write for humans

When your step declares `preflight` checks, the `reason` string returned on failure is shown verbatim to end users as the error message. Treat it as user-facing copy:

- Plain English, no command names, exit codes, or internal identifiers.
- State BOTH the problem and the fix.
- Assume a non-technical reader.

Good: `"You're not signed in to GitHub. Run: gh auth login"`
Bad: `"gh auth status exited with code 1"` — leaks implementation detail
Bad: `"auth check failed"` — tells the user nothing actionable

### Step 3: Generate Step Command Test

Create at `tests/packages/spells/commands/<type>-command.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { <type>Command } from
  '../../../../src/cli/spells/commands/<type>-command.js';
import type { CastingContext } from
  '../../../../src/cli/spells/types/step-command.types.js';

const mockContext: CastingContext = {
  variables: {},
  args: {},
  credentials: { get: vi.fn(), has: vi.fn() },
  memory: { read: vi.fn(), write: vi.fn(), search: vi.fn() },
  taskId: 'test-task',
  spellId: 'test-spell',
  stepIndex: 0,
};

describe('<type>Command', () => {
  describe('metadata', () => {
    it('has required properties', () => {
      expect(<type>Command.type).toBe('<type>');
      expect(<type>Command.description).toBeTruthy();
      expect(<type>Command.configSchema).toBeDefined();
      expect(<type>Command.configSchema.required).toContain('<field1>');
    });
  });

  describe('validate', () => {
    it('rejects missing required fields', () => {
      const result = <type>Command.validate({} as any, mockContext);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('accepts valid config', () => {
      const result = <type>Command.validate(
        { <field1>: '<valid-value>' } as any,
        mockContext,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('execute', () => {
    it('succeeds with valid config', async () => {
      const result = await <type>Command.execute(
        { <field1>: '<valid-value>' } as any,
        mockContext,
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('describeOutputs', () => {
    it('returns output descriptors', () => {
      const outputs = <type>Command.describeOutputs();
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) {
        expect(output.name).toBeTruthy();
        expect(output.type).toBeTruthy();
      }
    });
  });
});
```

### Step 4: Register the Step Command

Add to `src/cli/spells/commands/index.ts`:

```typescript
import { <type>Command } from './<type>-command.js';

export { <type>Command };
export type { <Type>StepConfig } from './<type>-command.js';

// Add to the builtinCommands array:
export const builtinCommands: readonly StepCommand[] = [
  agentCommand,
  bashCommand,
  // ... existing commands
  <type>Command,  // <-- add here
];
```

### Step 5: Example Workflow YAML

```yaml
name: example-with-<type>
version: "1.0"
description: Example spell using the <type> step

steps:
  - name: my-step
    type: <type>
    config:
      <field1>: "value"
      <field2>: "optional-value"
```

---

## Reference

### Type Definitions

- **Connector interface:** `src/cli/spells/types/spell-connector.types.ts` — `SpellConnector`, `ConnectorAction`, `ConnectorOutput`, `ConnectorCapability`
- **Step command interface:** `src/cli/spells/types/step-command.types.ts` — `StepCommand`, `StepConfig`, `StepOutput`, `CastingContext`, `JSONSchema`
- **Step factory:** `src/cli/spells/commands/create-step-command.ts` — `createStepCommand()`

### Existing Components

**Shipped connectors** (`src/cli/spells/connectors/`): `http` (http-tool.ts), `github-cli` (github-cli.ts), `playwright` (playwright.ts)

**Built-in step commands** (`src/cli/spells/commands/`): `agent` (agent-command.ts), `bash` (bash-command.ts), `condition` (condition-command.ts), `prompt` (prompt-command.ts), `memory` (memory-command.ts), `wait` (wait-command.ts), `loop` (loop-command.ts), `browser` (browser-command.ts), `github` (github-command.ts)

### Related Skills

- [/spell-builder](../spell-builder/) (#240) — composes connectors and steps into spell definitions; references this skill when a needed connector doesn't exist
