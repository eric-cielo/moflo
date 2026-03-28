/**
 * Workflow Runner
 *
 * Sequential executor that drives a parsed WorkflowDefinition step by step.
 */

import type {
  WorkflowContext,
  StepOutput,
  CredentialAccessor,
  MemoryAccessor,
  ValidationError,
} from '../types/step-command.types.js';
import type {
  WorkflowDefinition,
  StepDefinition,
} from '../types/workflow-definition.types.js';
import type {
  RunnerOptions,
  WorkflowResult,
  WorkflowError,
  StepResult,
  StepStatus,
  DryRunResult,
  DryRunStepReport,
} from '../types/runner.types.js';
import { StepCommandRegistry } from './step-command-registry.js';
import { interpolateConfig } from './interpolation.js';
import { validateWorkflowDefinition, resolveArguments } from '../schema/validator.js';

const DEFAULT_STEP_TIMEOUT = 300_000; // 5 minutes

interface ExecutionState {
  readonly variables: Record<string, unknown>;
  readonly resolvedArgs: Record<string, unknown>;
  readonly workflowId: string;
  readonly options: RunnerOptions;
  readonly credentialPatterns: RegExp[];
}

export class WorkflowRunner {
  constructor(
    private readonly registry: StepCommandRegistry,
    private readonly credentials: CredentialAccessor,
    private readonly memory: MemoryAccessor,
  ) {}

  /**
   * Execute a workflow definition with the given arguments.
   */
  async run(
    definition: WorkflowDefinition,
    args: Record<string, unknown>,
    options: RunnerOptions = {},
  ): Promise<WorkflowResult> {
    const startTime = Date.now();

    const defValidation = validateWorkflowDefinition(definition, {
      knownStepTypes: this.registry.types(),
    });
    const workflowId = options.workflowId ?? `wf-${Date.now()}`;

    if (!defValidation.valid) {
      return this.failureResult(workflowId, startTime, [{
        code: 'DEFINITION_VALIDATION_FAILED',
        message: 'Workflow definition is invalid',
        details: defValidation.errors,
      }]);
    }

    const { resolved: resolvedArgs, errors: argErrors } = resolveArguments(
      definition.arguments ?? {},
      args,
    );
    if (argErrors.length > 0) {
      return this.failureResult(workflowId, startTime, [{
        code: 'ARGUMENT_VALIDATION_FAILED',
        message: 'Argument validation failed',
        details: argErrors,
      }]);
    }

    if (options.dryRun) {
      const dryResult = await this.dryRunValidated(definition, resolvedArgs, defValidation, options);
      return {
        workflowId,
        success: dryResult.valid,
        steps: [],
        outputs: {},
        errors: dryResult.valid ? [] : [{
          code: 'DEFINITION_VALIDATION_FAILED',
          message: 'Dry-run validation failed',
          details: [
            ...dryResult.argumentErrors,
            ...dryResult.definitionErrors,
            ...dryResult.steps.flatMap(s => s.validationResult.errors),
          ],
        }],
        duration: Date.now() - startTime,
        cancelled: false,
      };
    }

    return this.executeSteps(definition, resolvedArgs, workflowId, options, startTime);
  }

  /**
   * Validate a workflow without executing it.
   * Reports what WOULD happen at each step.
   */
  async dryRun(
    definition: WorkflowDefinition,
    resolvedArgs: Record<string, unknown>,
    options: RunnerOptions = {},
  ): Promise<DryRunResult> {
    const defValidation = validateWorkflowDefinition(definition, {
      knownStepTypes: this.registry.types(),
    });
    return this.dryRunValidated(definition, resolvedArgs, defValidation, options);
  }

