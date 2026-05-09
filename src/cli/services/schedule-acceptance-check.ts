/**
 * Schedule Acceptance Check
 *
 * Resolves a spell, computes its current permission hash, and checks whether
 * `.moflo/accepted-permissions/<name>.json` records a valid prior acceptance.
 *
 * The schedule-create command consumes the result to warn — never block — when
 * the spell is missing acceptance. Without it, scheduled fires running in the
 * non-interactive daemon context fail with `Missing credentials` and the user
 * has no signal at create time that a one-time manual cast was the missing
 * step (#1037).
 */

import { buildGrimoire } from './grimoire-builder.js';
import { checkAcceptance } from '../spells/core/permission-acceptance.js';

export type AcceptanceCheckState =
  | 'accepted'
  | 'never-accepted'
  | 'hash-mismatch'
  | 'spell-not-found'
  | 'check-failed';

export interface AcceptanceCheckResult {
  /** Discriminator for tests and structured logging. */
  readonly state: AcceptanceCheckState;
  /** Human-readable warning suitable for output.printWarning. Empty when no warning. */
  readonly message: string;
}

/**
 * Resolve `spellName` via the Grimoire, hash its permissions, compare against
 * any stored acceptance under `<projectRoot>/.moflo/accepted-permissions/`.
 *
 * Always returns — never throws. A check failure (e.g. Grimoire unavailable)
 * resolves to `check-failed` with an empty message so callers don't surface
 * noise; the schedule create proceeds either way.
 */
export async function checkScheduleAcceptance(
  projectRoot: string,
  spellName: string,
): Promise<AcceptanceCheckResult> {
  try {
    const { registry } = await buildGrimoire(projectRoot);
    const loaded = registry.resolve(spellName);
    if (!loaded) {
      return {
        state: 'spell-not-found',
        message: `Spell "${spellName}" was not found in the grimoire. The schedule will be created, but the daemon will auto-disable it on the first fire. Check the spell name (try \`flo spell list\`).`,
      };
    }

    const [
      { analyzeSpellPermissions },
      { StepCommandRegistry },
      { builtinCommands },
    ] = await Promise.all([
      import('../spells/core/permission-disclosure.js'),
      import('../spells/core/step-command-registry.js'),
      import('../spells/commands/index.js'),
    ]);

    const stepRegistry = new StepCommandRegistry();
    for (const cmd of builtinCommands) {
      stepRegistry.register(cmd, 'built-in');
    }
    const report = analyzeSpellPermissions(loaded.definition, stepRegistry);
    const result = await checkAcceptance(projectRoot, loaded.definition.name, report.permissionHash);

    if (result.accepted) {
      return { state: 'accepted', message: '' };
    }
    if (result.reason === 'no-acceptance') {
      return {
        state: 'never-accepted',
        message: `Spell "${loaded.definition.name}" has not been accepted yet. Scheduled fires run non-interactively, so the first run will fail with "missing credentials". Run \`flo spell cast -n ${loaded.definition.name}\` once manually to accept permissions, then this schedule will work on the next fire.`,
      };
    }
    return {
      state: 'hash-mismatch',
      message: `Spell "${loaded.definition.name}" permissions have changed since you last accepted them. Re-run \`flo spell cast -n ${loaded.definition.name}\` once to review and re-accept the new permissions; otherwise scheduled fires will fail.`,
    };
  } catch (err) {
    // Soft-fail: a Grimoire load error or permission analysis failure must
    // never block schedule creation. Return a quiet check-failed state and
    // let the create proceed. Surface the cause via console.debug so a
    // developer chasing a regression can see why the check degraded
    // without polluting normal CLI output.
    console.debug(`[schedule-acceptance-check] check failed for ${spellName}: ${(err as Error).message}`);
    return { state: 'check-failed', message: '' };
  }
}
