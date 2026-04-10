/**
 * Bash Step Command — runs a shell command.
 */

import { exec, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
  StepCapability,
} from '../types/step-command.types.js';
import { shellInterpolateString } from '../core/interpolation.js';
import { enforceScope, formatViolations } from '../core/capability-validator.js';
import { resolvePermissions, type PermissionLevel } from '../core/permission-resolver.js';
import { checkDestructivePatterns, formatDestructiveError } from './destructive-pattern-checker.js';
import type { SandboxWrapResult } from '../core/sandbox-utils.js';
import { wrapWithSandboxExec } from '../core/sandbox-profile.js';
import { wrapWithBwrap } from '../core/bwrap-sandbox.js';

/** Typed config for the bash step command. */
export interface BashStepConfig extends StepConfig {
  readonly command: string;
  readonly timeout?: number;
  readonly failOnError?: boolean;
  readonly allowDestructive?: boolean;
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
      allowDestructive: { type: 'boolean', description: 'Allow destructive commands that would normally be blocked', default: false },
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

  async execute(config: BashStepConfig, context: CastingContext): Promise<StepOutput> {
    const start = Date.now();
    let command = shellInterpolateString(config.command, context);
    const timeout = config.timeout ?? 30000;
    const failOnError = config.failOnError !== false;

    // ── Least-privilege Claude CLI permission injection ──────────────
    // When the command spawns `claude -p`, replace any hardcoded permission
    // flags with the resolver's output based on the step's permissionLevel
    // (or derive from capabilities). This ensures least-privilege even if
    // the YAML author forgot to restrict tools.
    command = applyClaudePermissions(command, context.permissionLevel, context.effectiveCaps);

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

    // ── Destructive command denylist (#408) ──────────────────────────
    if (!config.allowDestructive) {
      const destructiveMatch = checkDestructivePatterns(command);
      if (destructiveMatch) {
        return {
          success: false,
          data: { stdout: '', stderr: '', exitCode: -1 },
          error: formatDestructiveError(destructiveMatch),
          duration: Date.now() - start,
        };
      }
    }

    // If already aborted, bail immediately without spawning a process.
    if (context.abortSignal?.aborted) {
      return {
        success: !failOnError,
        data: { stdout: '', stderr: '', exitCode: -1, timedOut: false },
        error: failOnError ? 'Command aborted before execution' : undefined,
        duration: Date.now() - start,
      };
    }

    const elapsed = () => `${((Date.now() - start) / 1000).toFixed(1)}s`;
    const cmdPreview = command.length > 80 ? command.slice(0, 77) + '...' : command;

    // Resolve shell: prefer Git Bash on Windows to avoid WSL bash hanging.
    const resolvedShell = platform() === 'win32' ? resolveGitBash() : 'bash';

    // ── OS sandbox wrapping (#410 macOS, #411 Linux) ────────────────────
    // When OS sandbox is enabled, wrap via the platform-specific tool.
    let sandboxWrap: SandboxWrapResult | null = null;
    if (context.sandbox?.useOsSandbox) {
      const tool = context.sandbox.capability.tool;
      try {
        const projectRoot = (context.variables.projectRoot as string) || process.cwd();
        const caps = context.effectiveCaps ?? [];
        if (tool === 'sandbox-exec') {
          sandboxWrap = wrapWithSandboxExec(command, caps, projectRoot);
        } else if (tool === 'bwrap') {
          sandboxWrap = wrapWithBwrap(command, caps, projectRoot);
        }
      } catch (err) {
        console.log(`[bash] ${tool} wrapping failed, running unsandboxed: ${(err as Error).message}`);
      }
    }

    return new Promise<StepOutput>((resolve) => {
      let timedOut = false;
      let resolved = false;
      let lastStdoutLine = '';
      const cleanupSandbox = () => sandboxWrap?.cleanup();

      const finish = (code: number | null, signal: string | null, stdout: string, stderr: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        cleanupSandbox();
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

        resolve({
          success,
          data: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode, timedOut },
          error: errorMsg,
          duration: Date.now() - start,
        });
      };

      // Shared spawn options — stdin ignored to avoid WSL hangs on Windows.
      const spawnOpts = {
        stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      };

      // Determine spawn binary and args.
      const spawnBin = sandboxWrap ? sandboxWrap.bin : resolvedShell;
      const spawnArgs = sandboxWrap ? [...sandboxWrap.args] : ['-c', command];

      let closeStdout = '';
      let closeStderr = '';

      // Wire stdout/stderr collectors onto a child process.
      const wireOutputs = (child: ChildProcess) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          closeStdout += text;
          const lines = text.split(/\r?\n/).filter(l => l.trim());
          if (lines.length > 0) lastStdoutLine = lines[lines.length - 1];
        });
        child.stderr?.on('data', (chunk: Buffer) => { closeStderr += chunk.toString(); });
        child.on('close', (code, signal) => { finish(code, signal, closeStdout, closeStderr); });
      };

      // activeChild tracks the running process for heartbeat/timeout (may change on fallback).
      let activeChild: ChildProcess = spawn(spawnBin, spawnArgs, spawnOpts);
      wireOutputs(activeChild);

      // ── Sandbox fallback (#410, #411) ──────────────────────────────
      // If the sandbox tool spawn fails (ENOENT, permission error),
      // fall back to unsandboxed execution with new child.
      if (sandboxWrap) {
        activeChild.on('error', (err: NodeJS.ErrnoException) => {
          if (resolved) return;
          console.log(`[bash] sandbox failed (${err.code ?? err.message}), retrying unsandboxed`);
          cleanupSandbox();
          closeStdout = '';
          closeStderr = '';
          activeChild = spawn(resolvedShell, ['-c', command], spawnOpts);
          wireOutputs(activeChild);
        });
      }

      // ── Heartbeat — show the user the step is alive ──────────────
      const HEARTBEAT_INTERVAL = 15_000; // 15 seconds
      const heartbeat = setInterval(() => {
        if (resolved) { clearInterval(heartbeat); return; }
        const activity = lastStdoutLine
          ? ` | ${lastStdoutLine.slice(0, 80)}`
          : '';
        console.log(`[bash] still running (${elapsed()}) pid=${activeChild.pid ?? '?'} cmd=${cmdPreview}${activity}`);
      }, HEARTBEAT_INTERVAL);

      // ── Manual timeout with process tree kill ─────────────────────
      const onAbort = () => {
        timedOut = true;
        console.log(`[bash] killing step after ${elapsed()} (timeout=${timeout}ms) pid=${activeChild.pid ?? '?'}`);
        killProcessTree(activeChild);
      };
      const timer = setTimeout(onAbort, timeout);
      context.abortSignal?.addEventListener('abort', onAbort, { once: true });
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
      });
      // Destroy stdio pipes so 'close' fires even if taskkill is async.
      // Without this, piped stdout/stderr may stay open and the 'close'
      // event never fires — causing the command to hang until test timeout.
      child.stdout?.destroy();
      child.stderr?.destroy();
      try { child.kill(); } catch { /* ok */ }
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

