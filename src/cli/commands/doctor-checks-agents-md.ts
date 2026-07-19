/**
 * AGENTS.md presence + freshness check (#1270).
 *
 * Reports whether the consumer's `<root>/AGENTS.md` interop projection exists
 * and matches the block the current generator produces. Analogue of the
 * CLAUDE.md Injection Drift check — but AGENTS.md has no session-start
 * auto-repair, so this check is the primary signal that a consumer should run
 * `flo init upgrade` to refresh it.
 *
 * Respects the `agents_md.enabled: false` opt-out (reports pass + skipped).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findProjectRoot as findConsumerProjectDir } from '../services/project-root.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

const CHECK_NAME = 'AGENTS.md Interop';

export async function checkAgentsMd(): Promise<HealthCheck> {
  const projectDir = findConsumerProjectDir();

  // Opt-out short-circuit — cheap config read before touching the filesystem.
  try {
    const { loadMofloConfig } = await import('../config/moflo-config.js');
    if (loadMofloConfig(projectDir).agents_md.enabled === false) {
      return { name: CHECK_NAME, status: 'pass', message: 'AGENTS.md disabled via moflo.yaml (agents_md.enabled: false)' };
    }
  } catch { /* config unreadable — fall through and evaluate against the default-on behaviour */ }

  const agentsMdPath = join(projectDir, 'AGENTS.md');
  if (!existsSync(agentsMdPath)) {
    return { name: CHECK_NAME, status: 'warn', message: 'AGENTS.md not found', fix: 'npx flo init upgrade' };
  }

  let contents: string;
  try {
    contents = readFileSync(agentsMdPath, 'utf-8');
  } catch (e) {
    return { name: CHECK_NAME, status: 'warn', message: `cannot read AGENTS.md: ${errorDetail(e)}` };
  }

  const { generateAgentsMd, computeAgentsMdDrift } = await import('../init/agentsmd-generator.js');
  const state = computeAgentsMdDrift(contents, generateAgentsMd());

  switch (state) {
    case 'in-sync':
      return { name: CHECK_NAME, status: 'pass', message: 'AGENTS.md moflo block matches reference' };
    case 'no-marker':
      return { name: CHECK_NAME, status: 'warn', message: 'AGENTS.md has no moflo block (user-authored) — run upgrade to append one', fix: 'npx flo init upgrade' };
    case 'drifted':
      return { name: CHECK_NAME, status: 'warn', message: 'AGENTS.md moflo block has drifted from reference', fix: 'npx flo init upgrade' };
    case 'no-file':
      // Unreachable — existsSync returned true above. Kept for exhaustiveness.
      return { name: CHECK_NAME, status: 'warn', message: 'AGENTS.md not found', fix: 'npx flo init upgrade' };
  }
}
