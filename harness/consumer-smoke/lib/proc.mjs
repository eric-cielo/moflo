/**
 * Cross-platform subprocess helpers for the smoke harness.
 *
 * Node 20+ blocks spawning `.cmd` / `.bat` with `shell: false`
 * (CVE-2024-27980 mitigation). When invoking npm on Windows, fall back to
 * `shell: true` with a single pre-joined command string — the args array is
 * deprecated with shell:true.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const NPM_CMD = IS_WIN ? 'npm.cmd' : 'npm';

let verbose = false;
export function configure({ verbose: v }) { verbose = !!v; }

// Issue #575: stderr from every subprocess is sampled so a final pass can
// detect `Cannot find module ...` leaks that exit-zero commands hide.
const stderrSamples = [];
export function recordSample(label, stderr) {
  if (stderr && stderr.length > 0) stderrSamples.push({ label, stderr });
}
export function getStderrSamples() { return stderrSamples; }
export function clearStderrSamples() { stderrSamples.length = 0; }

/**
 * Mirror of `escapeShellArg`'s Windows branch in
 * `src/cli/shared/utils/platform.ts` — kept in sync by hand because this harness
 * is plain `.mjs` and cannot import the TS module.
 *
 * Under MSVCRT argv parsing a backslash is only special immediately before a
 * `"`. Escaping quotes alone left a trailing backslash escaping the *closing*
 * quote, so `C:\Users\runneradmin\x y\` ran on and swallowed the next argument —
 * and this harness exists to catch cross-platform divergence, on runners whose
 * paths are exactly that shape (#1419).
 *
 * An argument with no metacharacter is still passed bare: unquoted, backslashes
 * are literal and need no doubling.
 */
function quoteWin(arg) {
  const s = String(arg);
  if (!/[\s"&|<>^%]/.test(s)) return s;
  const escaped = s
    .replace(/(\\*)"/g, '$1$1\\"')  // backslash run before a quote: double it, then escape the quote
    .replace(/(\\+)$/, '$1$1');     // backslash run before the closing quote: double it
  return `"${escaped}"`;
}

export function run(cmd, args, runOpts = {}) {
  const needsShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
  const spawnOpts = {
    cwd: runOpts.cwd,
    env: { ...process.env, ...(runOpts.env || {}) },
    encoding: 'utf8',
    stdio: (verbose && !runOpts.capture) ? 'inherit' : 'pipe',
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    timeout: runOpts.timeout ?? 120_000,
  };
  const result = needsShell
    ? spawnSync([cmd, ...args.map(quoteWin)].join(' '), { ...spawnOpts, shell: true })
    : spawnSync(cmd, args, { ...spawnOpts, shell: false });
  const stderr = result.stderr || '';
  const label = `${cmd.split(/[\\/]/).pop()}${args[0] ? ` ${args[0]}` : ''}`.slice(0, 60);
  recordSample(label, stderr);
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr,
    error: result.error,
  };
}

// capture is forced because every runNode caller asserts on stdout/stderr.
// Verbose mode prints the result's captured output in the reporter, not via
// inherited stdio.
export function runNode(scriptPath, args, runOpts = {}) {
  return run(process.execPath, [scriptPath, ...args], { ...runOpts, capture: true });
}

export function flo(consumerDir, args, runOpts = {}) {
  const cli = join(consumerDir, 'node_modules', 'moflo', 'bin', 'cli.js');
  return runNode(cli, args, { cwd: consumerDir, ...runOpts });
}
