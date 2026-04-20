/**
 * Spell Runner
 *
 * Thin orchestrator that drives a parsed SpellDefinition step by step,
 * delegating step execution, validation, loop iteration, rollback,
 * credential masking, and timeout handling to focused modules.
 */
import type {
  CastingContext,
  StepOutput,
  CredentialAccessor,
  MemoryAccessor,
  MofloLevel,
} from '../types/step-command.types.js';
import type { SpellDefinition } from '../types/spell-definition.types.js';
import type {
  RunnerOptions, SpellResult, SpellError,
  StepResult, StepStatus, DryRunResult, FloRunContext,
} from '../types/runner.types.js';
import { StepCommandRegistry } from './step-command-registry.js';
import type { SpellConnectorRegistry } from '../registry/connector-registry.js';
import { ConnectorAccessorImpl } from './connector-accessor.js';
import { validateSpellDefinition, resolveArguments } from '../schema/validator.js';
import { compareMofloLevels } from './capability-validator.js';
import { DEFAULT_MAX_NESTING_DEPTH } from '../types/step-command.types.js';
import { dryRunValidate } from './dry-run-validator.js';
import { executeLoopIterations } from './loop-executor.js';
import { executeParallelSteps } from './parallel-executor.js';
import { rollbackSteps, type CompletedStep } from './rollback-orchestrator.js';
import { buildCredentialPatterns, addCredentialPattern, collectCredentialNames } from './credential-masker.js';
import { executeSingleStep, type StepExecutionState } from './step-executor.js';
import { collectPrerequisites, checkPrerequisites, formatPrerequisiteErrors } from './prerequisite-checker.js';
import {
  collectPreflights,
  checkPreflights,
  formatPreflightErrors,
  partitionPreflightResults,
  runResolutionCommand,
} from './preflight-checker.js';
import type { PreflightWarning } from '../types/runner.types.js';
import { DENY_ALL_GATEWAY } from './capability-gateway.js';
import {
  resolveEffectiveSandbox, formatSandboxLog,
  DEFAULT_SANDBOX_CONFIG,
  type EffectiveSandbox,
} from './platform-sandbox.js';
import { checkAcceptance, recordAcceptance } from './permission-acceptance.js';
import { analyzeSpellPermissions, formatSpellPermissionReport } from './permission-disclosure.js';

export const ENGINE_VERSION = '1.0.0';

export class SpellCaster {
  private readonly connectorAccessor?: ConnectorAccessorImpl;

  constructor(
    private readonly registry: StepCommandRegistry,
    private readonly credentials: CredentialAccessor,
    private readonly memory: MemoryAccessor,
    private readonly connectorRegistry?: SpellConnectorRegistry,
  ) {
    if (connectorRegistry) {
      this.connectorAccessor = new ConnectorAccessorImpl(connectorRegistry);
    }
  }

