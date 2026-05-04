/**
 * Platform-level checks for `flo doctor`:
 * spell engine integrity and OS sandbox tier.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { errorDetail } from '../shared/utils/error-detail.js';
import { getMofloRoot } from './doctor-checks-deep.js';
import type { HealthCheck } from './doctor-types.js';

// Validates core modules, built output, and step commands for the spell engine.
export async function checkSpellEngine(): Promise<HealthCheck> {
  try {
    // Resolve relative to the moflo package root (works in both dev and consumer)
    const mofloRoot = getMofloRoot();
    if (!mofloRoot) {
      return { name: 'Spell Engine', status: 'warn', message: 'Could not locate moflo package root', fix: 'npm run build' };
    }

    // Post-#586 workspace collapse: spell engine lives at src/cli/spells/
    // (source) and dist/src/cli/spells/ (compiled). The legacy
    // src/modules/spells/{src,dist}/ tree was deleted.
    const distDir = join(mofloRoot, 'dist', 'src', 'cli', 'spells');
    const srcDir = join(mofloRoot, 'src', 'cli', 'spells');
    const hasDistDir = existsSync(distDir);
    const hasSrcDir = existsSync(srcDir);

    if (!hasDistDir && !hasSrcDir) {
      return { name: 'Spell Engine', status: 'warn', message: 'Spell engine not found', fix: 'npm run build' };
    }

    const coreModules = [
      'core/runner',
      'core/step-executor',
      'core/step-command-registry',
      'core/interpolation',
      'core/credential-masker',
      'registry/spell-registry',
      'factory/runner-factory',
      'schema',
      'types',
      'credentials',
      'scheduler',
    ];

    const baseDir = hasDistDir ? distDir : srcDir;
    const ext = hasDistDir ? '.js' : '.ts';

    const dirModules = ['schema', 'types', 'credentials', 'scheduler'];
    const missing = coreModules.filter(m =>
      dirModules.includes(m)
        ? !existsSync(join(baseDir, m))
        : !existsSync(join(baseDir, m + ext)),
    );

    if (missing.length > 0) {
      return {
        name: 'Spell Engine',
        status: 'warn',
        message: `Missing modules: ${missing.join(', ')}`,
        fix: 'npm run build',
      };
    }

    const commandsDir = join(baseDir, 'commands');
    const hasCommands = existsSync(commandsDir);

    const loadersDir = join(baseDir, 'loaders');
    const hasLoaders = existsSync(loadersDir);

    const hasIndex = existsSync(join(baseDir, 'index' + ext));

    const parts: string[] = [];
    parts.push(`${coreModules.length} core modules`);
    if (hasCommands) parts.push('step commands');
    if (hasLoaders) parts.push('loaders');
    if (hasIndex) parts.push('index');

    return {
      name: 'Spell Engine',
      status: 'pass',
      message: parts.join(', '),
    };
  } catch (e) {
    return { name: 'Spell Engine', status: 'warn', message: `Unable to check spell engine: ${errorDetail(e)}` };
  }
}

// Reports OS sandbox capability AND, if the project has `sandbox.enabled: true`,
// whether the effective sandbox would actually start (e.g. Windows Docker image
// pulled and configured).
export async function checkSandboxTier(): Promise<HealthCheck> {
  try {
    const {
      detectSandboxCapability,
      loadSandboxConfigFromProject,
      resolveEffectiveSandbox,
    } = await import('../spells/index.js');

    const cap = await detectSandboxCapability();
    const config = await loadSandboxConfigFromProject(process.cwd());

    if (!config.enabled) {
      if (cap.available) {
        return {
          name: 'Sandbox Tier',
          status: 'pass',
          message: `${cap.tool} available (${cap.platform}) — sandboxing off in moflo.yaml`,
        };
      }

      const offHint: Record<string, string> = {
        win32: 'Install Docker Desktop and set sandbox.dockerImage in moflo.yaml to enable sandboxing',
        linux: 'Install bubblewrap: sudo apt install bubblewrap',
        darwin: 'sandbox-exec should be available on macOS — check /usr/bin/sandbox-exec',
      };

      return {
        name: 'Sandbox Tier',
        status: 'pass',
        message: `sandboxing off (${cap.platform}, denylist active)`,
        fix: offHint[cap.platform],
      };
    }

    try {
      const effective = await resolveEffectiveSandbox(config);
      if (effective.useOsSandbox) {
        const imageHint = effective.config.dockerImage ? `, ${effective.config.dockerImage}` : '';
        return {
          name: 'Sandbox Tier',
          status: 'pass',
          message: `${cap.tool} ready (${cap.platform}${imageHint})`,
        };
      }
      return {
        name: 'Sandbox Tier',
        status: 'warn',
        message: `denylist only (${cap.platform})`,
      };
    } catch (err) {
      return {
        name: 'Sandbox Tier',
        status: 'warn',
        message: `sandboxing enabled but not ready (${cap.platform})`,
        fix: errorDetail(err),
      };
    }
  } catch (err) {
    return {
      name: 'Sandbox Tier',
      status: 'warn',
      message: `Unable to detect: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
