/**
 * Bash Step Command — runs a shell command.
 */

import { exec, spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  WorkflowContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  StepCapability,
} from '../types/step-command.types.js';
import { shellInterpolateString } from '../core/interpolation.js';
import { enforceScope, formatViolations } from '../core/capability-validator.js';

/** Typed config for the bash step command. */
export interface BashStepConfig extends StepConfig {
  readonly command: string;
  readonly timeout?: number;
  readonly failOnError?: boolean;
}

export const bashCommand: StepCommand<BashStepConfig> = {
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

  validate(config: BashStepConfig): ValidationResult {
    const errors = [];
    if (!config.command || typeof config.command !== 'string') {
      errors.push({ path: 'command', message: 'command is required and must be a string' });
    }
    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
      errors.push({ path: 'timeout', message: 'timeout must be a positive number' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: BashStepConfig, context: WorkflowContext): Promise<StepOutput> {
    const start = Date.now();
    const command = shellInterpolateString(config.command, context);
    const timeout = config.timeout ?? 30000;
    const failOnError = config.failOnError !== false;

    // ── Scope enforcement (#258, #266 — gateway always present) ────────
    try {
      context.gateway.checkShell(command);
    } catch (err) {
      return {
        success: false,
        data: { stdout: '', stderr: '', exitCode: -1 },
        error: (err as Error).message,
        duration: Date.now() - start,
      };
    }

    // Best-effort fs path scope check — extracts absolute paths from the
    // command string. This does NOT catch relative paths or paths built at
    // runtime. True confinement requires OS-level sandboxing.
    if (context.effectiveCaps) {
      const scopeViolation = checkBashPathScopes(command, context.effectiveCaps, context.taskId);
      if (scopeViolation) {
        return {
          success: false,
          data: { stdout: '', stderr: '', exitCode: -1 },
          error: scopeViolation,
          duration: Date.now() - start,
        };
      }
    }

    return new Promise<StepOutput>((resolve) => {
      const isWin = platform() === 'win32';
      let timedOut = false;

      const child = exec(command, {
        shell: 'bash',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 0,
        maxBuffer: 10 * 1024 * 1024,
      });

      child.stdin?.end();

      console.log(`[bash] pid=${child.pid} timeout=${timeout}ms cmd=${command.slice(0, 120)}`);

      // ── Diagnostic event logging ──────────────────────────────────
      const t0 = Date.now();
      const elapsed = () => `${Date.now() - t0}ms`;

      child.on('exit', (code, signal) => {
        console.log(`[bash] pid=${child.pid} EVENT:exit code=${code} signal=${signal} at ${elapsed()}`);
      });
      child.on('close', (code, signal) => {
        console.log(`[bash] pid=${child.pid} EVENT:close code=${code} signal=${signal} at ${elapsed()}`);
      });
      child.on('error', (err) => {
        console.log(`[bash] pid=${child.pid} EVENT:error ${err.message} at ${elapsed()}`);
      });
      child.stdout?.on('end', () => {
        console.log(`[bash] pid=${child.pid} EVENT:stdout-end at ${elapsed()}`);
      });
      child.stderr?.on('end', () => {
        console.log(`[bash] pid=${child.pid} EVENT:stderr-end at ${elapsed()}`);
      });

      // ── Manual timeout with process tree kill ─────────────────────
      const timer = setTimeout(() => {
        console.log(`[bash] pid=${child.pid} TIMEOUT fired at ${elapsed()} — killing process tree`);
        timedOut = true;
        killProcessTree(child);
      }, timeout);

      const onAbort = () => {
        timedOut = true;
        killProcessTree(child);
      };
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });

      // ── Collect stdout/stderr ─────────────────────────────────────
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // ── Resolve on close event ────────────────────────────────────
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', onAbort);

        const exitCode = code ?? (timedOut ? -1 : 1);
        const killed = timedOut || signal === 'SIGTERM' || signal === 'SIGKILL';
        const success = !failOnError || exitCode === 0;

        let errorMsg: string | undefined;
        if (!success) {
          if (timedOut) {
            errorMsg = `Command timed out after ${timeout}ms`;
          } else if (killed) {
            errorMsg = `Command killed by signal ${signal}`;
          } else {
            errorMsg = `Command exited with code ${exitCode}`;
          }
          if (stderr.trim()) errorMsg += ': ' + stderr.trim();
          else if (stdout.trim()) {
            errorMsg += ' (stdout tail: ' + stdout.trim().slice(-500) + ')';
          }
        }

        console.log(`[bash] pid=${child.pid} RESOLVE exit=${exitCode} timedOut=${timedOut} dur=${elapsed()}`);

        resolve({
          success,
          data: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode, timedOut },
          error: errorMsg,
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

// ── Process tree killing ─────────────────────────────────────────────────

/**
 * Kill a child process and its entire tree.
 * On Windows, `child.kill()` only kills the immediate process, leaving bash
 * and its children alive. We use `taskkill /T /F` for a tree kill (#298).
 */
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill('SIGKILL');
    return;
  }
  if (platform() === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        // detached so taskkill outlives us if needed
      });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    // On Unix, kill the process group (negative pid)
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// ── Best-effort path extraction for scope enforcement ────────────────────

/**
 * Extract absolute paths from a shell command string.
 * Matches Unix (/...) and Windows (C:\...) absolute paths.
 * This is intentionally conservative — it will miss relative paths and
 * paths constructed at runtime. See the comment in execute() above.
 */
const ABSOLUTE_PATH_RE = /(?:\/[\w./-]+|[A-Z]:\\[\w.\\ /-]+)/gi;

function checkBashPathScopes(
  command: string,
  caps: readonly StepCapability[],
  taskId: string,
): string | null {
  const fsCapTypes = ['fs:read', 'fs:write'] as const;

  for (const capType of fsCapTypes) {
    const cap = caps.find(c => c.type === capType);
    if (!cap?.scope || cap.scope.length === 0) continue;

    const paths = command.match(ABSOLUTE_PATH_RE);
    if (!paths) continue;

    for (const p of paths) {
      const violation = enforceScope(caps, capType, p, taskId, 'bash');
      if (violation) return formatViolations([violation]);
    }
  }

  return null;
}
