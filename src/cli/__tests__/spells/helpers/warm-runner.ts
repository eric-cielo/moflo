/**
 * Shared warm-up for spell-runner tests.
 *
 * The first `SpellCaster.run()` in a fresh worker fork pays a ~500 ms
 * cold-start tax: platform-sandbox detection (`_cachedDetection` in
 * `platform-sandbox.ts`), validator, prereq-checker, step-executor and
 * adjacent caches all wake up. Once warm, subsequent runs in the same
 * worker complete in <2 ms.
 *
 * Test files that run multiple spells should call this in `beforeAll`
 * so the cold-start tax is paid against vitest's 10 s `beforeAll`
 * ceiling rather than the 5 s per-test ceiling — which is what tipped
 * the first test over the line under fork contention (#1093, #1102).
 *
 * The helper creates its own throwaway registry, so it does not touch
 * the caller's registry or credential state. Pass whatever
 * `CredentialAccessor`/`MemoryAccessor` the test file already has — a
 * real store works, a mock works, neither is exercised by the warm-up
 * spell (it has no prerequisites).
 */

import { SpellCaster } from '../../../spells/core/runner.js';
import { StepCommandRegistry } from '../../../spells/core/step-command-registry.js';
import type {
  StepCommand,
  CredentialAccessor,
  MemoryAccessor,
} from '../../../spells/types/step-command.types.js';

export async function warmRunnerPipeline(
  credentials: CredentialAccessor,
  memory: MemoryAccessor,
): Promise<void> {
  const registry = new StepCommandRegistry();
  const warmCmd: StepCommand = {
    type: '__warmup__',
    description: 'pre-warm sandbox detection + runner pipeline',
    configSchema: { type: 'object' as const },
    validate: () => ({ valid: true, errors: [] }),
    async execute() {
      return { success: true, data: {}, duration: 0 };
    },
    describeOutputs: () => [],
  };
  registry.register(warmCmd);
  const runner = new SpellCaster(registry, credentials, memory);
  await runner.run(
    { name: 'warmup', steps: [{ id: 'w', type: '__warmup__', config: {} }] },
    {},
  );
}
