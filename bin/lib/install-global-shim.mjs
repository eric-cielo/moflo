/**
 * Install a global `flo` shim into npm's global bin directory.
 *
 * The shim is a tiny wrapper that finds and runs the LOCAL project's
 * node_modules/.bin/flo, so bare `flo` always uses the correct version
 * for the current project — no npx, no global moflo install needed.
 *
 * Usage:
 *   import { installGlobalShim } from './lib/install-global-shim.mjs';
 *   const result = await installGlobalShim();  // { installed: true, path: '...' }
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';

// ── Shim content ────────────────────────────────────────────────────────────

const SHIM_SH = `#!/bin/sh
# MoFlo CLI shim — finds and runs the local project's flo binary.
# Installed by: npx flo init
dir="$PWD"
while [ "$dir" != "/" ]; do
  if [ -f "$dir/node_modules/.bin/flo" ]; then
    exec "$dir/node_modules/.bin/flo" "$@"
  fi
  dir=$(dirname "$dir")
done
echo "flo: no moflo installation found in any parent directory" >&2
echo "Run 'npm install moflo' in your project first." >&2
exit 1
`;

const SHIM_CMD = `@echo off
rem MoFlo CLI shim — finds and runs the local project's flo binary.
rem Installed by: npx flo init
setlocal
set "dir=%CD%"
:loop
if exist "%dir%\\node_modules\\.bin\\flo.cmd" (
  "%dir%\\node_modules\\.bin\\flo.cmd" %*
  exit /b %ERRORLEVEL%
)
for %%I in ("%dir%\\..") do set "parent=%%~fI"
if "%parent%"=="%dir%" goto notfound
set "dir=%parent%"
goto loop
:notfound
echo flo: no moflo installation found in any parent directory >&2
echo Run 'npm install moflo' in your project first. >&2
exit /b 1
`;

const SHIM_PS1 = `#!/usr/bin/env pwsh
# MoFlo CLI shim — finds and runs the local project's flo binary.
# Installed by: npx flo init
$dir = $PWD.Path
while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
  $candidate = Join-Path $dir 'node_modules/.bin/flo.ps1'
  if (Test-Path $candidate) {
    & $candidate @args
    exit $LASTEXITCODE
  }
  $dir = Split-Path $dir -Parent
}
Write-Error "flo: no moflo installation found in any parent directory"
Write-Error "Run 'npm install moflo' in your project first."
exit 1
`;

// Marker to identify our shim vs user-installed flo
const SHIM_MARKER = 'MoFlo CLI shim';

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the npm global bin directory.
 */
export function resolveGlobalBin() {
  const globalPrefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
  const isWindows = process.platform === 'win32';
  return isWindows ? globalPrefix : join(globalPrefix, 'bin');
}

/**
 * Install the global flo shim. Returns { installed, skipped, path, error }.
 * @param {object} opts
 * @param {boolean} [opts.silent] - Suppress output
 * @param {string} [opts.globalBin] - Override global bin directory (for testing)
 */
export function installGlobalShim({ silent = false, globalBin: globalBinOverride } = {}) {
  try {
    const isWindows = process.platform === 'win32';
    const globalBin = globalBinOverride || resolveGlobalBin();

    if (!existsSync(globalBin)) {
      return { installed: false, skipped: true, error: `Global bin directory not found: ${globalBin}` };
    }

    let installed = false;

    // Unix shell shim (always create — works in Git Bash on Windows too)
    const shPath = join(globalBin, 'flo');
    if (!isOurShim(shPath)) {
      writeFileSync(shPath, SHIM_SH, { mode: 0o755 });
      installed = true;
    }

    // Windows cmd shim
    if (isWindows) {
      const cmdPath = join(globalBin, 'flo.cmd');
      if (!isOurShim(cmdPath)) {
        writeFileSync(cmdPath, SHIM_CMD);
        installed = true;
      }

      const ps1Path = join(globalBin, 'flo.ps1');
      if (!isOurShim(ps1Path)) {
        writeFileSync(ps1Path, SHIM_PS1);
        installed = true;
      }
    }

    return { installed, skipped: false, path: globalBin };
  } catch (err) {
    return { installed: false, skipped: true, error: err.message };
  }
}

/**
 * Check if a shim file exists and is ours (vs something else named flo).
 */
function isOurShim(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

/**
 * Check if the global flo shim is installed.
 * @param {string} [globalBin] - Override global bin directory (for testing)
 */
export function isGlobalShimInstalled(globalBin) {
  try {
    const bin = globalBin || resolveGlobalBin();
    const isWindows = process.platform === 'win32';
    const shPath = join(bin, isWindows ? 'flo.cmd' : 'flo');
    return isOurShim(shPath);
  } catch {
    return false;
  }
}
