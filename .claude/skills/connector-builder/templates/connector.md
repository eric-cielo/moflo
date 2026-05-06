# Connector Source Template

Purpose: full TypeScript scaffold for a generalized `SpellConnector`. Place generated file at `src/cli/spells/connectors/<name>.ts`. Use `github-cli.ts` as a reference implementation.

```typescript
/**
 * <Name> Spell Connector — <Description>
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

## Test Template

Place at `src/cli/__tests__/spells/<name>.test.ts`:

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
      await expect(<name>Connector.initialize({})).resolves.not.toThrow();
    });
    it('disposes without error', async () => {
      await expect(<name>Connector.dispose()).resolves.not.toThrow();
    });
  });
});
```

## Registration

Add to `src/cli/spells/connectors/index.ts`:

```typescript
import { <name>Connector } from './<name>.js';

export { <name>Connector };

export const builtinConnectors: SpellConnector[] = [
  httpConnector,
  githubCliConnector,
  playwrightConnector,
  <name>Connector,  // <-- add here
];
```

## See Also

- [SKILL.md](../SKILL.md) — main connector-builder skill
- [step-command.md](step-command.md) — step command template
