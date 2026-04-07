/**
 * Workflow Runner
 *
 * Thin orchestrator that drives a parsed WorkflowDefinition step by step,
 * delegating step execution, validation, loop iteration, rollback,
 * credential masking, and timeout handling to focused modules.
 */

export const ENGINE_VERSION = '1.0.0';

import type {
  WorkflowContext,
  StepOutput,
  CredentialAccessor,
  MemoryAccessor,
  MofloLevel,
} from '../types/step-command.types.js';
import type { WorkflowDefinition } from '../types/workflow-definition.types.js';
import type {
  RunnerOptions, WorkflowResult, WorkflowError,
  StepResult, StepStatus, DryRunResult, FloRunContext,
} from '../types/runner.types.js';
import { StepCommandRegistry } from './step-command-registry.js';
import type { WorkflowConnectorRegistry } from '../registry/connector-registry.js';
import { ConnectorAccessorImpl } from './connector-accessor.js';
import { validateWorkflowDefinition, resolveArguments } from '../schema/validator.js';
import { compareMofloLevels } from './capability-validator.js';
import { DEFAULT_MAX_NESTING_DEPTH } from '../types/step-command.types.js';
import { dryRunValidate } from './dry-run-validator.js';
import { executeLoopIterations } from './loop-executor.js';
import { executeParallelSteps } from './parallel-executor.js';
import { rollbackSteps, type CompletedStep } from './rollback-orchestrator.js';
import { buildCredentialPatterns, addCredentialPattern, collectCredentialNames } from './credential-masker.js';
import { executeSingleStep, type StepExecutionState } from './step-executor.js';
import { collectPrerequisites, checkPrerequisites, formatPrerequisiteErrors } from './prerequisite-checker.js';
import { DENY_ALL_GATEWAY } from './capability-gateway.js';

export class WorkflowRunner {
  private readonly connectorAccessor?: ConnectorAccessorImpl;

