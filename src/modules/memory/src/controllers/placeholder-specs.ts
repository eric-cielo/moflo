/**
 * Placeholder specs for controllers that exist in the type union but have
 * no implementation today. Explicit enablement via
 * `config.controllers.<name> = true` lets consumers probe whether they are
 * wired up yet; until they are, `create` returns `null` and the registry
 * marks them unavailable.
 */

import type { ControllerSpec } from '../controller-spec.js';

export const hybridSearchSpec: ControllerSpec = {
  name: 'hybridSearch',
  level: 1,
  enabledByDefault: false,
  // BM25 hybrid search — not implemented yet.
  create: () => null,
};

export const agentMemoryScopeSpec: ControllerSpec = {
  name: 'agentMemoryScope',
  level: 2,
  enabledByDefault: false,
  // Agent memory scope — activated when explicitly enabled.
  create: () => null,
};
