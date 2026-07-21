/**
 * SDD + verify-before-done wiring health check — Story #1276 (Epic #1269).
 *
 * Reports whether the Spec-Driven Development spine and the verify-before-done
 * gate are correctly wired for this consumer, and surfaces the two opt-in
 * toggles (`sdd.default`, `gates.verify_before_done`). Consumed by `/healer`
 * (via the doctor registry) and, transitively, by `/eldar` (which renders the
 * healer's JSON).
 *
 * #1301 — the check used to demand ALL three gate tokens whenever EITHER toggle
 * was on. Because `gates.verify_before_done` defaults to `true`, a consumer who
 * opted OUT of SDD (`sdd.default: false`) was still forced to carry the SDD
 * implement-gate (`check-before-implement`) and failed spuriously. The required
 * set is now decoupled per feature (see `computeSddVerifyRequirements`), and a
 * LOCKED hook block (`moflo.hooks.locked: true`) — which moflo deliberately
 * won't rewrite — is reported as a warn with actionable reconciliations rather
 * than a permanently-red fail that `init --fix` can never clear.
 *
 * Cross-platform (Rule #1): all paths via path.join; no shelling out.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../services/project-root.js';
import { loadMofloConfig } from '../config/moflo-config.js';
import { isHookBlockLocked } from '../services/hook-block-hash.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

const NAME = 'SDD + Verify Wiring';

/**
 * The SDD implement-gate — required only when `sdd.default === true`. This is
 * the gate that pauses `/flo` at the implement step for a spec/plan checkpoint.
 */
const SDD_GATE_CASES = ['check-before-implement'];
const SDD_HOOK_TOKENS = ['check-before-implement'];

/**
 * The verify-before-done gate — required only when
 * `gates.verify_before_done === true`. `check-before-done` blocks `gh pr create`
 * until a `/verify` run is recorded; `record-verify-run` is the PostToolUse
 * half that records it.
 */
const VERIFY_GATE_CASES = ['check-before-done', 'record-verify-run'];
const VERIFY_HOOK_TOKENS = ['check-before-done', 'record-verify-run'];

export interface SddVerifyRequirements {
  sddDefault: boolean;
  verifyGate: boolean;
  /** `moflo.hooks.locked: true` — moflo will not rewrite the hook block. */
  locked: boolean;
  /** At least one feature toggle is on (its wiring is genuinely enforced). */
  enforced: boolean;
  /** `.claude/` has neither gate.cjs nor settings.json — defer to `flo init`. */
  uninitialised: boolean;
  /** Hook tokens that must appear in settings.json for the enabled features. */
  requiredHookTokens: string[];
  /** gate.cjs `case` names required for the enabled features. */
  requiredGateCases: string[];
  /** Required hook tokens absent from settings.json. */
  missingHooks: string[];
  /** Required gate cases absent from gate.cjs. */
  missingGateCases: string[];
  /** Structural faults independent of the feature toggles (missing/unreadable files). */
  structural: string[];
}

/**
 * Single source of truth for what SDD/verify wiring the consumer's toggles
 * require and what is actually present. Shared by the health check and the
 * `--fix` handler so the fixer can honestly re-verify its own work (#1301 — the
 * old fixer reported `applied: true` on a locked block that it never touched).
 *
 * Pure read-only inspection — no file writes.
 */
