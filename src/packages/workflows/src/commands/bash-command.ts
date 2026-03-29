/**
 * Bash Step Command — runs a shell command.
 */

import { exec } from 'node:child_process';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';
import { shellInterpolateString } from '../core/interpolation.js';

export const bashCommand: StepCommand = {
  type: 'bash',
  description: 'Run a shell command and capture output',
  capabilities: [
    { type: 'shell' },
    { type: 'fs:read' },
    { type: 'fs:write' },
  ],
  defaultMofloLevel: 'none',
  configSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds', default: 30000 },
      failOnError: { type: 'boolean', description: 'Fail step on non-zero exit', default: true },
    },
    required: ['command'],
  } satisfies JSONSchema,

  validate(config: StepConfig): ValidationResult {
    const errors = [];
    if (!config.command || typeof config.command !== 'string') {
      errors.push({ path: 'command', message: 'command is required and must be a string' });
    }
    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
      errors.push({ path: 'timeout', message: 'timeout must be a positive number' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: StepConfig, context: WorkflowContext): Promise<StepOutput> {
    const start = Date.now();
    const command = shellInterpolateString(config.command as string, context);
    const timeout = (config.timeout as number) ?? 30000;
    const failOnError = config.failOnError !== false;

    return new Promise<StepOutput>((resolve) => {
      const onAbort = () => child.kill();
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });

      const child = exec(command, { timeout, shell: 'bash' }, (error, stdout, stderr) => {
        context.abortSignal?.removeEventListener('abort', onAbort);
        // child.exitCode is the numeric exit code; error.code can be a string like 'ETIMEDOUT'
        const exitCode = child.exitCode ?? (error ? 1 : 0);
        const success = !failOnError || exitCode === 0;

        resolve({
          success,
          data: {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
          },
          error: success ? undefined : `Command exited with code ${exitCode}`,
          duration: Date.now() - start,
        });
      });
    });
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'stdout', type: 'string', required: true },
      { name: 'stderr', type: 'string', required: true },
      { name: 'exitCode', type: 'number', required: true },
    ];
  },
};
