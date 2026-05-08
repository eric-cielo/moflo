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
  checkMofloDbBridge,
} from './doctor-checks-deep.js';
import { checkEmbeddingHygiene } from './doctor-embedding-hygiene.js';
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
  checkDaemonStatus,
  checkDaemonWriteRouting,
  checkMcpServers,
  checkMemoryDatabase,
  checkMofloYamlCompliance,
  checkStatusLine,
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

/** Order matters — top entries surface first under the spinner. */
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
  checkDaemonWriteRouting,
  checkMemoryDatabase,
  checkEmbeddings,
  checkEmbeddingHygiene,
  checkTestDirs,
  checkMcpServers,
  checkDiskSpace,
  checkBuildTools,
  checkSemanticQuality,
  checkIntelligence,
  checkSpellEngine,
  checkZombieProcesses,
  checkSubagentHealth,
  checkSpellExecution,
  checkMcpToolInvocation,
  checkMcpSpellIntegration,
  checkHookExecution,
  checkGateHealth,
  checkHookBlockDrift,
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
  'daemon-write-routing': checkDaemonWriteRouting,
  'write-routing': checkDaemonWriteRouting,
  'memory': checkMemoryDatabase,
  'embeddings': checkEmbeddings,
  'embedding-hygiene': checkEmbeddingHygiene,
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