  private async dryRunValidated(
    definition: WorkflowDefinition,
    resolvedArgs: Record<string, unknown>,
    defValidation: { valid: boolean; errors: ValidationError[] },
    options: RunnerOptions,
  ): Promise<DryRunResult> {
    const argErrors: ValidationError[] = [];
    if (definition.arguments) {
      const { errors } = resolveArguments(definition.arguments, resolvedArgs);
      argErrors.push(...errors);
    }

    const workflowId = `dryrun-${Date.now()}`;
    const variables: Record<string, unknown> = {};
    const stepReports: DryRunStepReport[] = [];

    for (let i = 0; i < definition.steps.length; i++) {
      const step = definition.steps[i];
      const command = this.registry.get(step.type);

      let interpolatedConfig: Record<string, unknown> | null = null;
      let validationResult = { valid: true, errors: [] as ValidationError[] };

      if (command) {
        const context = this.buildContext(variables, resolvedArgs, workflowId, i, options.signal);
        try {
          interpolatedConfig = interpolateConfig(
            step.config as Record<string, unknown>,
            context,
          );
        } catch {
          interpolatedConfig = null;
          validationResult = {
            valid: false,
            errors: [{ path: `steps[${i}].config`, message: 'Variable interpolation failed' }],
          };
        }

        if (interpolatedConfig) {
          const vr = await command.validate(interpolatedConfig, context);
          validationResult = { valid: vr.valid, errors: [...vr.errors] };
        }

        if (step.output) {
          variables[step.output] = { _dryRun: true };
        }
      } else {
        validationResult = {
          valid: false,
          errors: [{ path: `steps[${i}].type`, message: `Unknown step type: "${step.type}"` }],
        };
      }

      stepReports.push({
        stepId: step.id,
        stepType: step.type,
        description: command?.description ?? 'unknown command',
        interpolatedConfig,
        validationResult,
        continueOnError: step.continueOnError ?? false,
        hasRollback: command?.rollback !== undefined,
      });
    }

    const allValid =
      defValidation.valid &&
      argErrors.length === 0 &&
      stepReports.every(s => s.validationResult.valid);

    return {
      valid: allValid,
      argumentErrors: argErrors,
      definitionErrors: defValidation.errors,
      steps: stepReports,
    };
  }

  // --------------------------------------------------------------------------
  // Private — Execution
  // --------------------------------------------------------------------------

  private async executeSteps(
    definition: WorkflowDefinition,
    resolvedArgs: Record<string, unknown>,
    workflowId: string,
    options: RunnerOptions,
    startTime: number,
  ): Promise<WorkflowResult> {
    const variables: Record<string, unknown> = {};
    const stepResults: StepResult[] = [];
    const errors: WorkflowError[] = [];
    const completedSteps: Array<{ step: StepDefinition; config: Record<string, unknown> }> = [];
    let cancelled = false;

    // Pre-compile credential patterns once for the entire run
    const credentialPatterns = (options.credentialValues ?? []).map(
      v => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    );

    const state: ExecutionState = { variables, resolvedArgs, workflowId, options, credentialPatterns };

    await this.storeProgress(workflowId, 'running', 0, definition.steps.length);

    // Build step-ID → index map for O(1) condition branching lookups
    const stepIndex = new Map<string, number>();
    for (let idx = 0; idx < definition.steps.length; idx++) {
      stepIndex.set(definition.steps[idx].id, idx);
    }

    // Guard against infinite loops from backward condition jumps
    const maxIterations = definition.steps.length * 10;
    let iterations = 0;

    for (let i = 0; i < definition.steps.length; i++) {
      if (++iterations > maxIterations) {
        errors.push({
          code: 'STEP_EXECUTION_FAILED',
          message: `Workflow exceeded maximum iterations (${maxIterations}); possible infinite condition loop`,
        });
        this.markRemainingSteps(definition, i, 'skipped', stepResults);
        break;
      }

      if (options.signal?.aborted) {
        cancelled = true;
        this.markRemainingSteps(definition, i, 'cancelled', stepResults);
        break;
      }

      const step = definition.steps[i];
      // TODO(#137): loop iteration — execute step.steps for each item in loop output
      const result = await this.executeStep(step, state, i);

      stepResults.push(result);

      if (result.status === 'succeeded' && result.output) {
        if (step.output) {
          variables[step.output] = result.output.data;
        }
        variables[step.id] = result.output.data;
        completedSteps.push({ step, config: result.interpolatedConfig ?? {} });

        // Condition branching: jump to the target step if nextStep is set
        const nextStep = result.output.data?.nextStep;
        if (typeof nextStep === 'string' && nextStep.length > 0) {
          const targetIdx = stepIndex.get(nextStep);
          if (targetIdx === undefined) {
            errors.push({
              stepId: step.id,
              code: 'CONDITION_TARGET_NOT_FOUND',
              message: `Condition step "${step.id}" targets step "${nextStep}" which does not exist`,
            });
            await this.rollbackSteps(completedSteps, state, stepResults);
            this.markRemainingSteps(definition, i + 1, 'skipped', stepResults);
            break;
          }
          // Jump: set i so the next loop increment lands on targetIdx
          i = targetIdx - 1;
        }
      }

      if (result.status === 'cancelled') {
        cancelled = true;
        this.markRemainingSteps(definition, i + 1, 'cancelled', stepResults);
        break;
      }

      if (result.status === 'failed') {
        errors.push({
          stepId: step.id,
          code: result.errorCode ?? 'STEP_EXECUTION_FAILED',
          message: result.error ?? 'Step failed',
        });

        if (!step.continueOnError) {
          await this.rollbackSteps(completedSteps, state, stepResults);
          this.markRemainingSteps(definition, i + 1, 'skipped', stepResults);
          break;
        }
      }

      await this.storeProgress(workflowId, 'running', stepResults.length, definition.steps.length);
      try { options.onStepComplete?.(result, i, definition.steps.length); } catch { /* callback errors must not crash the workflow */ }
    }

    if (cancelled) {
      if (completedSteps.length > 0) {
        await this.rollbackSteps(completedSteps, state, stepResults);
      }
      errors.push({ code: 'WORKFLOW_CANCELLED', message: 'Workflow was cancelled' });
    }

    const finalStatus = cancelled ? 'cancelled' : errors.length > 0 ? 'failed' : 'completed';
    await this.storeProgress(workflowId, finalStatus, stepResults.length, definition.steps.length);

    const outputs: Record<string, unknown> = {};
    for (const sr of stepResults) {
      if (sr.status === 'succeeded' && sr.output) {
        outputs[sr.stepId] = sr.output.data;
      }
    }

    return {
      workflowId,
      success: errors.length === 0 && !cancelled,
      steps: stepResults,
      outputs,
      errors,
      duration: Date.now() - startTime,
      cancelled,
    };
  }