  async run(
    definition: SpellDefinition,
    args: Record<string, unknown>,
    options: RunnerOptions = {},
  ): Promise<SpellResult> {
    const startTime = Date.now();
    const defValidation = validateSpellDefinition(definition, {
      knownStepTypes: this.registry.types(),
    });
    const spellId = options.spellId ?? `sp-${Date.now()}`;

    if (!defValidation.valid) {
      return this.failureResult(spellId, startTime, [{
        code: 'DEFINITION_VALIDATION_FAILED',
        message: 'Spell definition is invalid',
        details: defValidation.errors,
      }], definition.name);
    }

    if (options.parentMofloLevel && definition.mofloLevel) {
      if (compareMofloLevels(definition.mofloLevel, options.parentMofloLevel) > 0) {
        return this.failureResult(spellId, startTime, [{
          code: 'MOFLO_LEVEL_DENIED',
          message: `Nested spell mofloLevel "${definition.mofloLevel}" exceeds parent level "${options.parentMofloLevel}"`,
        }], definition.name);
      }
    }

    const { resolved: resolvedArgs, errors: argErrors } = resolveArguments(
      definition.arguments ?? {}, args,
    );
    if (argErrors.length > 0) {
      return this.failureResult(spellId, startTime, [{
        code: 'ARGUMENT_VALIDATION_FAILED',
        message: 'Argument validation failed',
        details: argErrors,
      }], definition.name);
    }

    // ---------------------------------------------------------------
    // Permission acceptance gate: first-run spells show a risk
    // analysis and block execution until the user explicitly accepts
    // via the spell_accept MCP tool.
    // ---------------------------------------------------------------
    if (!options.dryRun && !options.skipAcceptanceCheck && options.projectRoot) {
      const permReport = analyzeSpellPermissions(definition, this.registry);
      const acceptance = await checkAcceptance(
        options.projectRoot, definition.name, permReport.permissionHash,
      );

      if (!acceptance.accepted) {
        // Auto-accept spells with no real risk — no need to prompt the user
        if (permReport.overallRisk === 'none' || permReport.overallRisk === 'low') {
          await recordAcceptance(options.projectRoot, definition.name, permReport.permissionHash);
          console.log(`[spell] Auto-accepted "${definition.name}" (${permReport.overallRisk} risk)`);
        } else {
          const reason = acceptance.reason === 'hash-mismatch'
            ? 'Spell permissions have changed since last acceptance'
            : 'First run — reviewing spell permissions';
          const report = formatSpellPermissionReport(permReport);

          console.log(`[spell] ${reason}`);
          console.log(`[spell] Running automatic dry-run validation...\n`);
          console.log(report);

          // Run dry-run validation so the user also sees structural issues
          const dryResult = await dryRunValidate(
            definition, resolvedArgs, defValidation, options, this.registry,
            (variables, wfId, stepIndex) =>
              this.buildContext(variables, resolvedArgs, wfId, stepIndex, options.signal),
          );

          if (!dryResult.valid) {
            console.log('\n[spell] Dry-run validation found errors:');
            for (const err of [...dryResult.definitionErrors, ...dryResult.argumentErrors]) {
              console.log(`  - ${err.message}`);
            }
          }

          // Block — user must explicitly accept
          console.log(`\n[spell] To accept these permissions, run: spell_accept({ name: "${definition.name}" })`);
          return this.failureResult(spellId, startTime, [{
            code: 'ACCEPTANCE_REQUIRED',
            message: `${reason}. Review the risk analysis above and accept with spell_accept({ name: "${definition.name}" }).`,
          }], definition.name);
        }
      }
    }

    // Pre-flight prerequisite checks (Story #193)
    if (!options.dryRun) {
      const prerequisites = collectPrerequisites(definition, this.registry);
      if (prerequisites.length > 0) {
        const prereqResults = await checkPrerequisites(prerequisites);
        if (prereqResults.some(r => !r.satisfied)) {
          return this.failureResult(spellId, startTime, [{
            code: 'PREREQUISITES_FAILED',
            message: formatPrerequisiteErrors(prereqResults),
          }], definition.name);
        }
      }

      // Preflight runtime-state checks — fail fast before any step runs.
      const preflightFailure = await this.runPreflights(definition, resolvedArgs, options);
      if (preflightFailure) {
        return this.failureResult(
          spellId, startTime,
          [{ code: 'PREFLIGHT_FAILED', message: preflightFailure }],
          definition.name,
        );
      }
    }

    if (options.dryRun) {
      const dryResult = await dryRunValidate(
        definition, resolvedArgs, defValidation, options, this.registry,
        (variables, wfId, stepIndex) =>
          this.buildContext(variables, resolvedArgs, wfId, stepIndex, options.signal),
      );
      return {
        spellId, success: dryResult.valid, steps: [], outputs: {},
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

    // Resolve OS sandbox status at spell start (#410)
    let effectiveSandbox: EffectiveSandbox | undefined;
    try {
      const sandboxCfg = options.sandboxConfig ?? DEFAULT_SANDBOX_CONFIG;
      effectiveSandbox = resolveEffectiveSandbox(sandboxCfg);
      console.log(formatSandboxLog(effectiveSandbox));
    } catch (err) {
      // tier: full but no sandbox available — fail the spell
      return this.failureResult(spellId, startTime, [{
        code: 'PREREQUISITES_FAILED',
        message: (err as Error).message,
      }], definition.name);
    }

    return this.executeSteps(definition, resolvedArgs, spellId, options, startTime, effectiveSandbox);
  }

  async dryRun(
    definition: SpellDefinition,
    resolvedArgs: Record<string, unknown>,
    options: RunnerOptions = {},
  ): Promise<DryRunResult> {
    const defValidation = validateSpellDefinition(definition, {
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
    definition: SpellDefinition, resolvedArgs: Record<string, unknown>,
    spellId: string, options: RunnerOptions, startTime: number,
    effectiveSandbox?: EffectiveSandbox,
  ): Promise<SpellResult> {
    const context = options.context;
    const variables: Record<string, unknown> = { ...options.initialVariables };
    const stepResults: StepResult[] = [];
    const errors: SpellError[] = [];
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
      variables, resolvedArgs, spellId, options,
      credentialPatterns, resolvedCredentials,
      spellMofloLevel: definition.mofloLevel,
      parentMofloLevel: options.parentMofloLevel,
      nestingDepth: options.nestingDepth ?? 0,
      maxNestingDepth: options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH,
      effectiveSandbox,
    };

    try {
    await this.storeProgress(spellId, 'running', 0, definition.steps.length, {
      spellName: definition.name, startedAt: startTime, context,
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
          message: `Spell exceeded maximum iterations (${maxIterations}); possible infinite condition loop` });
        this.markRemaining(definition, i, 'skipped', stepResults);
        break;
      }

      if (options.signal?.aborted) {
        cancelled = true;
        this.markRemaining(definition, i, 'cancelled', stepResults);
        break;
      }

      const step = definition.steps[i];
      console.log(`[spell] Step ${i + 1}/${definition.steps.length}: starting "${step.id}" [${step.type}]`);
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
      console.log(`[spell] Step ${i + 1}/${definition.steps.length}: ${result.status} "${step.id}" (${result.duration}ms)${result.error ? ' — ' + result.error.slice(0, 200) : ''}`);
      await this.storeProgress(spellId, 'running', stepResults.length, definition.steps.length, {
        spellName: definition.name, startedAt: startTime, steps: stepResults, context,
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
      errors.push({ code: 'SPELL_CANCELLED', message: 'Spell was cancelled' });
    }

    const finalStatus = cancelled ? 'cancelled' : errors.length > 0 ? 'failed' : 'completed';
    await this.storeProgress(spellId, finalStatus, stepResults.length, definition.steps.length, {
      spellName: definition.name, startedAt: startTime, errors, steps: stepResults, context,
    });

    const outputs: Record<string, unknown> = {};
    for (const sr of stepResults) {
      if (sr.status === 'succeeded' && sr.output) {
        outputs[sr.stepId] = variables[sr.stepId] ?? sr.output.data;
      }
    }

    return { spellId, success: errors.length === 0 && !cancelled,
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

  /**
   * Run every preflight declared by the spell.
   * Returns a user-facing failure message, or null if the spell may proceed.
   */
  private async runPreflights(
    definition: SpellDefinition,
    resolvedArgs: Record<string, unknown>,
    options: RunnerOptions,
  ): Promise<string | null> {
    const preflights = collectPreflights(definition, this.registry, {
      args: resolvedArgs,
      credentials: this.credentials,
    });
    if (preflights.length === 0) return null;

    const results = await checkPreflights(preflights);
    const { fatals, warnings } = partitionPreflightResults(results);

    if (fatals.length > 0) return formatPreflightErrors(fatals);
    if (warnings.length === 0) return null;
    if (!options.onPreflightWarnings) return formatPreflightErrors(warnings);

    const payload: PreflightWarning[] = warnings.map(w => ({
      stepId: w.stepId,
      name: w.name,
      reason: w.reason ?? w.name,
      resolutions: w.resolutions ?? [],
    }));

    const decisions = await options.onPreflightWarnings(payload);
    if (decisions.length !== warnings.length) {
      return `Preflight warning handler returned ${decisions.length} decisions for ${warnings.length} warnings`;
    }

    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];
      const warn = warnings[i];
      if (decision.action === 'abort') {
        return formatPreflightErrors([warn]);
      }
      if (decision.action === 'resolve') {
        const chosen = (warn.resolutions ?? [])[decision.resolutionIndex];
        if (!chosen) {
          return `Invalid resolution index ${decision.resolutionIndex} for "${warn.name}"`;
        }
        const { ok, exitCode } = await runResolutionCommand(chosen, resolvedArgs);
        if (!ok) {
          return `Resolution "${chosen.label}" failed (exit code ${exitCode}). Fix the underlying issue and try again.`;
        }
      }
    }
    return null;
  }

  private runStep(
    step: import('../types/spell-definition.types.js').StepDefinition,
    state: StepExecutionState, index: number,
  ) {
    const ctxBuilder = (v: Record<string, unknown>, a: Record<string, unknown>, sid: string, si: number, sig?: AbortSignal) =>
      this.buildContext(v, a, sid, si, sig, state.effectiveSandbox);
    return executeSingleStep(step, state, index, this.registry, ctxBuilder);
  }

  private async doRollback(completed: CompletedStep[], state: StepExecutionState, results: StepResult[]) {
    await rollbackSteps(completed, this.registry,
      (i) => this.buildContext(state.variables, state.resolvedArgs, state.spellId, i, state.options.signal, state.effectiveSandbox),
      results);
  }

  private markRemaining(def: SpellDefinition, from: number, status: StepStatus, results: StepResult[]) {
    for (let j = from; j < def.steps.length; j++) {
      results.push({ stepId: def.steps[j].id, stepType: def.steps[j].type, status, duration: 0 });
    }
  }

  private buildContext(
    variables: Record<string, unknown>, args: Record<string, unknown>,
    spellId: string, stepIndex: number, signal?: AbortSignal,
    sandbox?: EffectiveSandbox,
  ): CastingContext {
    return { variables, args, credentials: this.credentials, memory: this.memory,
      taskId: `${spellId}-step-${stepIndex}`, spellId, stepIndex, abortSignal: signal,
      gateway: DENY_ALL_GATEWAY,
      ...(this.connectorAccessor ? { tools: this.connectorAccessor } : {}),
      ...(sandbox ? { sandbox } : {}) };
  }

  private async storeProgress(
    wfId: string, status: string, done: number, total: number,
    extra?: { spellName?: string; startedAt?: number; errors?: SpellError[]; steps?: StepResult[]; context?: FloRunContext },
  ) {
    try {
      const now = Date.now();
      const record: Record<string, unknown> = {
        status, completedSteps: done, totalSteps: total, updatedAt: new Date().toISOString(),
      };
      if (extra?.spellName) record.spellName = extra.spellName;
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
      console.warn(`[spell] storeProgress(${wfId}, ${status}) failed: ${(err as Error).message ?? err}`);
    }
  }

  private async failureResult(spellId: string, startTime: number, errors: SpellError[], spellName?: string): Promise<SpellResult> {
    await this.storeProgress(spellId, 'failed', 0, 0, {
      spellName, startedAt: startTime, errors,
    });
    return { spellId, success: false, steps: [], outputs: {}, errors,
      duration: Date.now() - startTime, cancelled: false };
  }
}
