/**
 * #1398 (Epic #1392) — moflo must not sign a consumer's commits.
 *
 * `settings.attribution` is read by CLAUDE CODE, not by moflo: the harness
 * injects `attribution.commit` / `attribution.pr` into the agent's instructions,
 * which is how `Co-Authored-By: moflo …` and the "Generated with moflo" PR banner
 * reached commits. Nothing in moflo's own source reads the key, so it reads as
 * dead config from inside this repo — it is not.
 *
 * That is why removing it from `settings-generator.ts` is only half a fix: fresh
 * installs stop getting it, while every UPGRADED project keeps the key it was
 * given at init and keeps stamping moflo's identity into a git history that
 * cannot be rewritten. See `internal/upgrade-contract.md` § "Design for the
 * upgrade path first".
 */

import { describe, it, expect } from 'vitest';
import { removeLegacyAttribution } from '../../services/hook-wiring.js';
import { generateSettings } from '../../init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../../init/types.js';

const MOFLO_COMMIT = 'Co-Authored-By: moflo <noreply@cielolimitada.com>';
const MOFLO_PR = '\u{1F916} Generated with [moflo](https://github.com/eric-cielo/moflo)';

describe('#1398 — fresh installs get no attribution', () => {
  it('generateSettings emits no attribution key', () => {
    const settings = generateSettings(DEFAULT_INIT_OPTIONS) as Record<string, unknown>;
    expect(settings.attribution).toBeUndefined();
  });

  it('no moflo attribution string survives anywhere in generated settings', () => {
    // Broader than the key check: catches the block being reintroduced under a
    // different name or nested somewhere else.
    const json = JSON.stringify(generateSettings(DEFAULT_INIT_OPTIONS));
    expect(json).not.toContain('Co-Authored-By');
    expect(json).not.toContain('Generated with');
  });
});

describe('#1398 — upgraded projects are healed', () => {
  it('removes the exact block flo init used to write', () => {
    const settings: Record<string, unknown> = {
      attribution: { commit: MOFLO_COMMIT, pr: MOFLO_PR },
      permissions: { allow: [] },
    };

    expect(removeLegacyAttribution(settings)).toBe(true);
    expect(settings.attribution).toBeUndefined();
    // Untouched neighbours — this must not become a settings rewrite.
    expect(settings.permissions).toEqual({ allow: [] });
  });

  it('is idempotent — a second session start changes nothing', () => {
    const settings: Record<string, unknown> = {
      attribution: { commit: MOFLO_COMMIT, pr: MOFLO_PR },
    };
    removeLegacyAttribution(settings);

    expect(removeLegacyAttribution(settings)).toBe(false);
  });

  it('reports no change on settings that never had the block', () => {
    const settings: Record<string, unknown> = { permissions: { allow: [] } };
    expect(removeLegacyAttribution(settings)).toBe(false);
    expect(settings).toEqual({ permissions: { allow: [] } });
  });

  it('removes only the commit half when the consumer replaced the pr half', () => {
    const settings: Record<string, unknown> = {
      attribution: { commit: MOFLO_COMMIT, pr: 'Ship it' },
    };

    expect(removeLegacyAttribution(settings)).toBe(true);
    expect(settings.attribution).toEqual({ pr: 'Ship it' });
  });

  it('leaves a consumer-authored attribution block completely alone', () => {
    // We remove OUR string, not the concept. A team that deliberately set their
    // own trailer keeps it.
    const theirs = {
      commit: 'Co-Authored-By: Their Bot <bot@their-company.example>',
      pr: 'Built by our platform team',
    };
    const settings: Record<string, unknown> = { attribution: { ...theirs } };

    expect(removeLegacyAttribution(settings)).toBe(false);
    expect(settings.attribution).toEqual(theirs);
  });

  it('reports no change for a malformed attribution value, and never throws', () => {
    // Asserting the RETURN value, not just the absence of a throw: a bogus value
    // reported as "changed" would trigger a settings.json rewrite on every
    // session start. `[]` is the interesting case — `typeof [] === 'object'`, so
    // it reaches the object path and needs an explicit Array.isArray guard.
    for (const bad of [null, undefined, 'a string', 42, [], true]) {
      const settings: Record<string, unknown> = { attribution: bad };
      expect(() => removeLegacyAttribution(settings)).not.toThrow();
      expect(removeLegacyAttribution(settings), `value: ${JSON.stringify(bad)}`).toBe(false);
      expect(settings.attribution).toBe(bad);
    }
  });
});
