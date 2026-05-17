/**
 * Doctor check registry: ordered list and component-name lookup.
 *
 * Kept separate from `doctor.ts` so the orchestration file stays small and the
 * registry can be inspected/extended without re-touching command-action code.
 */

import {
  checkSubagentHealth,
  checkSpellExecution,
  checkMcpToolInvocation,
  checkHookExecution,
  checkMcpSpellIntegration,
  checkGateHealth,
  checkHookBlockDrift,
  checkClaudeMdInjectionDrift,
  checkMofloDbBridge,
} from './doctor-checks-deep.js';
import { checkEmbeddingHygiene } from './doctor-embedding-hygiene.js';
import { checkDaemonVersionSkew } from './doctor-checks-version-skew.js';
import { checkEmbeddingCoverageTruth } from './doctor-checks-coverage-truth.js';
import { checkWritersAudit } from './doctor-checks-writers-audit.js';
import {
  checkSwarmFunctional,
  checkHiveMindFunctional,
} from './doctor-checks-swarm.js';
import { checkMemoryAccessFunctional } from './doctor-checks-memory-access.js';
import {
  checkBuildTools,
  checkClaudeCode,
  checkDiskSpace,
  checkGit,
  checkGitRepo,
  checkNodeVersion,
  checkNpmVersion,
} from './doctor-checks-runtime.js';
import {
  checkConfigFile,
  checkDaemonIdentity,
  checkDaemonOrphan,
  checkDaemonStatus,
  checkDaemonWriteRouting,
  checkMcpServers,
  checkMemoryDatabase,
  checkMemoryDbIntegrity,
  checkMofloYamlCompliance,
  checkNestedMofloIslands,
  checkStatusLine,
  checkSwarmResidue,
  checkTestDirs,
} from './doctor-checks-config.js';
import { checkSpellEngine, checkSandboxTier } from './doctor-checks-platform.js';
import {
  checkEmbeddings,
  checkSemanticQuality,
} from './doctor-checks-memory.js';
import { checkIntelligence } from './doctor-checks-intelligence.js';
import { checkVersionFreshness } from './doctor-version.js';
import { checkZombieProcesses } from './doctor-zombies.js';
import type { CheckFn, HealthCheck } from './doctor-types.js';

export type { CheckFn, HealthCheck };

/** Order matters — top entries surface first under the spinner.
 * `checkZombieProcesses` is intentionally NOT in this list — it must run AFTER
 * the parallel batch settles (see `zombieScanCheck` below and #992). Otherwise
 * doctor's own subprocess probes (e.g. `checkBuildTools` running `npx tsc
 * --version`) can be flagged as their own zombies on Windows, where the npx
 * shim exits before its tsc child finishes.
 */
export const allChecks: CheckFn[] = [
  checkVersionFreshness,
  checkNodeVersion,
  checkNpmVersion,
  checkClaudeCode,
  checkGit,
  checkGitRepo,
  checkConfigFile,
  checkMofloYamlCompliance,
  checkStatusLine,
  checkDaemonStatus,
  checkDaemonVersionSkew,
  checkDaemonIdentity,
  checkDaemonOrphan,
  checkDaemonWriteRouting,
  checkWritersAudit,
  checkMemoryDatabase,
  // Surfaces nested `.moflo/moflo.db` directories — every nested instance is
  // a daemon island in a monorepo (#1174). Runs cheap (depth-bounded BFS,
  // statSync only) and independent of memory-DB integrity probes.
  checkNestedMofloIslands,
  // Surfaces leftover `.swarm/` artifacts (memory.db, router state, logs) so
  // the auto-fix can relocate or delete them. Independent of the canonical
  // DB checks — runs cheap (statSync only).
  checkSwarmResidue,
  // Owns the corruption signal so downstream checks (Embeddings, Semantic
  // Quality, Memory Access Functional) don't surface it as the synthetic
  // "Check" failure (doctor.ts:214). MUST run after checkMemoryDatabase
  // (which confirms the file exists) and before any check that opens the
  // DB via openBackend.
  checkMemoryDbIntegrity,
  checkEmbeddings,
  checkEmbeddingHygiene,
  checkEmbeddingCoverageTruth,
  checkTestDirs,
  checkMcpServers,
  checkDiskSpace,
  checkBuildTools,
  checkSemanticQuality,
  checkIntelligence,
  checkSpellEngine,
  checkSubagentHealth,
  checkSpellExecution,
  checkMcpToolInvocation,
  checkMcpSpellIntegration,
  checkHookExecution,
  checkGateHealth,
  checkHookBlockDrift,
  checkClaudeMdInjectionDrift,
  checkMofloDbBridge,
  // Issue #818 / epic #798 — coordinator-path tripwires. They share the
  // singleton coordinator with checkSubagentHealth above and assert by
  // agent-id (not absolute counts) so they tolerate the parallel batch.
  checkSwarmFunctional,
  checkHiveMindFunctional,
  // Issue #844 — memory_store + memory_search round-trip across subagent,
  // swarm-agent, and hive-mind contexts.
  checkMemoryAccessFunctional,
  checkSandboxTier,
];

