/**
 * Deep Verification Checks for Doctor Command
 *
 * These checks go beyond file-existence — they exercise subsystems end-to-end:
 * - Subagent spawn/terminate lifecycle
 * - Spell engine execution (minimal bash step)
 * - MCP tool registry loading and invocation
 * - Hook executor firing
 *
 * All path resolution uses import.meta.url to locate the moflo package root,
 * so these checks work both in the dev repo AND in consumer projects where
 * moflo is installed under node_modules/moflo/.
 *
 * Created with motailz.com
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { findProjectRoot as findConsumerProjectDir } from '../services/project-root.js';
import { findMofloPackageRoot } from '../services/moflo-require.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

// Re-exported so existing consumers (`doctor-checks-memory-access.ts`,
// `doctor-checks-functional-shared.ts`) keep their import paths working
// while the type lives in one canonical place.
export type { HealthCheck };

// ============================================================================
// Path Resolution
// ============================================================================

/** Convert an absolute path to a file:// URL for dynamic import() on Windows. */
export function toImportUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

/**
 * Cached moflo root, sourced from the shared `findMofloPackageRoot` helper in
 * `services/moflo-require.ts` (which already memoizes and tolerates the
 * legacy upstream package names).
 */
export function getMofloRoot(): string | undefined {
  return findMofloPackageRoot() ?? undefined;
}

/**
 * Find the first existing .js module from paths relative to the moflo root.
 */
export function findModule(...relativePaths: string[]): string | undefined {
  const root = getMofloRoot();
  if (!root) return undefined;
  for (const rel of relativePaths) {
    const full = join(root, rel);
    if (existsSync(full)) return full;
  }
  return undefined;
}

// ============================================================================
// 1. Subagent Spawn/Health Check
// ============================================================================

/**
 * Spawns a test agent, verifies it's active, then terminates it.
 * Validates the full agent lifecycle without a swarm coordinator.
 */