  private async executeStep(
    step: StepDefinition,
    state: ExecutionState,
    index: number,
  ): Promise<StepResult & { interpolatedConfig?: Record<string, unknown> }> {
    const stepStart = Date.now();
    const command = this.registry.get(step.type);

    if (!command) {
      return {
        stepId: step.id,
        stepType: step.type,
        status: 'failed',
        error: `Unknown step type: "${step.type}"`,
        errorCode: 'UNKNOWN_STEP_TYPE',
        duration: Date.now() - stepStart,
      };
    }

    const context = this.buildContext(
      state.variables, state.resolvedArgs, state.workflowId, index, state.options.signal,
    );

    let interpolatedConfig: Record<string, unknown>;
    try {
      interpolatedConfig = interpolateConfig(
        step.config as Record<string, unknown>,
        context,
      );
    } catch (err) {
      return {
        stepId: step.id,
        stepType: step.type,
        status: 'failed',
        error: `Variable interpolation failed: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 'STEP_EXECUTION_FAILED',
        duration: Date.now() - stepStart,
      };
    }

    const validation = await command.validate(interpolatedConfig, context);
    if (!validation.valid) {
      return {
        stepId: step.id,
        stepType: step.type,
        status: 'failed',
        error: `Step validation failed: ${validation.errors.map(e => e.message).join('; ')}`,
        errorCode: 'STEP_VALIDATION_FAILED',
        duration: Date.now() - stepStart,
      };
    }

    const timeout = state.options.defaultStepTimeout ?? DEFAULT_STEP_TIMEOUT;
    let output: StepOutput;

    try {
      output = await this.executeWithTimeout(
        () => command.execute(interpolatedConfig, context),
        timeout,
        state.options.signal,
      );
    } catch (err) {
      const isCancelled = state.options.signal?.aborted;
      const isTimeout = err instanceof Error && err.message === 'Step timed out';

      return {
        stepId: step.id,
        stepType: step.type,
        status: isCancelled ? 'cancelled' : 'failed',
        error: err instanceof Error ? err.message : String(err),
        errorCode: isCancelled ? 'STEP_CANCELLED' : isTimeout ? 'STEP_TIMEOUT' : 'STEP_EXECUTION_FAILED',
        duration: Date.now() - stepStart,
      };
    }

    const maskedOutput = this.maskCredentials(output, state.credentialPatterns);

    if (!maskedOutput.success) {
      let rollbackAttempted = false;
      let rollbackError: string | undefined;

      if (command.rollback) {
        rollbackAttempted = true;
        try {
          await command.rollback(interpolatedConfig, context);
        } catch (rbErr) {
          rollbackError = rbErr instanceof Error ? rbErr.message : String(rbErr);
        }
      }

      return {
        stepId: step.id,
        stepType: step.type,
        status: 'failed',
        output: maskedOutput,
        error: maskedOutput.error ?? 'Step execution returned failure',
        errorCode: 'STEP_EXECUTION_FAILED',
        duration: Date.now() - stepStart,
        rollbackAttempted,
        rollbackError,
      };
    }

    return {
      stepId: step.id,
      stepType: step.type,
      status: 'succeeded',
      output: maskedOutput,
      duration: Date.now() - stepStart,
      interpolatedConfig,
    };
  }

  // --------------------------------------------------------------------------
  // Private — Rollback
  // --------------------------------------------------------------------------

  private async rollbackSteps(
    completedSteps: Array<{ step: StepDefinition; config: Record<string, unknown> }>,
    state: ExecutionState,
    stepResults: StepResult[],
  ): Promise<void> {
    for (let i = completedSteps.length - 1; i >= 0; i--) {
      const { step, config } = completedSteps[i];
      const command = this.registry.get(step.type);

      if (!command?.rollback) continue;

      const context = this.buildContext(
        state.variables, state.resolvedArgs, state.workflowId, i, state.options.signal,
      );
      try {
        await command.rollback(config, context);
        const idx = stepResults.findIndex(r => r.stepId === step.id);
        if (idx !== -1) {
          stepResults[idx] = { ...stepResults[idx], status: 'rolled_back', rollbackAttempted: true };
        }
      } catch (err) {
        const idx = stepResults.findIndex(r => r.stepId === step.id);
        if (idx !== -1) {
          stepResults[idx] = {
            ...stepResults[idx],
            rollbackAttempted: true,
            rollbackError: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Private — Helpers
  // --------------------------------------------------------------------------

  private markRemainingSteps(
    definition: WorkflowDefinition,
    fromIndex: number,
    status: StepStatus,
    stepResults: StepResult[],
  ): void {
    for (let j = fromIndex; j < definition.steps.length; j++) {
      stepResults.push({
        stepId: definition.steps[j].id,
        stepType: definition.steps[j].type,
        status,
        duration: 0,
      });
    }
  }

  private buildContext(
    variables: Record<string, unknown>,
    args: Record<string, unknown>,
    workflowId: string,
    stepIndex: number,
    signal?: AbortSignal,
  ): WorkflowContext {
    return {
      variables,
      args,
      credentials: this.credentials,
      memory: this.memory,
      taskId: `${workflowId}-step-${stepIndex}`,
      workflowId,
      stepIndex,
      abortSignal: signal,
    };
  }

  private executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('Step timed out'));
        }
      }, timeout);

      const onAbort = (): void => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('Step cancelled'));
        }
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      fn().then(
        (result) => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(result);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        },
      );
    });
  }

  private maskCredentials(output: StepOutput, patterns: RegExp[]): StepOutput {
    if (patterns.length === 0) return output;

    const serialized = JSON.stringify(output.data);
    let masked = serialized;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      masked = masked.replace(pattern, '***REDACTED***');
    }

    if (masked === serialized) return output;

    return {
      ...output,
      data: JSON.parse(masked) as Record<string, unknown>,
    };
  }

  private async storeProgress(
    workflowId: string,
    status: string,
    completedSteps: number,
    totalSteps: number,
  ): Promise<void> {
    try {
      await this.memory.write('tasklist', workflowId, {
        status,
        completedSteps,
        totalSteps,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Best-effort — don't fail the workflow for progress tracking
    }
  }

  private failureResult(workflowId: string, startTime: number, errors: WorkflowError[]): WorkflowResult {
    return {
      workflowId,
      success: false,
      steps: [],
      outputs: {},
      errors,
      duration: Date.now() - startTime,
      cancelled: false,
    };
  }
}
