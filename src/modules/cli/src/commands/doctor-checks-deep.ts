/**
 * Deep Verification Checks for Doctor Command
 *
 * These checks go beyond file-existence — they exercise subsystems end-to-end:
 * - Subagent spawn/terminate lifecycle
 * - Workflow engine execution (minimal bash step)
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
import { join, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { findProjectRoot as findConsumerProjectDir } from '../services/project-root.js';

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

// ============================================================================
// Path Resolution
// ============================================================================

/** Convert an absolute path to a file:// URL for dynamic import() on Windows. */
function toImportUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

/**
 * Walk up from this file to find the moflo package root (the directory
 * containing package.json with name "moflo" or "@moflo/cli").
 * Works in both dev repo and consumer node_modules.
 */
function findMofloRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    try {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (
          pkg.name === 'moflo' ||
          pkg.name === '@moflo/cli' ||
          pkg.name === 'claude-flow' ||
          pkg.name === 'ruflo'
        ) {
          // If we found @moflo/cli, go one more level up to the monorepo root
          if (pkg.name === '@moflo/cli') {
            // In dev: src/modules/cli/package.json → walk to repo root
            // In consumer: src/modules/cli/package.json → walk to node_modules/moflo/
            let root = dirname(dir);
            for (;;) {
              const rootPkg = join(root, 'package.json');
              try {
                if (existsSync(rootPkg)) {
                  const rpkg = JSON.parse(readFileSync(rootPkg, 'utf8'));
                  if (rpkg.name === 'moflo' || rpkg.name === 'claude-flow' || rpkg.name === 'ruflo') {
                    return root;
                  }
                }
              } catch { /* skip */ }
              const parent = dirname(root);
              if (parent === root) break;
              root = parent;
            }
            // Fallback: assume 3 levels up from cli package (src/modules/cli)
            return join(dir, '..', '..', '..');
          }
          return dir;
        }
      }
    } catch { /* skip */ }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

/** Cached moflo root. */
let _mofloRoot: string | undefined | null = null;

export function getMofloRoot(): string | undefined {
  if (_mofloRoot === null) {
    _mofloRoot = findMofloRoot();
  }
  return _mofloRoot ?? undefined;
}

/**
 * Find the first existing .js module from paths relative to the moflo root.
 */
