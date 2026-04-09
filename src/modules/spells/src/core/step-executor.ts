/**
 * Step Executor
 *
 * Executes a single spell step: credential scoping, interpolation,
 * validation, capability checks, timeout, and credential masking.
 * Extracted from SpellCaster (Issue #182).
 */

import type {
  CastingContext,
  StepOutput,
  CredentialAccessor,
  MemoryAccessor,
  MofloLevel,
} from '../types/step-command.types.js';
import type { StepDefinition } from '../types/spell-definition.types.js';
import type {
  RunnerOptions,
  StepResult,
} from '../types/runner.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';
import { interpolateConfig } from './interpolation.js';
import {
  checkCapabilities,
  formatViolations,
  resolveMofloLevel,
} from './capability-validator.js';
import {
  maskCredentials,
  collectCredentialNames,
  stepReferencesCredentials,
  stepHasCredentialCapability,
} from './credential-masker.js';
import { executeWithTimeout } from './timeout-executor.js';
import { CapabilityGateway } from './capability-gateway.js';
import { GatedConnectorAccessor } from './gated-connector-accessor.js';

const DEFAULT_STEP_TIMEOUT = 300_000; // 5 minutes

export interface StepExecutionState {
  variables: Record<string, unknown>;
  readonly resolvedArgs: Record<string, unknown>;
  readonly spellId: string;
  readonly options: RunnerOptions;
  readonly credentialPatterns: RegExp[];
  readonly resolvedCredentials: Record<string, unknown>;
  readonly spellMofloLevel: MofloLevel | undefined;
  readonly parentMofloLevel: MofloLevel | undefined;
  readonly nestingDepth: number;
  readonly maxNestingDepth: number;
}

/**
 * Execute a single step within the spell, handling credential scoping,
 * interpolation, validation, capability checks, timeout, and masking.
 */
export async function executeSingleStep(
  step: StepDefinition,
  state: StepExecutionState,
  index: number,
  registry: StepCommandRegistry,
  buildContext: (
    variables: Record<string, unknown>, args: Record<string, unknown>,
    spellId: string, stepIndex: number, signal?: AbortSignal,
  ) => CastingContext,
): Promise<StepResult & { interpolatedConfig?: Record<string, unknown> }> {
  const stepStart = Date.now();
  const command = registry.get(step.type);

  if (!command) {
    return { stepId: step.id, stepType: step.type, status: 'failed',
      error: `Unknown step type: "${step.type}"`, errorCode: 'UNKNOWN_STEP_TYPE',
      duration: Date.now() - stepStart };
  }

  if (stepReferencesCredentials(step) && !stepHasCredentialCapability(step, command)) {
    return { stepId: step.id, stepType: step.type, status: 'failed',
      error: 'Step references {credentials.*} but does not declare the "credentials" capability',
      errorCode: 'CAPABILITY_DENIED', duration: Date.now() - stepStart };
  }

  // Scope credentials per-step (#159)
  const stepCredNames = collectCredentialNames([step]);
  const stepVariables = { ...state.variables };
  if (stepCredNames.size > 0 && stepHasCredentialCapability(step, command)) {
    const scopedCreds: Record<string, unknown> = {};
    for (const name of stepCredNames) {
      if (name in state.resolvedCredentials) scopedCreds[name] = state.resolvedCredentials[name];
    }
    stepVariables.credentials = scopedCreds;
  }

  const context = buildContext(
    stepVariables, state.resolvedArgs, state.spellId, index, state.options.signal,
  );

  let interpolatedConfig: Record<string, unknown>;
  try {
    interpolatedConfig = interpolateConfig(step.config as Record<string, unknown>, context);
  } catch (err) {
    return { stepId: step.id, stepType: step.type, status: 'failed',
      error: `Variable interpolation failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'STEP_EXECUTION_FAILED', duration: Date.now() - stepStart };
  }

  const validation = await command.validate(interpolatedConfig, context);
  if (!validation.valid) {
    return { stepId: step.id, stepType: step.type, status: 'failed',
      error: `Step validation failed: ${validation.errors.map(e => e.message).join('; ')}`,
      errorCode: 'STEP_VALIDATION_FAILED', duration: Date.now() - stepStart };
  }

  const capCheck = checkCapabilities(step, command);
  if (!capCheck.allowed) {
    return { stepId: step.id, stepType: step.type, status: 'failed',
      error: `Capability violation: ${formatViolations(capCheck.violations)}`,
      errorCode: 'CAPABILITY_DENIED', duration: Date.now() - stepStart };
  }

  const resolvedLevel = resolveMofloLevel(step, command, state.spellMofloLevel, state.parentMofloLevel);

  if (resolvedLevel === 'recursive' && state.nestingDepth >= state.maxNestingDepth) {
    return { stepId: step.id, stepType: step.type, status: 'failed',
      error: `Recursive spell nesting depth ${state.nestingDepth} exceeds maximum ${state.maxNestingDepth}`,
      errorCode: 'MOFLO_LEVEL_DENIED', duration: Date.now() - stepStart };
  }

  const gateway = new CapabilityGateway(capCheck.effectiveCaps, `${state.spellId}-step-${index}`, step.type);

  const scopedContext = {
    ...context, effectiveCaps: capCheck.effectiveCaps, gateway,
    mofloLevel: resolvedLevel, nestingDepth: state.nestingDepth, maxNestingDepth: state.maxNestingDepth,
    // Wrap connector accessor with gateway enforcement (#265)
    tools: context.tools ? new GatedConnectorAccessor(context.tools, gateway) : undefined,
  };

  // Respect step-level timeout (e.g. bash config.timeout) over global default
  const stepTimeout = (interpolatedConfig as { timeout?: number }).timeout;
  const timeout = stepTimeout ?? state.options.defaultStepTimeout ?? DEFAULT_STEP_TIMEOUT;
  let output: StepOutput;

  try {
    output = await executeWithTimeout(
      () => command.execute(interpolatedConfig, scopedContext), timeout, state.options.signal,
    );
  } catch (err) {
    const isCancelled = state.options.signal?.aborted;
    const isTimeout = err instanceof Error && err.message === 'Step timed out';
    return { stepId: step.id, stepType: step.type,
      status: isCancelled ? 'cancelled' : 'failed',
      error: err instanceof Error ? err.message : String(err),
      errorCode: isCancelled ? 'STEP_CANCELLED' : isTimeout ? 'STEP_TIMEOUT' : 'STEP_EXECUTION_FAILED',
      duration: Date.now() - stepStart };
  }

  const maskedOutput = maskCredentials(output, state.credentialPatterns);

  if (!maskedOutput.success) {
    let rollbackAttempted = false;
    let rollbackError: string | undefined;
    if (command.rollback) {
      rollbackAttempted = true;
      try { await command.rollback(interpolatedConfig, context); }
      catch (rbErr) { rollbackError = rbErr instanceof Error ? rbErr.message : String(rbErr); }
    }
    return { stepId: step.id, stepType: step.type, status: 'failed', output: maskedOutput,
      error: maskedOutput.error ?? 'Step execution returned failure',
      errorCode: 'STEP_EXECUTION_FAILED', duration: Date.now() - stepStart,
      rollbackAttempted, rollbackError };
  }

  return { stepId: step.id, stepType: step.type, status: 'succeeded',
    output: maskedOutput, duration: Date.now() - stepStart, interpolatedConfig };
}
