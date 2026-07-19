/**
 * SDD + verify-before-done wiring health check — Story #1276 (Epic #1269).
 *
 * Reports whether the Spec-Driven Development spine and the verify-before-done
 * gate are correctly wired for this consumer, and surfaces the two opt-in
 * toggles (`sdd.default`, `gates.verify_before_done`). Consumed by `/healer`
 * (via the doctor registry) and, transitively, by `/eldar` (which renders the
 * healer's JSON).
 *
 * Cross-platform (Rule #1): all paths via path.join; no shelling out.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../services/project-root.js';
import { loadMofloConfig } from '../config/moflo-config.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

const NAME = 'SDD + Verify Wiring';

/** The gate cases + hook subcommands that must be present for the feature to work. */
const REQUIRED_GATE_CASES = ['check-before-done', 'record-verify-run'];
const REQUIRED_HOOK_TOKENS = ['check-before-done', 'record-verify-run'];

export async function checkSddVerifyWiring(): Promise<HealthCheck> {
  const projectDir = findProjectRoot();

  const helperGate = join(projectDir, '.claude', 'helpers', 'gate.cjs');
  const settingsPath = join(projectDir, '.claude', 'settings.json');

  // Uninitialised project — defer to `flo init`, don't hard-fail.
  if (!existsSync(helperGate) && !existsSync(settingsPath)) {
    return {
      name: NAME,
      status: 'warn',
      message: '.claude/ not initialised — SDD/verify wiring absent',
      fix: 'npx moflo init',
    };
  }

  // Read the two opt-in toggles (best-effort; default false).
  let sddDefault = false;
  let verifyGate = false;
  try {
    const cfg = loadMofloConfig(projectDir);
    sddDefault = cfg.sdd?.default === true;
    verifyGate = cfg.gates?.verify_before_done === true;
  } catch {
    /* config unreadable — treat as defaults (both off) */
  }

  const issues: string[] = [];

  // 1. Gate logic present in the installed helper gate.cjs.
  if (existsSync(helperGate)) {
    try {
      const gate = readFileSync(helperGate, 'utf8');
      const missing = REQUIRED_GATE_CASES.filter((c) => !gate.includes(`case '${c}'`));
      if (missing.length > 0) issues.push(`gate.cjs missing: ${missing.join(', ')}`);
    } catch (e) {
      issues.push(`cannot read gate.cjs: ${errorDetail(e)}`);
    }
  } else {
    issues.push('.claude/helpers/gate.cjs not found');
  }

  // 2. Hooks wired in settings.json.
  if (existsSync(settingsPath)) {
    try {
      const settings = readFileSync(settingsPath, 'utf8');
      const missing = REQUIRED_HOOK_TOKENS.filter((t) => !settings.includes(t));
      if (missing.length > 0) issues.push(`settings.json missing hooks: ${missing.join(', ')}`);
    } catch (e) {
      issues.push(`cannot read settings.json: ${errorDetail(e)}`);
    }
  } else {
    issues.push('.claude/settings.json not found');
  }

  const toggles = `sdd.default=${sddDefault}, gates.verify_before_done=${verifyGate}`;

  if (issues.length > 0) {
    // Wiring is broken. Severity depends on whether the consumer opted in: a
    // missing gate when verify is ON blocks nothing (fail-open) but breaks the
    // promised enforcement, so it's a real fault. When both toggles are off the
    // wiring is still expected (it ships inert), but a missing case only bites
    // once someone opts in — warn.
    const enforced = verifyGate || sddDefault;
    return {
      name: NAME,
      status: enforced ? 'fail' : 'warn',
      message: `SDD/verify wiring incomplete (${toggles}): ${issues.join('; ')}`,
      fix: 'npx moflo init --fix   # re-syncs gate.cjs + settings.json hooks',
    };
  }

  return {
    name: NAME,
    status: 'pass',
    message: `SDD/verify wired (${toggles})${verifyGate ? ' — verify-before-done ENFORCED' : ''}`,
  };
}
