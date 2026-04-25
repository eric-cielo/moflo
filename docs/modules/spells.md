# cli/spells

> **Inlined into `@moflo/cli` by [#596](https://github.com/eric-cielo/moflo/issues/596)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/spells` workspace package no longer exists — its contents live at `src/modules/cli/src/spells/` and ship inside the `moflo` tarball.

The wizard-themed workflow engine. Parses YAML/JSON spell definitions, validates them against a step-command registry, and executes them through a sandboxed runner with capability gates, prerequisite checks, permission acceptance, pause/resume, and a scheduler.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/modules/cli/src/spells/` |
| Public surface | `src/modules/cli/src/spells/index.ts` (re-exports core, commands, connectors, schema, factory, scheduler) |
| Built-in step commands | `src/modules/cli/src/spells/commands/` (agent, bash, browser, condition, github, loop, memory, parallel, prompt, wait + IMAP/Outlook/Slack/MCP/graph) |
| Built-in connectors | `src/modules/cli/src/spells/connectors/` (http, github-cli, playwright + IMAP/Outlook/Slack/MCP) |
| Sandbox tiers | `src/modules/cli/src/spells/core/` — `bwrap-sandbox.ts`, `sandbox-profile.ts` (sandbox-exec), `docker-sandbox.ts`, `platform-sandbox.ts` |
| Schema + parser | `src/modules/cli/src/spells/schema/` |
| Definition loader | `src/modules/cli/src/spells/loaders/definition-loader.ts` (shipped + user precedence) |
| Scheduler | `src/modules/cli/src/spells/scheduler/` (cron, interval, one-time) |
| Tests | `src/modules/cli/__tests__/spells/` |

## Internal usage

The cli wraps the engine through two thin services — both already use relative paths into `cli/src/spells/`:

- `src/modules/cli/src/services/engine-loader.ts` — single-load cache for the runtime module, type-only imports for the engine surface.
- `src/modules/cli/src/services/grimoire-builder.ts` — composes the registry from shipped + user dirs (`moflo.yaml.spells.userDirs`).

```ts
// From any cli source file:
import { recordAcceptance } from '../spells/core/permission-acceptance.js';
import { analyzeSpellPermissions } from '../spells/core/permission-disclosure.js';
import { StepCommandRegistry } from '../spells/core/step-command-registry.js';
import { builtinCommands } from '../spells/commands/index.js';
```

## Why the rewrite

Pre-#596 framing claimed `@moflo/spells` was a separately publishable npm package. It wasn't — only the root `moflo` tarball ever shipped, with the spells `dist/` folded in via the `files` array. The workspace boundary forced a `mofloImport`/`locateMofloModuleDist` walk-up at every cli call site (engine-loader, spell-tools), the per-module `tsconfig.json`/build wiring duplicated work for nothing, and the cycle-of-dependencies between `cli` and the dynamic `@moflo/spells` import obscured the actual ownership (cli is the only consumer). ADR-0001 captures the full reasoning; #596 collapses `spells` as the next stop after `aidefence` (#590), `embeddings` (#592), `shared` (#595), and `guidance` (#600).
