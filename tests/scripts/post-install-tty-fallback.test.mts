/**
 * Source-invariant tests for the TTY-direct write fallback in
 * `scripts/post-install-notice.mjs` (#867).
 *
 * The postinstall used to print the upgrade banner to `process.stdout`
 * only. npm 7+ defaults to `foreground-scripts: false` and captures
 * postinstall stdio into log files the user never sees, which is why
 * the notice file was created as a fallback in the first place. Per
 * #867 we add a direct-to-TTY path (`/dev/tty` on POSIX, `\\.\CON` on
 * Windows) so the banner reaches the terminal regardless of npm's
 * stdio capture policy.
 *
 * The script is meant to run from npm's postinstall, not be imported,
 * so the assertions here pin the structural fix into the source rather
 * than executing it. The real-TTY path is exercised in CI by the
 * `npm install` step itself; behavioural unit-testing of TTY writes
 * would require a pty harness that's not worth the cost for a
 * best-effort fallback.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve(__dirname, '../../scripts/post-install-notice.mjs');
const src = readFileSync(SOURCE, 'utf-8');

describe('scripts/post-install-notice.mjs — TTY-direct fallback (#867)', () => {
  it('declares a writeToTty helper', () => {
    expect(src).toMatch(/function\s+writeToTty\s*\(/);
  });

  it('uses the platform-correct TTY device path (/dev/tty on POSIX, \\\\.\\CON on Windows)', () => {
    // Single source of truth function so the win32 vs POSIX choice can't
    // drift. ttyDevicePath() returns '\\\\.\\CON' on win32 and '/dev/tty' elsewhere.
    expect(src).toMatch(/function\s+ttyDevicePath\s*\(/);
    expect(src).toMatch(/platform\(\)\s*===\s*['"]win32['"]/);
    expect(src).toMatch(/['"]\\\\\\\\\.\\\\CON['"]/); // matches '\\\\.\\CON' literal in source
    expect(src).toMatch(/['"]\/dev\/tty['"]/);
  });

  it('opens / writes / closes the fd through node:fs primitives', () => {
    // The TTY write must use the low-level fd API — process.stdout.write
    // would route back through npm's captured stdio and defeat the fix.
    expect(src).toMatch(/openSync\s*\(\s*ttyDevicePath\(\)/);
    expect(src).toMatch(/writeSync\s*\(\s*fd\s*,/);
    expect(src).toMatch(/closeSync\s*\(\s*fd\s*\)/);
  });

  it('swallows TTY errors so a missing controlling terminal never blocks install', () => {
    // CI / piped npm output / no-TTY shells must NOT throw out of the
    // postinstall — the file fallback is enough on those hosts. Pin the
    // try/catch return-false shape so a refactor can't regress to throw.
    const fnMatch = src.match(/function\s+writeToTty\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnMatch, 'writeToTty helper must be in source').toBeTruthy();
    expect(fnMatch![0]).toMatch(/catch\s*\{\s*return\s+false\s*;\s*\}/);
  });

  it('falls back to process.stdout only when TTY write fails (no double print)', () => {
    // printBanner must attempt TTY first and skip stdout when ttyOk is true,
    // otherwise --foreground-scripts users would see two banners.
    const fnMatch = src.match(/function\s+printBanner\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnMatch, 'printBanner must be in source').toBeTruthy();
    const body = fnMatch![0];
    expect(body).toMatch(/const\s+ttyOk\s*=\s*writeToTty\s*\(/);
    expect(body).toMatch(/if\s*\(\s*!\s*ttyOk\s*\)/);
    expect(body).toMatch(/process\.stdout\.write\s*\(/);
  });
});
