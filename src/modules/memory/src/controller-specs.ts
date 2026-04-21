/**
 * Central controller registration list. Adding a controller means:
 *   1. Create a new controller file under `./controllers/`
 *   2. Export a `<name>Spec: ControllerSpec` from it
 *   3. Add the spec to `CONTROLLER_SPECS` below
 *
 * The registry ({@link ./controller-registry.ts}) iterates this list in
 * level order — no switch-on-name.
 */

import type { ControllerSpec } from './controller-spec.js';

import { learningBridgeSpec } from './learning-bridge.js';
import { memoryGraphSpec } from './memory-graph.js';
import { tieredCacheSpec } from './cache-manager.js';

import { skillsSpec } from './controllers/skills.js';
import { reflexionSpec } from './controllers/reflexion.js';
import { causalGraphSpec } from './controllers/causal-graph.js';
import { learningSystemSpec } from './controllers/learning-system.js';
import { nightlyLearnerSpec } from './controllers/nightly-learner.js';
import { mutationGuardSpec } from './controllers/mutation-guard.js';
import { attestationLogSpec } from './controllers/attestation-log.js';
import { batchOperationsSpec } from './controllers/batch-operations.js';
import { contextSynthesizerSpec } from './controllers/context-synthesizer.js';
import { semanticRouterSpec } from './controllers/semantic-router.js';
import { hierarchicalMemorySpec } from './controllers/hierarchical-memory.js';
import { memoryConsolidationSpec } from './controllers/memory-consolidation.js';
import { hybridSearchSpec, agentMemoryScopeSpec } from './controllers/placeholder-specs.js';

export const CONTROLLER_SPECS: readonly ControllerSpec[] = [
  // Level 1 — core intelligence
  learningBridgeSpec,
  tieredCacheSpec,
  hierarchicalMemorySpec,
  hybridSearchSpec,
  // Level 2 — graph & security
  memoryGraphSpec,
  mutationGuardSpec,
  agentMemoryScopeSpec,
  // Level 3 — specialization
  skillsSpec,
  reflexionSpec,
  attestationLogSpec,
  batchOperationsSpec,
  memoryConsolidationSpec,
  // Level 4 — causal & routing
  causalGraphSpec,
  learningSystemSpec,
  nightlyLearnerSpec,
  semanticRouterSpec,
  // Level 5 — advanced services
  contextSynthesizerSpec,
];
