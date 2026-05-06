# Spell Runner — Execution, Layering, Errors, and Recovery

**Purpose:** How spells are run, validated, paused, resumed, and how errors and credentials are handled. For the YAML schema, step types, and authoring rules, see `.claude/guidance/moflo-spell-engine.md`.

---

## Running a Spell via MCP Tools

**Use `mcp__moflo__spell_cast` to execute a spell from a YAML/JSON file.** The bridge layer handles parsing, validation, and runner lifecycle automatically.

| MCP Tool | Purpose |
|----------|---------|
| `mcp__moflo__spell_cast` | Run spell from file content (YAML/JSON) |
| `mcp__moflo__spell_execute` | Execute a spell definition object directly |
| `mcp__moflo__spell_cancel` | Cancel a running spell by ID |
| `mcp__moflo__spell_status` | Check whether a spell is currently running |
| `mcp__moflo__spell_suspend` | Pause a running spell for later resumption |
| `mcp__moflo__spell_resume` | Resume a previously paused spell |

**Dry-run mode validates without executing.** Pass `dryRun: true` to check definition validity, argument resolution, and step config schemas before committing to execution.

---

## Dry-Run Validation

**Always dry-run before executing a new or modified spell.** Dry-run validates the definition, resolves arguments, and checks step configs — nothing executes.

```typescript
import { runSpellFromContent } from 'moflo/dist/src/cli/spells/index.js';

const result = await runSpellFromContent(yamlContent, 'my-spell.yaml', { dryRun: true });
if (!result.success) {
  console.error('Validation errors:', result.errors);
}
```

Via MCP: pass `dryRun: true` to `mcp__moflo__spell_cast`.

Dry runs also show the per-step permission report — see `.claude/guidance/moflo-spell-sandboxing.md` § Permission Levels.

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
| `STEP_VALIDATION_FAILED` | Step config fails the command's schema validation |
| `STEP_EXECUTION_FAILED` | Step threw during execution |
| `STEP_TIMEOUT` | Step exceeded its timeout |
| `STEP_CANCELLED` | Spell cancelled via AbortSignal |
| `CONDITION_TARGET_NOT_FOUND` | Condition branch references a nonexistent step ID |
| `PAUSED_STATE_NOT_FOUND` | No paused state for spell ID on resume |
| `PAUSED_STATE_EXPIRED` | Paused state exceeded the stale timeout |
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

## Credential Handling

**Credentials are accessed via `{credentials.KEY}` in interpolation.** The credential accessor is injected into the runner at creation time — spells never store credentials directly.

Credential values listed in `RunnerOptions.credentialValues` are automatically redacted from step output to prevent accidental exposure in logs or results. The `credentials` capability gates access — see `.claude/guidance/moflo-spell-sandboxing.md`.

---

## See Also

- `.claude/guidance/moflo-spell-engine.md` — Definition format, step types, variable interpolation
- `.claude/guidance/moflo-spell-sandboxing.md` — Capability-based security and permission levels
- `.claude/guidance/moflo-spell-troubleshooting.md` — Common failure modes when running spells
- `.claude/guidance/moflo-spell-custom-steps.md` — Pluggable step commands
- `.claude/guidance/moflo-spell-connectors.md` — Resource connectors and the registry
- `.claude/guidance/moflo-core-guidance.md` — CLI, hooks, swarm, memory reference
