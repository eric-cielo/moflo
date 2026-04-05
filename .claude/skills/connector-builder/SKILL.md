---
name: "Connector Builder"
description: "Scaffold new workflow step commands and (rarely) generalized I/O connectors. Use when building new step commands for workflows or extending the workflow engine with new capabilities. Connectors are only for new I/O transport types — NOT for per-service wrappers."
---

# Connector Builder

Scaffold production-ready step commands (`StepCommand`) and, when truly needed, generalized I/O connectors (`WorkflowConnector`) with proper types, tests, and registration.

## Prerequisites

- MoFlo project with `@moflo/workflows` package
- TypeScript 5+
- Vitest for testing

## What This Skill Does

1. Guides you through building a **step command** (workflow step logic) or, rarely, a **generalized connector** (new I/O transport)
2. Generates type-safe TypeScript implementing the correct interface
3. Creates a test file with vitest mocks
4. Shows how to register the component and use it in workflow YAML

---

## Quick Start

Ask the user:

> **What do you want to build?**
> 1. **Step command** — executes logic within a workflow step (transform data, control flow, etc.)
> 2. **Generalized connector** — wraps a new I/O transport type (e.g., WebSocket, gRPC, MQTT)

**Important:** If the user asks for a service-specific connector (Slack, Jira, S3, etc.), guide them to compose existing connectors (`http`, `github-cli`, `playwright`) in workflow YAML instead. Per-service connectors are not the right pattern — see `.claude/guidance/shipped/moflo-workflow-connectors.md` for the architectural rationale (issues #233–#259).

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

Create the file at `src/packages/workflows/src/connectors/<name>.ts`.

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
  WorkflowConnector,
  ConnectorAction,
  ConnectorOutput,
  ConnectorCapability,
} from '../types/workflow-connector.types.js';

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

export const <name>Connector: WorkflowConnector = {
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

Create at `tests/packages/workflows/connectors/<name>.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { <name>Connector, validate<Name>Action } from
  '../../../../src/packages/workflows/src/connectors/<name>.js';

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

Add to `src/packages/workflows/src/connectors/index.ts`:

```typescript
import { <name>Connector } from './<name>.js';

export { <name>Connector };

// Add to the builtinConnectors array:
export const builtinConnectors: WorkflowConnector[] = [
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
description: Example workflow using the <name> connector

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
| **MoFlo level** | No (default `none`) | `none`, `memory`, `hooks`, `full`, `recursive` |
| **Prerequisites** | No | External CLI tools needed |

### Step 2: Generate Step Command Source

Create at `src/packages/workflows/src/commands/<type>-command.ts`.

Follow this template, using `bash-command.ts` as the reference implementation:

```typescript
/**
 * <Type> Step Command — <description>.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
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

  async execute(config: <Type>StepConfig, context: WorkflowContext): Promise<StepOutput> {
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

  // Optional: rollback on failure
  // async rollback(config, context) { /* undo side effects */ },
};
```

Alternatively, use the `createStepCommand()` factory from `src/packages/workflows/src/commands/create-step-command.ts` for compile-time type safety.

### Step 3: Generate Step Command Test

Create at `tests/packages/workflows/commands/<type>-command.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { <type>Command } from
  '../../../../src/packages/workflows/src/commands/<type>-command.js';
import type { WorkflowContext } from
  '../../../../src/packages/workflows/src/types/step-command.types.js';

const mockContext: WorkflowContext = {
  variables: {},
  args: {},
  credentials: { get: vi.fn(), has: vi.fn() },
  memory: { read: vi.fn(), write: vi.fn(), search: vi.fn() },
  taskId: 'test-task',
  workflowId: 'test-workflow',
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

Add to `src/packages/workflows/src/commands/index.ts`:

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
description: Example workflow using the <type> step

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

- **Connector interface:** `src/packages/workflows/src/types/workflow-connector.types.ts` — `WorkflowConnector`, `ConnectorAction`, `ConnectorOutput`, `ConnectorCapability`
- **Step command interface:** `src/packages/workflows/src/types/step-command.types.ts` — `StepCommand`, `StepConfig`, `StepOutput`, `WorkflowContext`, `JSONSchema`
- **Step factory:** `src/packages/workflows/src/commands/create-step-command.ts` — `createStepCommand()`

### Existing Components

**Shipped connectors** (`src/packages/workflows/src/connectors/`): `http` (http-tool.ts), `github-cli` (github-cli.ts), `playwright` (playwright.ts)

**Built-in step commands** (`src/packages/workflows/src/commands/`): `agent` (agent-command.ts), `bash` (bash-command.ts), `condition` (condition-command.ts), `prompt` (prompt-command.ts), `memory` (memory-command.ts), `wait` (wait-command.ts), `loop` (loop-command.ts), `browser` (browser-command.ts), `github` (github-command.ts)

### Related Skills

- [/workflow-builder](../workflow-builder/) (#240) — composes connectors and steps into workflow definitions; references this skill when a needed connector doesn't exist
