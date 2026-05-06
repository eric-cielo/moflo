# Spell Engine — Custom (Pluggable) Step Commands

**Purpose:** How to extend the spell engine with user-defined or third-party step types. Reference when a built-in step type can't express what a spell needs and you want to drop in a `.js`/`.ts`/`.yaml` step file (or install an `moflo-step-*` npm package) instead of forking moflo.

---

## Pluggable Step Commands

**Drop JS/TS or YAML files into a step directory to extend the spell engine with custom step types.** User-defined steps are auto-discovered and registered alongside built-in commands.

### Discovery Sources (Priority Order)

| Priority | Source | Path |
|----------|--------|------|
| Lowest | npm packages | `node_modules/moflo-step-*` |
| Medium | Built-in | Registered by `createRunner()` |
| Highest | User directories | `workflows/steps/` or `.claude/workflows/steps/` |

**Later sources override earlier ones by step type name.** A user step named `bash` replaces the built-in `bash` command.

---

## JS/TS Step Files

**Export a `StepCommand` object as the default export, or as `stepCommand` or `command` named export.**

```javascript
// workflows/steps/file-stats.js
module.exports = {
  type: 'file-stats',
  description: 'Report file statistics',
  configSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  capabilities: [{ type: 'fs:read' }],
  validate(config) {
    const errors = [];
    if (!config.path) errors.push({ path: 'path', message: 'path is required' });
    return { valid: errors.length === 0, errors };
  },
  async execute(config) {
    const { readFileSync, statSync } = require('node:fs');
    const content = readFileSync(config.path, 'utf-8');
    return { success: true, data: { lines: content.split('\n').length, bytes: statSync(config.path).size } };
  },
  describeOutputs() { return [{ name: 'lines', type: 'number' }, { name: 'bytes', type: 'number' }]; },
};
```

See `examples/spell-steps/file-stats.js` for a complete, well-commented example.

---

## YAML Composite Steps

**YAML files define reusable composite spell steps with declared inputs, tool dependencies, and sequential actions.**

```yaml
# workflows/steps/notify.yaml
name: notify
description: Log a formatted notification message
inputs:
  level:
    type: string
    required: false
    default: "info"
  message:
    type: string
    required: true
actions:
  - command: "echo [${inputs.level}] ${inputs.message}"
```

| YAML Field | Required | Description |
|------------|----------|-------------|
| `name` | Yes | Step type name (used as `type` in spell definitions) |
| `description` | No | Human-readable description |
| `tool` | No | Declares tool dependency (maps to `net` capability and prerequisites) |
| `inputs` | No | Input schema with `type`, `required`, `default`, `description` per field |
| `actions` | Yes | Sequential actions to execute; each has `tool`/`action`/`command` + `params` |

**Use `${inputs.X}` in action params for input interpolation.** Required inputs are validated before execution.

---

## npm Package Discovery

**Install a package named `moflo-step-*` and its exported StepCommand is auto-discovered.**

The loader reads `package.json` for a `moflo.stepCommand` field pointing to the entry file. Falls back to the package's `main` field if absent.

```json
{
  "name": "moflo-step-slack-notify",
  "main": "index.js",
  "moflo": { "stepCommand": "lib/step.js" }
}
```

---

## Configuring Step Discovery in createRunner

**Pass `stepDirs` and `projectRoot` to `createRunner()` to enable pluggable step discovery.**

```typescript
import { createRunner } from 'moflo/dist/src/cli/spells/index.js';

const runner = createRunner({
  stepDirs: ['workflows/steps/', '.claude/workflows/steps/'],
  projectRoot: process.cwd(),  // Enables npm moflo-step-* discovery
});
```

---

## Invalid Files Are Warnings, Not Errors

**Files that don't export a valid StepCommand are skipped with a warning.** This prevents one bad file from breaking all step discovery. Invalid conditions: missing exports, wrong interface shape, syntax errors, malformed YAML.

---

## See Also

- `.claude/guidance/moflo-spell-engine.md` — Built-in step types, spell definition format, runner lifecycle, error codes
- `.claude/guidance/moflo-spell-sandboxing.md` — Capability declarations a custom step must include and how the sandbox enforces them
- `.claude/guidance/moflo-spell-connectors.md` — When to write a connector instead of a custom step (resource-shaped vs. action-shaped extension)
- `.claude/guidance/moflo-spell-engine-architecture.md` — Architecture decisions for the pluggable step loader