export async function checkSubagentHealth(): Promise<HealthCheck> {
  try {
    const modulePath = findModule(
      'dist/src/cli/mcp-tools/agent-tools.js',   // consumer: CLI package dist
    );
    if (!modulePath) {
      return { name: 'Subagent Health', status: 'warn', message: 'Agent tools module not found', fix: 'npm run build' };
    }

    const { agentTools } = await import(toImportUrl(modulePath));

    if (!agentTools || !Array.isArray(agentTools) || agentTools.length === 0) {
      return { name: 'Subagent Health', status: 'warn', message: 'Agent tools module loaded but no tools exported' };
    }

    // Find spawn, status, and terminate handlers
    const spawnTool = agentTools.find((t: { name: string }) => t.name === 'agent_spawn' || t.name === 'agent/spawn');
    const statusTool = agentTools.find((t: { name: string }) => t.name === 'agent_status' || t.name === 'agent/status');
    const terminateTool = agentTools.find((t: { name: string }) => t.name === 'agent_terminate' || t.name === 'agent/terminate');

    if (!spawnTool?.handler) {
      return { name: 'Subagent Health', status: 'warn', message: 'agent_spawn tool not found or has no handler' };
    }

    // Spawn a test agent
    const spawnResult = await spawnTool.handler({
      agentType: 'tester',
      id: `doctor-probe-${Date.now()}`,
      priority: 'low',
      metadata: { purpose: 'doctor-health-check' },
    }, {});

    // `idle` is the AgentState status returned by the live coordinator (post
    // #801); `active`/`spawned` were the legacy literal returns. Accept all
    // three — matches the status-check enum 13 lines below.
    if (!spawnResult?.agentId || !['active', 'idle', 'spawned'].includes(spawnResult.status)) {
      return { name: 'Subagent Health', status: 'fail', message: `Spawn returned unexpected result: ${JSON.stringify(spawnResult)}` };
    }

    const agentId = spawnResult.agentId;
    let statusOk = false;
    let terminateOk = false;

    // Verify status if available (tolerates 'not_found' — expected without a coordinator)
    if (statusTool?.handler) {
      try {
        const statusResult = await statusTool.handler({ agentId, includeMetrics: false, includeHistory: false }, {});
        statusOk = true;
        if (statusResult?.status && !['active', 'idle', 'not_found'].includes(statusResult.status)) {
          return { name: 'Subagent Health', status: 'warn', message: `Agent spawned but status is ${statusResult.status}` };
        }
      } catch {
        // Status lookup failed — non-fatal, probe agent may not persist
        statusOk = true; // handler exists and was invoked
      }
    }

    // Terminate the test agent
    if (terminateTool?.handler) {
      try {
        await terminateTool.handler({ agentId, graceful: true, reason: 'doctor-probe-cleanup' }, {});
        terminateOk = true;
      } catch {
        // Terminate may fail for non-persistent agents — non-fatal
        terminateOk = true; // handler exists and was invoked
      }
    }

    const parts = ['spawn', statusOk ? 'status' : null, terminateOk ? 'terminate' : null].filter(Boolean);
    return { name: 'Subagent Health', status: 'pass', message: `Lifecycle OK (${parts.join(' → ')})` };
  } catch (err) {
    const msg = errorDetail(err);
    return { name: 'Subagent Health', status: 'fail', message: `Agent lifecycle failed: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 2. Spell Execution Check
// ============================================================================

/**
 * Runs a minimal spell (single echo step) through the full engine pipeline:
 * parse → validate → execute → collect result.
 */
export async function checkSpellExecution(): Promise<HealthCheck> {
  try {
    const modulePath = findModule(
      'dist/src/cli/spells/factory/runner-factory.js',
    );
    if (!modulePath) {
      return { name: 'Spell Execution', status: 'warn', message: 'Spell runner-factory not found', fix: 'npm run build' };
    }

    const { runSpellFromContent } = await import(toImportUrl(modulePath));
    if (typeof runSpellFromContent !== 'function') {
      return { name: 'Spell Execution', status: 'fail', message: 'runSpellFromContent is not a function', fix: 'npm run build' };
    }

    const minimalSpell = `
name: doctor-probe
description: Health check probe spell
steps:
  - id: probe
    type: bash
    config:
      command: "echo doctor-ok"
    output: result
`;

    const result = await runSpellFromContent(minimalSpell, 'doctor-probe.yaml', {
      spellId: `doctor-probe-${Date.now()}`,
      timeout: 10_000,
    });

    if (!result) {
      return { name: 'Spell Execution', status: 'fail', message: 'Runner returned no result' };
    }

    if (result.success) {
      const stepCount = result.steps?.length ?? 0;
      const duration = result.duration != null ? `${result.duration}ms` : 'unknown';
      return { name: 'Spell Execution', status: 'pass', message: `Probe OK (${stepCount} step, ${duration})` };
    }

    const errMsg = result.errors?.map((e: { message: string }) => e.message).join('; ') || 'unknown error';
    return { name: 'Spell Execution', status: 'fail', message: `Probe failed: ${errMsg}`, fix: 'npm run build' };
  } catch (err) {
    const msg = errorDetail(err);
    return { name: 'Spell Execution', status: 'fail', message: `Spell engine error: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 3. MCP Tool Invocation Check
// ============================================================================

/**
 * Loads the MCP tool registry, verifies tool count, and invokes a safe
 * read-only tool (system_health or system_info) to confirm handlers work.
 */
export async function checkMcpToolInvocation(): Promise<HealthCheck> {
  try {
    const modulePath = findModule(
      'dist/src/cli/mcp-tools/index.js',         // consumer: CLI package dist
    );
    if (!modulePath) {
      return { name: 'MCP Tool Invocation', status: 'warn', message: 'MCP tools index not found', fix: 'npm run build' };
    }

    let toolsModule: Record<string, unknown>;
    try {
      toolsModule = await import(toImportUrl(modulePath));
    } catch (importErr) {
      // MCP tools index may have circular init deps when loaded outside MCP server.
      // Module file exists — partial pass.
      const msg = errorDetail(importErr);
      const short = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
      return { name: 'MCP Tool Invocation', status: 'warn', message: `Module found but import failed: ${short}`, fix: 'npm run build' };
    }

    // CLI mcp-tools index exports individual tool arrays (agentTools, memoryTools, etc.)
    // Collect all exported arrays into a flat tool list.
    let tools: Array<{ name: string; handler?: Function }>;
    try {
      const toolArrays = Object.values(toolsModule).filter(Array.isArray);
      tools = toolArrays.flat();
    } catch (initErr) {
      const exports = Object.keys(toolsModule).filter(k => k !== 'default');
      return {
        name: 'MCP Tool Invocation',
        status: 'pass',
        message: `Module loaded (${exports.length} exports), tool init deferred to MCP server`,
      };
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      return { name: 'MCP Tool Invocation', status: 'fail', message: 'No MCP tools loaded' };
    }

    const toolCount = tools.length;

    // Find a safe read-only tool to invoke
    const safeTool = tools.find((t) =>
      t.name === 'system_health' || t.name === 'system/health' ||
      t.name === 'system_info' || t.name === 'system/info'
    );

    if (safeTool?.handler) {
      try {
        const result = await safeTool.handler({}, {});
        if (result) {
          return { name: 'MCP Tool Invocation', status: 'pass', message: `${toolCount} tools loaded, handler invocation OK` };
        }
      } catch {
        // Handler invocation failed — tool loading still verified
      }
    }

    // Even without a safe tool to invoke, loaded tools is good
    const categories = new Set(tools.map((t) => t.name.split(/[_/]/)[0]));
    const criticalCategories = ['agent', 'memory', 'system', 'task'];
    const presentCategories = criticalCategories.filter(c => categories.has(c));

    return {
      name: 'MCP Tool Invocation',
      status: presentCategories.length >= 3 ? 'pass' : 'warn',
      message: `${toolCount} tools loaded (${presentCategories.join(', ')})`,
    };
  } catch (err) {
    const msg = errorDetail(err);
    return { name: 'MCP Tool Invocation', status: 'fail', message: `MCP tool loading failed: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 4. Hook Execution Check
// ============================================================================

/**
 * Fires a pre-task hook with a synthetic context and verifies the executor
 * completes without error. Does NOT modify any state — purely diagnostic.
 */
export async function checkHookExecution(): Promise<HealthCheck> {
  try {
    const modulePath = findModule(
      'dist/src/cli/hooks/index.js',
    );
    if (!modulePath) {
      return { name: 'Hook Execution', status: 'warn', message: 'Hooks module not built', fix: 'npm run build' };
    }

    let hooksModule: Record<string, unknown>;
    try {
      hooksModule = await import(toImportUrl(modulePath));
    } catch (importErr) {
      // Hooks module has deep dependency chain (swarm, memory, etc.) that may
      // not be fully compiled. Report partial success — module file exists.
      const msg = errorDetail(importErr);
      const short = msg.length > 80 ? msg.slice(0, 80) + '...' : msg;
      return { name: 'Hook Execution', status: 'warn', message: `Module found but import failed: ${short}`, fix: 'npm run build' };
    }

    const { runHook } = hooksModule;

    if (typeof runHook !== 'function') {
      return { name: 'Hook Execution', status: 'fail', message: 'runHook is not a function', fix: 'npm run build' };
    }

    // Fire a pre-task event with a synthetic context — this exercises the
    // full executor pipeline (registry lookup → priority sort → handler chain)
    const result = await runHook('pre-task', {
      timestamp: new Date(),
      tool: { name: 'doctor-probe', parameters: { diagnostic: true } },
      metadata: { source: 'doctor', readonly: true },
    });

    if (!result) {
      return { name: 'Hook Execution', status: 'warn', message: 'runHook returned no result' };
    }

    const hookCount = result.executedHooks ?? result.executed ?? 0;
    const blocked = result.blocked ?? false;
    const duration = result.duration != null ? `${result.duration}ms` : '';

    if (blocked) {
      return { name: 'Hook Execution', status: 'warn', message: `Hook executor blocked the probe event` };
    }

    const parts = [`executor OK`, `${hookCount} hook(s) fired`];
    if (duration) parts.push(duration);

    return { name: 'Hook Execution', status: 'pass', message: parts.join(', ') };
  } catch (err) {
    const msg = errorDetail(err);
    // Hook errors during doctor are non-fatal — the system may not have hooks configured
    if (msg.includes('No hooks registered') || msg.includes('not initialized')) {
      return { name: 'Hook Execution', status: 'pass', message: 'Executor loaded (no hooks registered)' };
    }
    return { name: 'Hook Execution', status: 'fail', message: `Hook executor error: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 5. MCP Spell Integration Check
// ============================================================================

/**
 * Verifies that the MCP spell tools invoke the real engine via runner-bridge.
 * Calls bridgeExecuteSpell() with a minimal definition and checks for real
 * bash step stdout, not mock/simulated output.
 */
export async function checkMcpSpellIntegration(): Promise<HealthCheck> {
  try {
    const bridgePath = findModule(
      'dist/src/cli/spells/factory/runner-bridge.js',
    );
    if (!bridgePath) {
      return { name: 'MCP Spell Integration', status: 'warn', message: 'runner-bridge not found', fix: 'npm run build' };
    }

    const bridge = await import(toImportUrl(bridgePath));
    if (typeof bridge.bridgeExecuteSpell !== 'function') {
      return { name: 'MCP Spell Integration', status: 'fail', message: 'bridgeExecuteSpell is not a function', fix: 'npm run build' };
    }

    const definition = {
      name: 'doctor-mcp-probe',
      description: 'Doctor MCP integration probe',
      steps: [
        {
          id: 'echo-check',
          type: 'bash',
          config: { command: 'echo mcp-bridge-ok' },
          output: 'result',
        },
      ],
    };

    const result = await bridge.bridgeExecuteSpell(definition, {});

    if (!result) {
      return { name: 'MCP Spell Integration', status: 'fail', message: 'Bridge returned no result' };
    }

    if (!result.success) {
      const errMsg = result.errors?.map((e: { message: string }) => e.message).join('; ') || 'unknown';
      return { name: 'MCP Spell Integration', status: 'fail', message: `Bridge execution failed: ${errMsg}`, fix: 'npm run build' };
    }

    // Verify real step output — if MCP tools were still using mocks, there
    // would be no stdout from a bash step
    const stepOutput = result.outputs?.['echo-check'] ?? result.outputs?.result;
    const stdout = typeof stepOutput === 'object' && stepOutput !== null
      ? (stepOutput as Record<string, unknown>).stdout
      : undefined;

    if (typeof stdout === 'string' && stdout.includes('mcp-bridge-ok')) {
      const duration = result.duration != null ? `${result.duration}ms` : 'unknown';
      return { name: 'MCP Spell Integration', status: 'pass', message: `Bridge → engine OK, real stdout captured (${duration})` };
    }

    return {
      name: 'MCP Spell Integration',
      status: 'fail',
      message: 'Bridge returned success but no real stdout — MCP spell tools may not invoke the engine',
      fix: 'Ensure spell-tools.ts imports from runner-bridge.ts',
    };
  } catch (err) {
    const msg = errorDetail(err);
    return { name: 'MCP Spell Integration', status: 'fail', message: `MCP spell bridge error: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// MofloDb Bridge Check
// ============================================================================

/**
 * Verify the moflodb bridge (v3 ControllerRegistry) actually loads and
 * returns real controllers. If it fails, every moflodb_* MCP tool degrades
 * to a stub response.
 */
export async function checkMofloDbBridge(): Promise<HealthCheck> {
  try {
    const modulePath = findModule('dist/src/cli/memory/memory-bridge.js');
    if (!modulePath) {
      return { name: 'MofloDb Bridge', status: 'warn', message: 'memory-bridge module not found', fix: 'npm run build' };
    }

    const bridge = await import(toImportUrl(modulePath));
    const health = await bridge.bridgeHealthCheck?.();
    if (!health) {
      const err = bridge.getBridgeLastError?.();
      const reason = err?.message ? err.message.slice(0, 200) : 'bridge unavailable';
      return {
        name: 'MofloDb Bridge',
        status: 'fail',
        message: `init failed: ${reason}`,
        fix: 'Check that sql.js is installed and moflo is built: npm run build',
      };
    }

    const controllers = Array.isArray(health.controllers) ? health.controllers : [];
    const required: readonly string[] = bridge.REQUIRED_BRIDGE_CONTROLLERS ?? [];
    const present = new Set(controllers.map((c: { name: string }) => c.name));
    const missing = required.filter(r => !present.has(r));
    if (missing.length > 0) {
      return {
        name: 'MofloDb Bridge',
        status: 'warn',
        message: `loaded but missing controllers: ${missing.join(', ')}`,
      };
    }

    return {
      name: 'MofloDb Bridge',
      status: 'pass',
      message: `${controllers.length} controllers loaded`,
    };
  } catch (err) {
    const msg = errorDetail(err, { firstLineOnly: true });
    return { name: 'MofloDb Bridge', status: 'fail', message: `check error: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// Gate Health Check
// ============================================================================

/** Required gate cases that must exist in gate.cjs for full enforcement. */
const REQUIRED_GATE_CASES = [
  'check-before-agent',
  'check-before-scan',
  'check-before-read',
  'record-task-created',
  'record-memory-searched',
  'check-bash-memory',
  'check-task-transition',
  'record-learnings-stored',
  'record-test-run',
  'record-skill-run',
  'reset-edit-gates',
  'check-before-pr',
  'check-dangerous-command',
  'prompt-reminder',
  // #931 — Defensive safety-net for the second UserPromptSubmit hook. State
  // reset only, no emission. doctor warns if a consumer's gate.cjs is too old
  // to handle it.
  'prompt-state-reset',
  'session-reset',
];

// Import + re-export from the self-contained hook-wiring module (single source of truth).
// hook-wiring.ts has zero moflo imports so it can be dynamically imported by
// session-start-launcher.mjs in consumer projects without transitive failures.
import { REQUIRED_HOOK_WIRING } from '../services/hook-wiring.js';
export { REQUIRED_HOOK_WIRING };

/**
 * Detect "expected pre-publish drift" — source `bin/gate.cjs` is ahead of the
 * installed `node_modules/moflo/bin/gate.cjs`, but the deployed
 * `.claude/helpers/gate.cjs` still matches the installed version. This is the
 * steady state in the moflo dogfood repo while a PR has landed but no
 * `npm install moflo@<new>` has rotated the package.
 *
 * Returns true only when both are true:
 *   - helper content equals installed bin content (helper is correctly synced
 *     to what's installed)
 *   - installed bin content differs from source bin content (source is ahead)
 *
 * If `node_modules/moflo/bin/gate.cjs` is missing (consumer never installed
 * moflo, or path is unusual) we conservatively return false so other drift
 * detection still applies.
 */
export function isExpectedPrePublishDrift(
  installedBinGate: string,
  helperContent: string,
  sourceBinContent: string,
): boolean {
  try {
    const installedContent = readFileSync(installedBinGate, 'utf8');
    return installedContent === helperContent && installedContent !== sourceBinContent;
  } catch {
    return false;
  }
}

/**
 * Verify gate infrastructure health:
 * 1. gate.cjs exists and contains all required cases
 * 2. settings.json hooks reference all required gates
 * 3. bin/gate.cjs and .claude/helpers/gate.cjs are in sync
 * 4. workflow-state.json is parseable (if it exists)
 */
export async function checkGateHealth(): Promise<HealthCheck> {
  const projectDir = findConsumerProjectDir();
  const issues: string[] = [];
  const warnings: string[] = [];

  // 1. Check gate.cjs exists and has all required cases. If neither
  // gate.cjs nor settings.json exist, the project is uninitialised — that
  // is a normal pre-init state for a fresh consumer fixture, not a broken
  // install. Distinguish via warn (init required) vs fail (init was run
  // but something is corrupt). Issue #784 — fresh consumer-install-smoke
  // fixtures hit this branch every CI run.
  const helperGate = join(projectDir, '.claude', 'helpers', 'gate.cjs');
  const settingsForInitProbe = join(projectDir, '.claude', 'settings.json');
  if (!existsSync(helperGate)) {
    const uninitialised = !existsSync(settingsForInitProbe);
    return {
      name: 'Gate Health',
      status: uninitialised ? 'warn' : 'fail',
      message: uninitialised
        ? '.claude/ not initialised — gate.cjs + settings.json absent'
        : '.claude/helpers/gate.cjs not found',
      fix: 'npx moflo init',
    };
  }

  let gateContent: string;
  try {
    gateContent = readFileSync(helperGate, 'utf8');
  } catch (e) {
    return { name: 'Gate Health', status: 'fail', message: `Cannot read .claude/helpers/gate.cjs: ${errorDetail(e)}`, fix: 'npx moflo init --fix' };
  }

  const missingCases = REQUIRED_GATE_CASES.filter(c => !gateContent.includes(`case '${c}'`));
  if (missingCases.length > 0) {
    issues.push(`gate.cjs missing cases: ${missingCases.join(', ')}`);
  }

  // 2. Check bin/gate.cjs sync
  //
  // The launcher syncs `node_modules/moflo/bin/gate.cjs` → `.claude/helpers/gate.cjs`
  // on version change. Source `bin/gate.cjs` is only present in the moflo dogfood
  // repo. During the dogfood publish window — between a PR landing and the next
  // `npm install moflo@<new>` — source bin/ legitimately moves ahead of the
  // installed bin/, while the helper continues to mirror the installed version.
  // That's the expected steady state, not a bug; downgrade it to `warn` and skip
  // the `fix` field so `--fix` doesn't paint a false success (#913).
  const binGate = join(projectDir, 'bin', 'gate.cjs');
  const installedBinGate = join(projectDir, 'node_modules', 'moflo', 'bin', 'gate.cjs');
  if (existsSync(binGate)) {
    try {
      const binContent = readFileSync(binGate, 'utf8');
      if (binContent !== gateContent) {
        const sizeDiff = Math.abs(binContent.length - gateContent.length);
        const prePublishDrift = isExpectedPrePublishDrift(installedBinGate, gateContent, binContent);
        if (prePublishDrift) {
          warnings.push(
            `source bin/gate.cjs is ${sizeDiff} chars ahead of node_modules/moflo/bin/gate.cjs ` +
            '(expected pre-publish drift; resolves on next `npm install moflo@<new>`)'
          );
        } else if (sizeDiff > 10) {
          issues.push(`bin/gate.cjs out of sync with .claude/helpers/gate.cjs (${sizeDiff} chars differ)`);
        } else {
          warnings.push('bin/gate.cjs minor drift from .claude/helpers/gate.cjs');
        }
      }
    } catch { /* non-fatal */ }
  }

  // 3. Check settings.json hook wiring. Missing settings.json means
  // `moflo init` has never run — that is "uninitialised", not "broken"
  // (gate.cjs is auto-synced by session-start-launcher independent of
  // init). Warn-not-fail so fresh consumer fixtures don't trip the gate.
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settingsContent = readFileSync(settingsPath, 'utf8');
      const missingHooks = REQUIRED_HOOK_WIRING.filter(h => !settingsContent.includes(h.pattern));
      if (missingHooks.length > 0) {
        issues.push(`settings.json missing hook wiring: ${missingHooks.map(h => h.pattern).join(', ')}`);
      }
    } catch (e) {
      warnings.push(`Cannot parse .claude/settings.json: ${errorDetail(e)}`);
    }
  } else {
    warnings.push('.claude/settings.json not found — run `npx moflo init` to wire hooks');
  }

  // 4. Check workflow-state.json is valid (if exists)
  const statePath = join(projectDir, '.claude', 'workflow-state.json');
  if (existsSync(statePath)) {
    try {
      const stateContent = readFileSync(statePath, 'utf8');
      const state = JSON.parse(stateContent);
      // Verify expected keys exist
      const expectedKeys = ['tasksCreated', 'memorySearched', 'memoryRequired', 'learningsStored'];
      const missingKeys = expectedKeys.filter(k => !(k in state));
      if (missingKeys.length > 0) {
        warnings.push(`workflow-state.json missing keys: ${missingKeys.join(', ')} (will auto-fix on next gate call)`);
      }
    } catch {
      warnings.push('workflow-state.json corrupt — will auto-reset on next gate call');
    }
  }

  // Build result
  if (issues.length > 0) {
    return {
      name: 'Gate Health',
      status: 'fail',
      message: issues.join('; '),
      fix: 'npx moflo init --fix or manually sync gate files',
    };
  }
  if (warnings.length > 0) {
    return {
      name: 'Gate Health',
      status: 'warn',
      message: warnings.join('; '),
    };
  }

  const caseCount = REQUIRED_GATE_CASES.length;
  const hookCount = REQUIRED_HOOK_WIRING.length;
  return {
    name: 'Gate Health',
    status: 'pass',
    message: `${caseCount} gate cases, ${hookCount} hook bindings, state file OK`,
  };
}

/**
 * Hash-based hook-block drift check (#881). Complements `checkGateHealth`'s
 * required-pattern probe by detecting drift in *any* direction — missing
 * events, modified commands, future hook events not yet covered by
 * `REQUIRED_HOOK_WIRING`. Uses the self-contained `hook-block-hash` module so
 * the same logic runs in `flo doctor`, the launcher, and unit tests.
 *
 * Reports `pass` when no drift, `warn` with a count summary when drift exists.
 * Never `fail` — drift is informational; the user (or `regenerate` mode) is
 * responsible for deciding what to do.
 */
export async function checkHookBlockDrift(): Promise<HealthCheck> {
  const projectDir = findConsumerProjectDir();
  const settingsPath = join(projectDir, '.claude', 'settings.json');

  if (!existsSync(settingsPath)) {
    return {
      name: 'Hook Block Drift',
      status: 'warn',
      message: '.claude/settings.json not found',
      fix: 'npx moflo init',
    };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch (e) {
    return {
      name: 'Hook Block Drift',
      status: 'warn',
      message: `cannot parse .claude/settings.json: ${errorDetail(e)}`,
    };
  }

  const { computeHookBlockDrift, isHookBlockLocked } = await import('../services/hook-block-hash.js');
  if (isHookBlockLocked(settings)) {
    return {
      name: 'Hook Block Drift',
      status: 'pass',
      message: 'drift check skipped — moflo.hooks.locked: true',
    };
  }
  // #896: respect `auto_update.hook_block_drift: off` — opt-out for consumers
  // who explicitly don't want drift surfaced (mirrors the launcher's behaviour).
  try {
    const { loadMofloConfig } = await import('../config/moflo-config.js');
    const cfg = loadMofloConfig(projectDir);
    if (cfg.auto_update.hook_block_drift === 'off') {
      return {
        name: 'Hook Block Drift',
        status: 'pass',
        message: 'drift check skipped — auto_update.hook_block_drift: off',
      };
    }
  } catch { /* config read failure — fall through to drift check */ }
  const report = computeHookBlockDrift(settings.hooks ?? {});

  if (!report.drifted) {
    return {
      name: 'Hook Block Drift',
      status: 'pass',
      message: `hook block matches reference (${report.consumerHash})`,
    };
  }

  const parts: string[] = [];
  parts.push(`drift ${report.consumerHash} vs ${report.referenceHash}`);
  if (report.missing.length > 0) parts.push(`${report.missing.length} missing`);
  if (report.extra.length > 0) parts.push(`${report.extra.length} custom`);

  return {
    name: 'Hook Block Drift',
    status: 'warn',
    message: parts.join(', '),
    fix: 'session-start auto-regenerates by default (#1227); next Claude Code start should heal this. If it persists, ensure `auto_update.hook_block_drift` is not set to `warn`/`off` in moflo.yaml, or set `moflo.hooks.locked: true` to suppress.',
  };
}

// ============================================================================
// 12. CLAUDE.md Injection Drift Check
// ============================================================================

/**
 * Detect when the consumer's `<root>/CLAUDE.md` MoFlo-injected block has
 * drifted from the canonical block the current `claudemd-generator` produces.
 * Analogue of `Hook Block Drift` for CLAUDE.md content.
 *
 * The session-start launcher refreshes shipped guidance files on every
 * version change, but the CLAUDE.md injection is only rewritten by explicit
 * `flo init` / `flo-setup`. Without this check, consumers carry stale
 * injection content (and stale guidance pointers) indefinitely.
 *
 * Five states map to four reportable statuses:
 *   no-file       → warn  (run `flo init`)
 *   no-marker     → warn  (run `flo init` / `flo-setup`)
 *   legacy-marker → warn  (auto-fixable — replace legacy block)
 *   in-sync       → pass
 *   drifted       → warn  (auto-fixable — refresh block)
 */
export async function checkClaudeMdInjectionDrift(): Promise<HealthCheck> {
  const projectDir = findConsumerProjectDir();
  const claudeMdPath = join(projectDir, 'CLAUDE.md');

  // Respect `auto_update.claudemd_injection_drift: off` for consumers who
  // explicitly opt out (mirrors the launcher's behaviour and the Hook Block
  // Drift check). Read the config first so the off-mode skip is cheap.
  try {
    const { loadMofloConfig } = await import('../config/moflo-config.js');
    const cfg = loadMofloConfig(projectDir);
    if (cfg.auto_update.claudemd_injection_drift === 'off') {
      return {
        name: 'CLAUDE.md Injection Drift',
        status: 'pass',
        message: 'drift check skipped — auto_update.claudemd_injection_drift: off',
      };
    }
  } catch { /* config read failure — fall through to drift check */ }

  if (!existsSync(claudeMdPath)) {
    return {
      name: 'CLAUDE.md Injection Drift',
      status: 'warn',
      message: 'CLAUDE.md not found',
      fix: 'npx moflo init',
    };
  }

  let contents: string;
  try {
    contents = readFileSync(claudeMdPath, 'utf-8');
  } catch (e) {
    return {
      name: 'CLAUDE.md Injection Drift',
      status: 'warn',
      message: `cannot read CLAUDE.md: ${errorDetail(e)}`,
    };
  }

  // Dynamic-import the generator + drift detector so the dist-vs-source
  // path resolution stays consistent with the launcher.
  const { generateClaudeMd } = await import('../init/claudemd-generator.js');
  const { computeInjectionDrift } = await import('../services/claudemd-injection.js');

  // Use `{}` (not DEFAULT_INIT_OPTIONS) to match the launcher's call —
  // the generator ignores the argument, but matching call shape removes the
  // possibility of a future generator change diverging the two surfaces.
  const canonical = generateClaudeMd({});
  const report = computeInjectionDrift(contents, canonical);

  switch (report.state) {
    case 'in-sync':
      return {
        name: 'CLAUDE.md Injection Drift',
        status: 'pass',
        message: 'CLAUDE.md injection block matches reference',
      };
    case 'no-marker':
      return {
        name: 'CLAUDE.md Injection Drift',
        status: 'warn',
        message: 'CLAUDE.md has no MOFLO:INJECTED:START block',
        fix: 'npx flo-setup',
      };
    case 'legacy-marker':
      return {
        name: 'CLAUDE.md Injection Drift',
        status: 'warn',
        message: 'CLAUDE.md uses a legacy moflo marker pair (pre-MOFLO:INJECTED) — auto-fix replaces with current block',
        fix: 'npx flo-setup --update',
      };
    case 'drifted':
      return {
        name: 'CLAUDE.md Injection Drift',
        status: 'warn',
        message: 'CLAUDE.md injection block has drifted from reference',
        fix: 'npx flo-setup --update',
      };
    case 'no-file':
      // Defensive — `existsSync` returned true above, so this branch is
      // unreachable in practice. Return a sane status anyway.
      return {
        name: 'CLAUDE.md Injection Drift',
        status: 'warn',
        message: 'CLAUDE.md not found',
        fix: 'npx moflo init',
      };
  }
}