/** Sequenced check that runs AFTER `allChecks` settles. Issue #992. */
export const zombieScanCheck: CheckFn = checkZombieProcesses;

/** Lookup table for `flo doctor -c <name>`. */
export const componentMap: Record<string, CheckFn> = {
  'version': checkVersionFreshness,
  'freshness': checkVersionFreshness,
  'node': checkNodeVersion,
  'npm': checkNpmVersion,
  'claude': checkClaudeCode,
  'config': checkConfigFile,
  'yaml': checkMofloYamlCompliance,
  'moflo-yaml': checkMofloYamlCompliance,
  'statusline': checkStatusLine,
  'status-line': checkStatusLine,
  'daemon': checkDaemonStatus,
  'daemon-version-skew': checkDaemonVersionSkew,
  'version-skew': checkDaemonVersionSkew,
  'skew': checkDaemonVersionSkew,
  'daemon-write-routing': checkDaemonWriteRouting,
  'write-routing': checkDaemonWriteRouting,
  'daemon-identity': checkDaemonIdentity,
  'daemon-identity-match': checkDaemonIdentity,
  'identity': checkDaemonIdentity,
  'daemon-orphan': checkDaemonOrphan,
  'daemon-orphans': checkDaemonOrphan,
  'orphan': checkDaemonOrphan,
  'orphans': checkDaemonOrphan,
  'writers-audit': checkWritersAudit,
  'writers': checkWritersAudit,
  'memory': checkMemoryDatabase,
  'nested-moflo': checkNestedMofloIslands,
  'nested': checkNestedMofloIslands,
  'islands': checkNestedMofloIslands,
  'monorepo': checkNestedMofloIslands,
  'swarm-residue': checkSwarmResidue,
  'residue': checkSwarmResidue,
  'memory-db-integrity': checkMemoryDbIntegrity,
  'integrity': checkMemoryDbIntegrity,
  'memory-integrity': checkMemoryDbIntegrity,
  'embeddings': checkEmbeddings,
  'embedding-hygiene': checkEmbeddingHygiene,
  'embedding-coverage': checkEmbeddingCoverageTruth,
  'coverage': checkEmbeddingCoverageTruth,
  'coverage-truth': checkEmbeddingCoverageTruth,
  'hygiene': checkEmbeddingHygiene,
  'git': checkGit,
  'mcp': checkMcpServers,
  'disk': checkDiskSpace,
  'typescript': checkBuildTools,
  'tests': checkTestDirs,
  'semantic': checkSemanticQuality,
  'quality': checkSemanticQuality,
  'intelligence': checkIntelligence,
  'workflows': checkSpellEngine,
  'workflow': checkSpellEngine,
  'subagent': checkSubagentHealth,
  'subagents': checkSubagentHealth,
  'agents': checkSubagentHealth,
  'spell-exec': checkSpellExecution,
  'mcp-tools': checkMcpToolInvocation,
  'mcp-spell': checkMcpSpellIntegration,
  'hooks': checkHookExecution,
  'gates': checkGateHealth,
  'gate': checkGateHealth,
  'hook-drift': checkHookBlockDrift,
  'drift': checkHookBlockDrift,
  'claudemd-drift': checkClaudeMdInjectionDrift,
  'claudemd': checkClaudeMdInjectionDrift,
  'injection-drift': checkClaudeMdInjectionDrift,
  'sandbox': checkSandboxTier,
  'sandbox-tier': checkSandboxTier,
  'moflodb': checkMofloDbBridge,
  'bridge': checkMofloDbBridge,
  'swarm': checkSwarmFunctional,
  'swarm-functional': checkSwarmFunctional,
  'hive': checkHiveMindFunctional,
  'hive-mind': checkHiveMindFunctional,
  'hive-mind-functional': checkHiveMindFunctional,
  'memory-access': checkMemoryAccessFunctional,
  'memory-functional': checkMemoryAccessFunctional,
};