// ── Git Bash resolution (Windows) ───────────────────────────────────────

/**
 * On Windows, multiple `bash.exe` may exist on PATH:
 *   - C:\Program Files\Git\usr\bin\bash.exe  (Git Bash — works)
 *   - C:\Windows\System32\bash.exe           (WSL — hangs on Windows FS)
 *   - C:\Users\...\AppData\Local\Microsoft\WindowsApps\bash.exe (WSL alias)
 *
 * We explicitly resolve Git Bash to avoid the WSL variants.
 */
let _cachedGitBash: string | undefined;
function resolveGitBash(): string {
  if (_cachedGitBash) return _cachedGitBash;

  // Check common Git install locations
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    // Git Bash also provides this shorter path
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      _cachedGitBash = candidate;
      return candidate;
    }
  }

  // Fallback: hope PATH has Git Bash first
  _cachedGitBash = 'bash';
  return 'bash';
}

// ── Least-privilege Claude CLI permission rewriting ─────────────────

/**
 * Detect `claude` invocations in a bash command and ensure they use the
 * permission resolver's output. Strips any existing --dangerously-skip-permissions
 * and --allowedTools flags, then injects the resolver's flags.
 *
 * Only rewrites commands that contain `claude` followed by `-p` (headless mode).
 * Interactive Claude invocations are left untouched.
 */
const CLAUDE_HEADLESS_RE = /\bclaude\b[^|;&]*\s-p\s/;
const EXISTING_PERM_FLAGS_RE = /\s*--dangerously-skip-permissions\b/g;
const EXISTING_ALLOWED_TOOLS_RE = /\s*--allowedTools\s+[^\s]+/g;

function applyClaudePermissions(
  command: string,
  explicitLevel?: PermissionLevel | string,
  capabilities?: readonly StepCapability[],
): string {
  if (!CLAUDE_HEADLESS_RE.test(command)) return command;

  const resolved = resolvePermissions(explicitLevel, capabilities);

  // Strip existing permission flags
  let rewritten = command
    .replace(EXISTING_PERM_FLAGS_RE, '')
    .replace(EXISTING_ALLOWED_TOOLS_RE, '');

  // Inject resolved flags right after `claude`
  const injectedArgs = resolved.cliArgs.join(' ');
  rewritten = rewritten.replace(/\bclaude\b/, `claude ${injectedArgs}`);

  // Clean up any double spaces introduced by stripping
  rewritten = rewritten.replace(/ {2,}/g, ' ');

  return rewritten;
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