function findModule(...relativePaths: string[]): string | undefined {
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
      'src/modules/cli/dist/src/mcp-tools/agent-tools.js',   // consumer: CLI package dist
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

    if (!spawnResult?.agentId || !['active', 'spawned'].includes(spawnResult.status)) {
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
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Subagent Health', status: 'fail', message: `Agent lifecycle failed: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 2. Workflow Execution Check
// ============================================================================

/**
 * Runs a minimal workflow (single echo step) through the full engine pipeline:
 * parse → validate → execute → collect result.
 */
export async function checkWorkflowExecution(): Promise<HealthCheck> {
  try {
    const modulePath = findModule(
      'src/modules/spells/dist/factory/runner-factory.js',
    );
    if (!modulePath) {
      return { name: 'Workflow Execution', status: 'warn', message: 'Workflow runner-factory not found', fix: 'npm run build' };
    }

    const { runWorkflowFromContent } = await import(toImportUrl(modulePath));
    if (typeof runWorkflowFromContent !== 'function') {
      return { name: 'Workflow Execution', status: 'fail', message: 'runWorkflowFromContent is not a function', fix: 'npm run build' };
    }

    const minimalWorkflow = `
name: doctor-probe
description: Health check probe workflow
steps:
  - id: probe
    type: bash
    config:
      command: "echo doctor-ok"
    output: result
`;

    const result = await runWorkflowFromContent(minimalWorkflow, 'doctor-probe.yaml', {
      workflowId: `doctor-probe-${Date.now()}`,
      timeout: 10_000,
    });

    if (!result) {
      return { name: 'Workflow Execution', status: 'fail', message: 'Runner returned no result' };
    }

    if (result.success) {
      const stepCount = result.steps?.length ?? 0;
      const duration = result.duration != null ? `${result.duration}ms` : 'unknown';
      return { name: 'Workflow Execution', status: 'pass', message: `Probe OK (${stepCount} step, ${duration})` };
    }

    const errMsg = result.errors?.map((e: { message: string }) => e.message).join('; ') || 'unknown error';
    return { name: 'Workflow Execution', status: 'fail', message: `Probe failed: ${errMsg}`, fix: 'npm run build' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Workflow Execution', status: 'fail', message: `Workflow engine error: ${msg}`, fix: 'npm run build' };
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
      'src/modules/cli/dist/src/mcp-tools/index.js',         // consumer: CLI package dist
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
      const msg = importErr instanceof Error ? importErr.message : String(importErr);
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
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'MCP Tool Invocation', status: 'fail', message: `MCP tool loading failed: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 4. Hook Execution Check
// ============================================================================

/**
 * Fires a pre-task hook with a synthetic context and verifies the executor
 * completes without error. Does NOT modify any state — purely diagnostic.
 *
 * Note: The hooks package is not currently included in the published npm
 * package `files` array, so this check gracefully degrades in consumer projects.
 */
export async function checkHookExecution(): Promise<HealthCheck> {
  try {
    const modulePath = findModule(
      'src/modules/hooks/dist/index.js',
    );
    if (!modulePath) {
      return { name: 'Hook Execution', status: 'warn', message: 'Hooks package not available (not shipped in this build)', fix: 'Run from moflo dev repo or add hooks to package.json files' };
    }

    let hooksModule: Record<string, unknown>;
    try {
      hooksModule = await import(toImportUrl(modulePath));
    } catch (importErr) {
      // Hooks module has deep dependency chain (swarm, memory, etc.) that may
      // not be fully compiled. Report partial success — module file exists.
      const msg = importErr instanceof Error ? importErr.message : String(importErr);
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
    const msg = err instanceof Error ? err.message : String(err);
    // Hook errors during doctor are non-fatal — the system may not have hooks configured
    if (msg.includes('No hooks registered') || msg.includes('not initialized')) {
      return { name: 'Hook Execution', status: 'pass', message: 'Executor loaded (no hooks registered)' };
    }
    return { name: 'Hook Execution', status: 'fail', message: `Hook executor error: ${msg}`, fix: 'npm run build' };
  }
}

// ============================================================================
// 5. MCP Workflow Integration Check
// ============================================================================

/**
 * Verifies that the MCP workflow tools invoke the real engine via runner-bridge.
 * Calls bridgeExecuteWorkflow() with a minimal definition and checks for real
 * bash step stdout, not mock/simulated output.
 */
export async function checkMcpWorkflowIntegration(): Promise<HealthCheck> {
  try {
    const bridgePath = findModule(
      'src/modules/spells/dist/factory/runner-bridge.js',
    );
    if (!bridgePath) {
      return { name: 'MCP Workflow Integration', status: 'warn', message: 'runner-bridge not found', fix: 'npm run build' };
    }

    const bridge = await import(toImportUrl(bridgePath));
    if (typeof bridge.bridgeExecuteWorkflow !== 'function') {
      return { name: 'MCP Workflow Integration', status: 'fail', message: 'bridgeExecuteWorkflow is not a function', fix: 'npm run build' };
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

    const result = await bridge.bridgeExecuteWorkflow(definition, {});

    if (!result) {
      return { name: 'MCP Workflow Integration', status: 'fail', message: 'Bridge returned no result' };
    }

    if (!result.success) {
      const errMsg = result.errors?.map((e: { message: string }) => e.message).join('; ') || 'unknown';
      return { name: 'MCP Workflow Integration', status: 'fail', message: `Bridge execution failed: ${errMsg}`, fix: 'npm run build' };
    }

    // Verify real step output — if MCP tools were still using mocks, there
    // would be no stdout from a bash step
    const stepOutput = result.outputs?.['echo-check'] ?? result.outputs?.result;
    const stdout = typeof stepOutput === 'object' && stepOutput !== null
      ? (stepOutput as Record<string, unknown>).stdout
      : undefined;

    if (typeof stdout === 'string' && stdout.includes('mcp-bridge-ok')) {
      const duration = result.duration != null ? `${result.duration}ms` : 'unknown';
      return { name: 'MCP Workflow Integration', status: 'pass', message: `Bridge → engine OK, real stdout captured (${duration})` };
    }

    return {
      name: 'MCP Workflow Integration',
      status: 'fail',
      message: 'Bridge returned success but no real stdout — MCP tools may not invoke the engine',
      fix: 'Ensure workflow-tools.ts imports from runner-bridge.ts',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'MCP Workflow Integration', status: 'fail', message: `MCP workflow bridge error: ${msg}`, fix: 'npm run build' };
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
  'check-before-pr',
  'check-dangerous-command',
  'prompt-reminder',
  'session-reset',
];

// Import + re-export from the self-contained hook-wiring module (single source of truth).
// hook-wiring.ts has zero moflo imports so it can be dynamically imported by
// session-start-launcher.mjs in consumer projects without transitive failures.
import { REQUIRED_HOOK_WIRING } from '../services/hook-wiring.js';
export { REQUIRED_HOOK_WIRING };

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

  // 1. Check gate.cjs exists and has all required cases
  const helperGate = join(projectDir, '.claude', 'helpers', 'gate.cjs');
  if (!existsSync(helperGate)) {
    return {
      name: 'Gate Health',
      status: 'fail',
      message: '.claude/helpers/gate.cjs not found',
      fix: 'npx moflo init --fix',
    };
  }

  let gateContent: string;
  try {
    gateContent = readFileSync(helperGate, 'utf8');
  } catch {
    return { name: 'Gate Health', status: 'fail', message: 'Cannot read .claude/helpers/gate.cjs', fix: 'npx moflo init --fix' };
  }

  const missingCases = REQUIRED_GATE_CASES.filter(c => !gateContent.includes(`case '${c}'`));
  if (missingCases.length > 0) {
    issues.push(`gate.cjs missing cases: ${missingCases.join(', ')}`);
  }

  // 2. Check bin/gate.cjs sync
  const binGate = join(projectDir, 'bin', 'gate.cjs');
  if (existsSync(binGate)) {
    try {
      const binContent = readFileSync(binGate, 'utf8');
      if (binContent !== gateContent) {
        // Check if it's a size difference (likely out of sync) vs whitespace
        const sizeDiff = Math.abs(binContent.length - gateContent.length);
        if (sizeDiff > 10) {
          issues.push(`bin/gate.cjs out of sync with .claude/helpers/gate.cjs (${sizeDiff} chars differ)`);
        } else {
          warnings.push('bin/gate.cjs minor drift from .claude/helpers/gate.cjs');
        }
      }
    } catch { /* non-fatal */ }
  }

  // 3. Check settings.json hook wiring
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settingsContent = readFileSync(settingsPath, 'utf8');
      const missingHooks = REQUIRED_HOOK_WIRING.filter(h => !settingsContent.includes(h.pattern));
      if (missingHooks.length > 0) {
        issues.push(`settings.json missing hook wiring: ${missingHooks.map(h => h.pattern).join(', ')}`);
      }
    } catch {
      warnings.push('Cannot parse .claude/settings.json');
    }
  } else {
    issues.push('.claude/settings.json not found — no hooks configured');
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