  constructor(
    private readonly registry: StepCommandRegistry,
    private readonly credentials: CredentialAccessor,
    private readonly memory: MemoryAccessor,
    private readonly connectorRegistry?: WorkflowConnectorRegistry,
  ) {
    if (connectorRegistry) {
      this.connectorAccessor = new ConnectorAccessorImpl(connectorRegistry);
    }
  }

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
      }], definition.name);
    }

    if (options.parentMofloLevel && definition.mofloLevel) {
      if (compareMofloLevels(definition.mofloLevel, options.parentMofloLevel) > 0) {
        return this.failureResult(workflowId, startTime, [{
          code: 'MOFLO_LEVEL_DENIED',
          message: `Nested workflow mofloLevel "${definition.mofloLevel}" exceeds parent level "${options.parentMofloLevel}"`,
        }], definition.name);
      }
    }

    const { resolved: resolvedArgs, errors: argErrors } = resolveArguments(
      definition.arguments ?? {}, args,
    );
    if (argErrors.length > 0) {
      return this.failureResult(workflowId, startTime, [{
        code: 'ARGUMENT_VALIDATION_FAILED',
        message: 'Argument validation failed',
        details: argErrors,
      }], definition.name);
    }

    // Pre-flight prerequisite checks (Story #193)
    if (!options.dryRun) {
      const prerequisites = collectPrerequisites(definition, this.registry);
      if (prerequisites.length > 0) {
        const prereqResults = await checkPrerequisites(prerequisites);
        if (prereqResults.some(r => !r.satisfied)) {
          return this.failureResult(workflowId, startTime, [{
            code: 'PREREQUISITES_FAILED',
            message: formatPrerequisiteErrors(prereqResults),
          }], definition.name);
        }
      }
    }

    if (options.dryRun) {
      const dryResult = await dryRunValidate(
        definition, resolvedArgs, defValidation, options, this.registry,
        (variables, wfId, stepIndex) =>
          this.buildContext(variables, resolvedArgs, wfId, stepIndex, options.signal),
      );
      return {
        workflowId, success: dryResult.valid, steps: [], outputs: {},
        errors: dryResult.valid ? [] : [{
          code: 'DEFINITION_VALIDATION_FAILED',
          message: 'Dry-run validation failed',
          details: [
            ...dryResult.argumentErrors, ...dryResult.definitionErrors,
            ...dryResult.steps.flatMap(s => s.validationResult.errors),
          ],
        }],
        duration: Date.now() - startTime, cancelled: false,
      };
    }

    return this.executeSteps(definition, resolvedArgs, workflowId, options, startTime);
  }

  async dryRun(
    definition: WorkflowDefinition,
    resolvedArgs: Record<string, unknown>,
    options: RunnerOptions = {},
  ): Promise<DryRunResult> {
    const defValidation = validateWorkflowDefinition(definition, {
      knownStepTypes: this.registry.types(),
    });
    return dryRunValidate(
      definition, resolvedArgs, defValidation, options, this.registry,
      (variables, wfId, stepIndex) =>
        this.buildContext(variables, resolvedArgs, wfId, stepIndex, options.signal),
    );
  }

  // --------------------------------------------------------------------------
  // Private — Step Loop
  // --------------------------------------------------------------------------

  private async executeSteps(
    definition: WorkflowDefinition, resolvedArgs: Record<string, unknown>,
    workflowId: string, options: RunnerOptions, startTime: number,
  ): Promise<WorkflowResult> {
    const context = options.context;
    const variables: Record<string, unknown> = { ...options.initialVariables };
    const stepResults: StepResult[] = [];
    const errors: WorkflowError[] = [];
    const completedSteps: CompletedStep[] = [];
    let cancelled = false;

    const credentialPatterns = buildCredentialPatterns(options.credentialValues ?? []);
    const credentialNames = collectCredentialNames(definition.steps);
    const resolvedCredentials: Record<string, unknown> = {};
    if (credentialNames.size > 0) {
      await Promise.all([...credentialNames].map(async (name) => {
        const value = await this.credentials.get(name);
        if (value !== undefined) {
          resolvedCredentials[name] = value;
          addCredentialPattern(credentialPatterns, value);
        }
      }));
    }

    const state: StepExecutionState = {
      variables, resolvedArgs, workflowId, options,
      credentialPatterns, resolvedCredentials,
      workflowMofloLevel: definition.mofloLevel,
      parentMofloLevel: options.parentMofloLevel,
      nestingDepth: options.nestingDepth ?? 0,
      maxNestingDepth: options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH,
    };

    try {
    await this.storeProgress(workflowId, 'running', 0, definition.steps.length, {
      workflowName: definition.name, startedAt: startTime, context,
    });

    const stepIndex = new Map<string, number>();
    for (let idx = 0; idx < definition.steps.length; idx++) {
      stepIndex.set(definition.steps[idx].id, idx);
    }

    const maxIterations = definition.steps.length * 10;
    let iterations = 0;

    for (let i = 0; i < definition.steps.length; i++) {
      if (++iterations > maxIterations) {
        errors.push({ code: 'STEP_EXECUTION_FAILED',
          message: `Workflow exceeded maximum iterations (${maxIterations}); possible infinite condition loop` });
        this.markRemaining(definition, i, 'skipped', stepResults);
        break;
      }

      if (options.signal?.aborted) {
        cancelled = true;
        this.markRemaining(definition, i, 'cancelled', stepResults);
        break;
      }

      const step = definition.steps[i];
      console.log(`[workflow] Step ${i + 1}/${definition.steps.length}: starting "${step.id}" [${step.type}]`);
      let result = await this.runStep(step, state, i);
      const resultIdx = stepResults.length;
      stepResults.push(result);

      if (result.status === 'succeeded' && result.output) {
        if (step.output) variables[step.output] = result.output.data;
        variables[step.id] = result.output.data;
        completedSteps.push({ step, config: result.interpolatedConfig ?? {} });

        if (step.type === 'loop' && step.steps && step.steps.length > 0) {
          const loopStart = Date.now();
          const loopResult = await executeLoopIterations(
            step, result.output, state.variables, errors, state.options.signal,
            (nested, s) => this.runStep(nested, state, s),
          );
          result = { ...result, duration: result.duration + (Date.now() - loopStart) };
          stepResults[resultIdx] = result;
          const loopData = { ...(result.output as StepOutput).data, iterationOutputs: loopResult.outputs };
          if (step.output) variables[step.output] = loopData;
          variables[step.id] = loopData;

          if (!loopResult.success && !step.continueOnError) {
            await this.doRollback(completedSteps, state, stepResults);
            this.markRemaining(definition, i + 1, 'skipped', stepResults);
            break;
          }
        }

        if (step.type === 'parallel' && step.steps && step.steps.length > 0) {
          const parallelStart = Date.now();
          const parallelResult = await executeParallelSteps(
            step, result.output as StepOutput, state.variables, errors, state.options.signal,
            (nested, s) => this.runStep(nested, state, s),
          );
          result = { ...result, duration: result.duration + (Date.now() - parallelStart) };
          stepResults[resultIdx] = result;
          const parallelData = { ...(result.output as StepOutput).data, stepOutputs: parallelResult.outputs };
          if (step.output) variables[step.output] = parallelData;
          variables[step.id] = parallelData;

          if (!parallelResult.success && !step.continueOnError) {
            await this.doRollback(completedSteps, state, stepResults);
            this.markRemaining(definition, i + 1, 'skipped', stepResults);
            break;
          }
        }

        const nextStep = (result.output as StepOutput).data?.nextStep;
        if (typeof nextStep === 'string' && nextStep.length > 0) {
          const targetIdx = stepIndex.get(nextStep);
          if (targetIdx === undefined) {
            errors.push({ stepId: step.id, code: 'CONDITION_TARGET_NOT_FOUND',
              message: `Condition step "${step.id}" targets step "${nextStep}" which does not exist` });
            await this.doRollback(completedSteps, state, stepResults);
            this.markRemaining(definition, i + 1, 'skipped', stepResults);
            break;
          }
          i = targetIdx - 1;
        }
      }

      // Fire onStepComplete for every step (success, failure, cancelled)
      console.log(`[workflow] Step ${i + 1}/${definition.steps.length}: ${result.status} "${step.id}" (${result.duration}ms)${result.error ? ' — ' + result.error.slice(0, 200) : ''}`);
      await this.storeProgress(workflowId, 'running', stepResults.length, definition.steps.length, {
        workflowName: definition.name, startedAt: startTime, steps: stepResults, context,
      });
      try { options.onStepComplete?.(result, i, definition.steps.length); } catch { /* safe */ }

      if (result.status === 'cancelled') {
        cancelled = true;
        this.markRemaining(definition, i + 1, 'cancelled', stepResults);
        break;
      }

      if (result.status === 'failed') {
        errors.push({ stepId: step.id, code: result.errorCode ?? 'STEP_EXECUTION_FAILED',
          message: result.error ?? 'Step failed' });
        if (!step.continueOnError) {
          await this.doRollback(completedSteps, state, stepResults);
          this.markRemaining(definition, i + 1, 'skipped', stepResults);
          break;
        }
      }
    }

    if (cancelled) {
      if (completedSteps.length > 0) await this.doRollback(completedSteps, state, stepResults);
      errors.push({ code: 'WORKFLOW_CANCELLED', message: 'Workflow was cancelled' });
    }

    const finalStatus = cancelled ? 'cancelled' : errors.length > 0 ? 'failed' : 'completed';
    await this.storeProgress(workflowId, finalStatus, stepResults.length, definition.steps.length, {
      workflowName: definition.name, startedAt: startTime, errors, steps: stepResults, context,
    });

    const outputs: Record<string, unknown> = {};
    for (const sr of stepResults) {
      if (sr.status === 'succeeded' && sr.output) {
        outputs[sr.stepId] = variables[sr.stepId] ?? sr.output.data;
      }
    }

    return { workflowId, success: errors.length === 0 && !cancelled,
      steps: stepResults, outputs, errors, duration: Date.now() - startTime, cancelled };
    } finally {
      // Dispose any connectors that were lazily initialized during step execution
      if (this.connectorAccessor) {
        await this.connectorAccessor.disposeAll();
      }
    }
  }

  // --------------------------------------------------------------------------
  // Private — Helpers
  // --------------------------------------------------------------------------

  private runStep(
    step: import('../types/workflow-definition.types.js').StepDefinition,
    state: StepExecutionState, index: number,
  ) {
    return executeSingleStep(step, state, index, this.registry, this.buildContext.bind(this));
  }

  private async doRollback(completed: CompletedStep[], state: StepExecutionState, results: StepResult[]) {
    await rollbackSteps(completed, this.registry,
      (i) => this.buildContext(state.variables, state.resolvedArgs, state.workflowId, i, state.options.signal),
      results);
  }

  private markRemaining(def: WorkflowDefinition, from: number, status: StepStatus, results: StepResult[]) {
    for (let j = from; j < def.steps.length; j++) {
      results.push({ stepId: def.steps[j].id, stepType: def.steps[j].type, status, duration: 0 });
    }
  }

  private buildContext(
    variables: Record<string, unknown>, args: Record<string, unknown>,
    workflowId: string, stepIndex: number, signal?: AbortSignal,
  ): WorkflowContext {
    return { variables, args, credentials: this.credentials, memory: this.memory,
      taskId: `${workflowId}-step-${stepIndex}`, workflowId, stepIndex, abortSignal: signal,
      gateway: DENY_ALL_GATEWAY,
      ...(this.connectorAccessor ? { tools: this.connectorAccessor } : {}) };
  }

  private async storeProgress(
    wfId: string, status: string, done: number, total: number,
    extra?: { workflowName?: string; startedAt?: number; errors?: WorkflowError[]; steps?: StepResult[]; context?: FloRunContext },
  ) {
    try {
      const now = Date.now();
      const record: Record<string, unknown> = {
        status, completedSteps: done, totalSteps: total, updatedAt: new Date().toISOString(),
      };
      if (extra?.workflowName) record.workflowName = extra.workflowName;
      if (extra?.context) record.context = extra.context;
      if (extra?.startedAt) {
        record.startedAt = extra.startedAt;
        record.duration = now - extra.startedAt;
      }
      // Map status to boolean success for dashboard compatibility
      if (status === 'completed') record.success = true;
      else if (status === 'failed') record.success = false;
      else if (status === 'cancelled') record.success = false;
      // Include error summary on terminal states
      if (extra?.errors && extra.errors.length > 0 && (status === 'failed' || status === 'cancelled')) {
        record.error = extra.errors.map(e => e.message).join('; ');
      }
      // Include per-step results for dashboard diagnostics
      if (extra?.steps && extra.steps.length > 0) {
        record.steps = extra.steps.map(s => ({
          stepId: s.stepId, stepType: s.stepType, status: s.status,
          duration: s.duration, error: s.error,
        }));
      }
      await this.memory.write('tasklist', wfId, record);
    } catch (err) {
      console.warn(`[workflow] storeProgress(${wfId}, ${status}) failed: ${(err as Error).message ?? err}`);
    }
  }

  private async failureResult(workflowId: string, startTime: number, errors: WorkflowError[], workflowName?: string): Promise<WorkflowResult> {
    await this.storeProgress(workflowId, 'failed', 0, 0, {
      workflowName, startedAt: startTime, errors,
    });
    return { workflowId, success: false, steps: [], outputs: {}, errors,
      duration: Date.now() - startTime, cancelled: false };
  }
}
