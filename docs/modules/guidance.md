# cli/guidance

> **Inlined into `@moflo/cli` by [#600](https://github.com/eric-cielo/moflo/issues/600)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/guidance` workspace package no longer exists — its contents live at `src/modules/cli/src/guidance/` and ship inside the `moflo` tarball.

Long-horizon governance for Claude Code agents. Compiles `CLAUDE.md` / `CLAUDE.local.md` into a constitution + shards + manifest, enforces rules through hook gates, signs every decision via the proof envelope, and evolves the rule set with an A/B optimizer.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/modules/cli/src/guidance/` |
| Public surface | `src/modules/cli/src/guidance/index.ts` (sub-paths via `../guidance/<name>.js`) |
| WASM kernel (Rust) | `src/modules/cli/src/guidance/wasm-kernel/` |
| WASM artifacts | `src/modules/cli/src/guidance/wasm-pkg/` |
| Tests | `src/modules/cli/__tests__/guidance/` |
| Reviewer/coder agent prompts | `src/modules/cli/src/guidance/agents/` |
| ADRs (G001–G026) | [`docs/guidance/adrs/`](../guidance/adrs/) |
| Guides + tutorials | [`docs/guidance/`](../guidance/) |
| CLI commands | `claude-flow guidance {compile,retrieve,gates,status,optimize,ab-test}` |

## Core capabilities

- **Compile** — parse `CLAUDE.md` (+ optional `CLAUDE.local.md` overlay) into a `PolicyBundle` of constitution rules, shards, and a content-addressed manifest.
- **Retrieve** — vector-rank shards by detected task intent and inject the top-N + constitution into the agent's working context.
- **Gates** — destructive-ops, tool-allowlist, diff-size, and secrets enforcement. Hook-based so the model cannot bypass them.
- **Ledger + evaluators** — log every run with verdicts from `tests-pass`, `forbidden-deps`, `forbidden-commands`, `violation-rate`, `diff-quality`.
- **Optimizer** — weekly A/B loop that promotes winning local rules to root after two consecutive wins.
- **Proof chain** — Ed25519-signed decision envelopes with a deterministic `wasm-kernel` for parity-checked hashing.
- **Adversarial / authority / temporal / uncertainty / coherence** — supporting subsystems for trust accumulation, irreversibility classification, time-bound assertions, and economic-governor coherence scheduling.

## Internal usage

```ts
// From any cli source file:
const { GuidanceCompiler } = await import('../guidance/compiler.js');
const { ShardRetriever }   = await import('../guidance/retriever.js');
const { EnforcementGates } = await import('../guidance/gates.js');
const { analyze, abBenchmark } = await import('../guidance/analyzer.js');
```

The control plane has zero inbound `@moflo/*` dependents — only `cli` consumes it. The single outbound dependency on `@moflo/hooks` (registry types in `guidance/hooks.ts`) remains a workspace bare-specifier and dissolves when `@moflo/hooks` collapses.

## Why the rewrite

Pre-#600 framing claimed `@moflo/guidance` was a separately publishable npm package. It wasn't — `npm view @moflo/guidance` 404s, the workspace boundary was leftover ruvnet/ruflo-fork text. ADR-0001 captures the full reasoning; #600 collapses `guidance` as the next stop after `aidefence` (#590) and `embeddings` (#592).