export function computeSddVerifyRequirements(projectDir: string = findProjectRoot()): SddVerifyRequirements {
  const helperGate = join(projectDir, '.claude', 'helpers', 'gate.cjs');
  const settingsPath = join(projectDir, '.claude', 'settings.json');

  let sddDefault = false;
  let verifyGate = false;
  try {
    const cfg = loadMofloConfig(projectDir);
    sddDefault = cfg.sdd?.default === true;
    verifyGate = cfg.gates?.verify_before_done === true;
  } catch {
    /* config unreadable — treat as defaults (both off) */
  }

  // Decouple the required set per feature (#1301). SDD's implement-gate is
  // required only under sdd.default; the verify hooks only under
  // verify_before_done. A verify-only consumer no longer drags in the SDD gate.
  const requiredHookTokens = [
    ...(sddDefault ? SDD_HOOK_TOKENS : []),
    ...(verifyGate ? VERIFY_HOOK_TOKENS : []),
  ];
  const requiredGateCases = [
    ...(sddDefault ? SDD_GATE_CASES : []),
    ...(verifyGate ? VERIFY_GATE_CASES : []),
  ];

  const uninitialised = !existsSync(helperGate) && !existsSync(settingsPath);
  const structural: string[] = [];
  const missingHooks: string[] = [];
  const missingGateCases: string[] = [];
  let locked = false;

  // gate.cjs — the installed helper must carry the cases for enabled features.
  if (existsSync(helperGate)) {
    try {
      const gate = readFileSync(helperGate, 'utf8');
      for (const c of requiredGateCases) {
        if (!gate.includes(`case '${c}'`)) missingGateCases.push(c);
      }
    } catch (e) {
      structural.push(`cannot read gate.cjs: ${errorDetail(e)}`);
    }
  } else if (!uninitialised) {
    structural.push('.claude/helpers/gate.cjs not found');
  }

  // settings.json — the hook wiring plus the lock sentinel.
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      for (const t of requiredHookTokens) {
        if (!raw.includes(t)) missingHooks.push(t);
      }
      try {
        locked = isHookBlockLocked(JSON.parse(raw));
      } catch {
        /* unparseable JSON — leave locked=false; structural check below flags it */
        structural.push('.claude/settings.json is not valid JSON');
      }
    } catch (e) {
      structural.push(`cannot read settings.json: ${errorDetail(e)}`);
    }
  } else if (!uninitialised) {
    structural.push('.claude/settings.json not found');
  }

  return {
    sddDefault,
    verifyGate,
    locked,
    enforced: sddDefault || verifyGate,
    uninitialised,
    requiredHookTokens,
    requiredGateCases,
    missingHooks,
    missingGateCases,
    structural,
  };
}

export async function checkSddVerifyWiring(): Promise<HealthCheck> {
  const req = computeSddVerifyRequirements(findProjectRoot());

  // Uninitialised project — defer to `flo init`, don't hard-fail.
  if (req.uninitialised) {
    return {
      name: NAME,
      status: 'warn',
      message: '.claude/ not initialised — SDD/verify wiring absent',
      fix: 'npx moflo init',
    };
  }

  const toggles = `sdd.default=${req.sddDefault}, gates.verify_before_done=${req.verifyGate}`;

  const issues: string[] = [...req.structural];
  if (req.missingGateCases.length > 0) issues.push(`gate.cjs missing: ${req.missingGateCases.join(', ')}`);
  if (req.missingHooks.length > 0) issues.push(`settings.json missing hooks: ${req.missingHooks.join(', ')}`);

  if (issues.length === 0) {
    return {
      name: NAME,
      status: 'pass',
      message: `SDD/verify wired (${toggles})${req.verifyGate ? ' — verify-before-done ENFORCED' : ''}`,
    };
  }

  // Locked hook block: moflo won't rewrite it (init + launcher both skip on
  // `isHookBlockLocked`), so pointing at `init --fix` is a dead-end and a hard
  // fail is a permanently-red check the healer can never clear (#1301). When the
  // ONLY outstanding problem is missing hook tokens in that locked block,
  // downgrade to warn and hand over the two real reconciliations. gate.cjs and
  // structural faults are unaffected by the lock, so they still fail normally.
  if (
    req.locked &&
    req.missingHooks.length > 0 &&
    req.missingGateCases.length === 0 &&
    req.structural.length === 0
  ) {
    const optOut =
      req.sddDefault && !req.verifyGate
        ? 'set sdd.default: false'
        : req.verifyGate && !req.sddDefault
          ? 'set gates.verify_before_done: false'
          : 'disable the SDD/verify toggles';
    return {
      name: NAME,
      status: 'warn',
      message:
        `SDD/verify wiring incomplete (${toggles}): settings.json missing hooks: ` +
        `${req.missingHooks.join(', ')} — hook block is LOCKED (moflo.hooks.locked=true), ` +
        `so moflo will not wire it`,
      fix:
        `Reconcile: ${optOut} in moflo.yaml to match the locked block, OR remove ` +
        `moflo.hooks.locked from .claude/settings.json and run npx moflo init --fix`,
    };
  }

  // A missing required token means a feature the consumer turned ON isn't
  // enforced — a real fault. With both toggles off, `requiredHookTokens`/
  // `requiredGateCases` are empty, so only structural faults can reach here;
  // those warn (the wiring ships inert until someone opts in).
  return {
    name: NAME,
    status: req.enforced ? 'fail' : 'warn',
    message: `SDD/verify wiring incomplete (${toggles}): ${issues.join('; ')}`,
    fix: 'npx moflo init --fix   # re-syncs gate.cjs + settings.json hooks',
  };
}
