# cli/neural

> **Inlined into `@moflo/cli` by [#598](https://github.com/eric-cielo/moflo/issues/598)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/neural` workspace package no longer exists — its contents live at `src/modules/cli/src/neural/` and ship inside the `moflo` tarball.

The Self-Optimizing Neural Architecture (SONA) module: trajectory tracking, pattern learning, ReasoningBank with HNSW-backed vector storage, and 9 RL algorithms (PPO, A2C, DQN, Q-Learning, SARSA, Decision Transformer, etc.). Provides 5 learning modes (real-time, balanced, research, edge, batch) and `NeuralLearningSystem` as the integrated entry point.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/modules/cli/src/neural/` |
| Public surface | `src/modules/cli/src/neural/index.ts` (re-exports SONA, ReasoningBank, PatternLearner, modes, algorithms) |
| Integrated system | `src/modules/cli/src/neural/sona-integration.ts`, `index.ts` (`NeuralLearningSystem`) |
| SONA engine | `src/modules/cli/src/neural/sona-engine.ts`, `sona-manager.ts` |
| ReasoningBank | `src/modules/cli/src/neural/reasoning-bank.ts`, `reasoningbank-adapter.ts` |
| Pattern learning | `src/modules/cli/src/neural/pattern-learner.ts` |
| Modes | `src/modules/cli/src/neural/modes/` (real-time, balanced, research, edge, batch) |
| Algorithms | `src/modules/cli/src/neural/algorithms/` |
| Domain types | `src/modules/cli/src/neural/types.ts`, `domain/` |
| Tests | `src/modules/cli/__tests__/neural/` |

## Internal usage

The cli imports neural via direct relative paths (no `@moflo/neural` bare specifier, no walk-up resolver inside cli):

```ts
// From cli source (e.g. cli/src/memory/learning-bridge.ts):
import { NeuralLearningSystem } from '../neural/index.js';

// From cli/src/commands/doctor.ts:
const neural = await import('../neural/index.js');
```

The `cli/src/neural/reasoning-bank.ts` ↔ `cli/src/memory/learning-bridge.ts` SCC that previously required guarded dynamic imports across the package boundary collapses to plain sibling imports — no try/catch fallback, no shape-check probe.

There are no external-package consumers of neural after collapse: `hooks` reaches MofloDb / HNSWIndex via memory's walk-up resolver, not neural. Production callers verified via `scripts/analyze-collapse-deps.mjs` before the move.
