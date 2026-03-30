/**
 * Workflow Runner
 *
 * Thin orchestrator that drives a parsed WorkflowDefinition step by step,
 * delegating step execution, validation, loop iteration, rollback,
 * credential masking, and timeout handling to focused modules.
 */

import type {
  WorkflowContext,
  CredentialAccessor,
  MemoryAccessor,
  MofloLevel,
} from '../types/step-command.types.js';
import type { WorkflowDefinition } from '../types/workflow-definition.types.js';
import type {
  RunnerOptions, WorkflowResult, WorkflowError,
  StepResult, StepStatus, DryRunResult,
} from '../types/runner.types.js';
import { StepCommandRegistry } from './step-command-registry.js';
import type { WorkflowConnectorRegistry } from '../registry/connector-registry.js';
import { ConnectorAccessorImpl } from './connector-accessor.js';
import { validateWorkflowDefinition, resolveArguments } from '../schema/validator.js';
import { compareMofloLevels } from './capability-validator.js';
import { DEFAULT_MAX_NESTING_DEPTH } from '../types/step-command.types.js';
import { dryRunValidate } from './dry-run-validator.js';
import { executeLoopIterations } from './loop-executor.js';
import { rollbackSteps, type CompletedStep } from './rollback-orchestrator.js';
import { buildCredentialPatterns, addCredentialPattern, collectCredentialNames } from './credential-masker.js';
import { executeSingleStep, type StepExecutionState } from './step-executor.js';
import { collectPrerequisites, checkPrerequisites, formatPrerequisiteErrors } from './prerequisite-checker.js';

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
      }]);
    }

    if (options.parentMofloLevel && definition.mofloLevel) {
      if (compareMofloLevels(definition.mofloLevel, options.parentMofloLevel) > 0) {
        return this.failureResult(workflowId, startTime, [{
          code: 'MOFLO_LEVEL_DENIED',
          message: `Nested workflow mofloLevel "${definition.mofloLevel}" exceeds parent level "${options.parentMofloLevel}"`,
        }]);
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
      }]);
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
          }]);
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

    await this.storeProgress(workflowId, 'running', 0, definition.steps.length);

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
      const result = await this.runStep(step, state, i);
      stepResults.push(result);

      if (result.status === 'succeeded' && result.output) {
        if (step.output) variables[step.output] = result.output.data;
        variables[step.id] = result.output.data;
        completedSteps.push({ step, config: result.interpolatedConfig ?? {} });

        if (step.type === 'loop' && step.steps && step.steps.length > 0) {
          const loopResult = await executeLoopIterations(
            step, result.output, state.variables, errors, state.options.signal,
            (nested, s) => this.runStep(nested, state, s),
          );
          const loopData = { ...result.output.data, iterationOutputs: loopResult.outputs };
          if (step.output) variables[step.output] = loopData;
          variables[step.id] = loopData;

          if (!loopResult.success && !step.continueOnError) {
            await this.doRollback(completedSteps, state, stepResults);
            this.markRemaining(definition, i + 1, 'skipped', stepResults);
            break;
          }
        }

        const nextStep = result.output.data?.nextStep;
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

      await this.storeProgress(workflowId, 'running', stepResults.length, definition.steps.length);
      try { options.onStepComplete?.(result, i, definition.steps.length); } catch { /* safe */ }
    }

    if (cancelled) {
      if (completedSteps.length > 0) await this.doRollback(completedSteps, state, stepResults);
      errors.push({ code: 'WORKFLOW_CANCELLED', message: 'Workflow was cancelled' });
    }

    const finalStatus = cancelled ? 'cancelled' : errors.length > 0 ? 'failed' : 'completed';
    await this.storeProgress(workflowId, finalStatus, stepResults.length, definition.steps.length);

    const outputs: Record<string, unknown> = {};
    for (const sr of stepResults) {
      if (sr.status === 'succeeded' && sr.output) {
        outputs[sr.stepId] = variables[sr.stepId] ?? sr.output.data;
      }
    }

    return { workflowId, success: errors.length === 0 && !cancelled,
      steps: stepResults, outputs, errors, duration: Date.now() - startTime, cancelled };
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
      ...(this.connectorAccessor ? { tools: this.connectorAccessor } : {}) };
  }

  private async storeProgress(wfId: string, status: string, done: number, total: number) {
    try {
      await this.memory.write('tasklist', wfId, {
        status, completedSteps: done, totalSteps: total, updatedAt: new Date().toISOString(),
      });
    } catch { /* Best-effort */ }
  }

  private failureResult(workflowId: string, startTime: number, errors: WorkflowError[]): WorkflowResult {
    return { workflowId, success: false, steps: [], outputs: {}, errors,
      duration: Date.now() - startTime, cancelled: false };
  }
}
