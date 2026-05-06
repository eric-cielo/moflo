# Step Command Source Template

Purpose: full TypeScript scaffold for a `StepCommand`. Place generated file at `src/cli/spells/commands/<type>-command.ts`. Use `bash-command.ts` as a reference implementation.

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

  // Optional: preflight checks — see ../../spell-builder/preflight.md for the
  // copywriting rules that govern the user-visible `reason` strings.
  // preflight: [...],

  // Optional: rollback on failure
  // async rollback(config, context) { /* undo side effects */ },
};
```

Alternatively, use the `createStepCommand()` factory from `src/cli/spells/commands/create-step-command.ts` for compile-time type safety.

## Test Template

Place at `src/cli/__tests__/spells/<type>-command.test.ts`:

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
    });
  });
});
```

## Registration

Add to `src/cli/spells/commands/index.ts`:

```typescript
import { <type>Command } from './<type>-command.js';

export { <type>Command };
export type { <Type>StepConfig } from './<type>-command.js';

export const builtinCommands: readonly StepCommand[] = [
  agentCommand,
  bashCommand,
  // ... existing commands
  <type>Command,  // <-- add here
];
```

## See Also

- [SKILL.md](../SKILL.md) — main connector-builder skill
- [connector.md](connector.md) — generalized connector template
- [../../spell-builder/preflight.md](../../spell-builder/preflight.md) — preflight check authoring
- [../../spell-builder/permissions.md](../../spell-builder/permissions.md) — permission disclosure
