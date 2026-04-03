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
      // Use exec with shell:'bash' — this lets Node resolve the correct
      // bash binary via PATH (Git Bash, not WSL bash).  We pass timeout: 0
      // to disable exec's built-in timeout since it doesn't kill process
      // trees on Windows; instead we use a manual setTimeout + killProcessTree.
      let timedOut = false;

      // Manual timeout with process tree kill (#297, #298).
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeout);

      const onAbort = () => {
        timedOut = true;
        killProcessTree(child);
      };
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });

      // Use exec callback as primary completion — more reliable than
      // 'close' event on Windows under npx process chains.
      const child = exec(command, {
        shell: 'bash',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 0,          // disabled — we handle timeout manually
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdoutBuf, stderrBuf) => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', onAbort);

        const stdout = (stdoutBuf ?? '').trim();
        const stderr = (stderrBuf ?? '').trim();
        const exitCode = child.exitCode ?? (error ? 1 : 0);
        const killed = timedOut || (error && 'killed' in error && (error as { killed?: boolean }).killed);
        const success = !failOnError || exitCode === 0;

        let errorMsg: string | undefined;
        if (!success) {
          if (timedOut) {
            errorMsg = `Command timed out after ${timeout}ms`;
          } else if (killed) {
            errorMsg = `Command killed by signal`;
          } else {
            errorMsg = `Command exited with code ${exitCode}`;
          }
          if (stderr) errorMsg += ': ' + stderr;
          else if (stdout) {
            errorMsg += ' (stdout tail: ' + stdout.slice(-500) + ')';
          }
        }

        console.log(`[bash] pid=${child.pid} exit=${exitCode} timedOut=${timedOut} dur=${Date.now() - start}ms`);

        resolve({
          success,
          data: { stdout, stderr, exitCode, timedOut: !!timedOut },
          error: errorMsg,
          duration: Date.now() - start,
        });
      });

      // Close stdin immediately — prevents hangs when child processes
      // try to read from inherited stdin under npx on Windows (#297).
      child.stdin?.end();

      console.log(`[bash] pid=${child.pid} timeout=${timeout}ms cmd=${command.slice(0, 120)}`);
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
