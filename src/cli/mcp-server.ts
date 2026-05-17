/**
 * V3 CLI MCP Server Management
 *
 * Provides server lifecycle management for MCP integration:
 * - Start/stop/status methods with process management
 * - Health check endpoint integration
 * - Graceful shutdown handling
 * - PID file management for daemon detection
 * - Event-based status monitoring
 *
 * Performance Targets:
 * - Server startup: <400ms
 * - Health check: <10ms
 * - Graceful shutdown: <5s
 *
 * @module moflo/mcp-server
 * @version 3.0.0
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { errorDetail } from './shared/utils/error-detail.js';
import { findProjectRoot } from './services/project-root.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the per-project `.moflo/` directory for MCP state files.
 *
 * Routed through the unified `findProjectRoot` so the launcher, daemon, healers
 * and the MCP server all agree on the same anchor (see #1057, #1145).
 * Replaces the prior `os.tmpdir()` location which was shared across every
 * moflo consumer on the machine — concurrent projects overwrote each other's
 * PID file and `flo mcp stop` could kill the wrong project's MCP server.
 */
function resolveMcpStateDir(): string {
  return path.join(findProjectRoot(), '.moflo');
}

/**
 * Legacy tmpdir paths (pre-#1151). Kept only so we can clean up dead PID
 * files left behind by older moflo versions. Never written to.
 */
const LEGACY_TMPDIR_PID_FILE = path.join(os.tmpdir(), 'claude-flow-mcp.pid');
const LEGACY_TMPDIR_LOG_FILE = path.join(os.tmpdir(), 'claude-flow-mcp.log');

/**
 * MCP Server configuration
 *
 * Only 'stdio' transport is supported — http/websocket were removed to avoid
 * pulling in express/ws/cors/helmet.
 */
export interface MCPServerOptions {
  transport?: 'stdio';
  pidFile?: string;
  logFile?: string;
  tools?: string[] | 'all';
  daemonize?: boolean;
}

/**
 * MCP Server status
 */
export interface MCPServerStatus {
  running: boolean;
  pid?: number;
  transport?: string;
  uptime?: number;
  tools?: number;
  startedAt?: string;
  health?: {
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  };
}

/**
 * Build default configuration at construction time. PID/log paths resolve
 * against `findProjectRoot()` so each project gets its own MCP state files
 * under `<projectRoot>/.moflo/`. Lazy so test code that sets
 * `CLAUDE_PROJECT_DIR` per-test sees the override.
 */
function buildDefaultOptions(): Required<MCPServerOptions> {
  const stateDir = resolveMcpStateDir();
  return {
    transport: 'stdio',
    pidFile: path.join(stateDir, 'mcp-server.pid'),
    logFile: path.join(stateDir, 'mcp-server.log'),
    tools: 'all',
    daemonize: false,
  };
}

/**
 * Best-effort append to the MCP log file. Errors are swallowed — logging must
 * never crash the MCP server. Used to capture server start, project root
 * resolution, and per-request timing so we never repeat the 18-hour
 * diagnostic blind window from #1174.
 *
 * Rotation: when the log exceeds {@link MCP_LOG_ROTATE_BYTES}, rename it to
 * `<logFile>.1` (overwriting any previous rotated file). One rotation level
 * keeps the most recent ~50MB of activity plus the previous ~50MB. A long-
 * running session with heavy MCP traffic can otherwise write hundreds of MB.
 *
 * Cross-platform: uses fs.appendFileSync + fs.mkdirSync({recursive:true}) +
 * fs.renameSync. All three work identically on Windows/macOS/Linux. Windows
 * note: renameSync can fail with EBUSY if the file is open by another
 * process; we use append-only here so no other writer should hold it, but
 * the rename is wrapped in a try/catch so a transient rotation failure can't
 * crash the MCP server (next append succeeds; rotation retries next time).
 */
const MCP_LOG_ROTATE_BYTES = 50 * 1024 * 1024;
// Throttle rotation checks: batch spell scenarios can write thousands of
// MCP requests per session. statSync per append is wasted syscalls — bucket
// the check every N writes (and always on the very first call so cold-start
// rotation still fires).
const MCP_LOG_ROTATE_CHECK_EVERY = 100;
let mcpAppendsSinceRotateCheck = MCP_LOG_ROTATE_CHECK_EVERY;
function safeAppendMcpLog(logFile: string, event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // Rotate before append so the very write that crosses the threshold
    // lands in the fresh file rather than the rotated one.
    if (++mcpAppendsSinceRotateCheck >= MCP_LOG_ROTATE_CHECK_EVERY) {
      mcpAppendsSinceRotateCheck = 0;
      try {
        const stats = fs.statSync(logFile);
        if (stats.size >= MCP_LOG_ROTATE_BYTES) {
          const rotated = `${logFile}.1`;
          try { fs.unlinkSync(rotated); } catch { /* may not exist */ }
          fs.renameSync(logFile, rotated);
        }
      } catch { /* file may not exist yet; first write creates it */ }
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(logFile, line, 'utf-8');
  } catch { /* logging must never throw */ }
}

/**
 * MCP Server Manager
 *
 * Manages the lifecycle of the MCP server process
 */
export class MCPServerManager extends EventEmitter {
  private options: Required<MCPServerOptions>;
  private process?: ChildProcess;
  private startTime?: Date;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(options: MCPServerOptions = {}) {
    super();
    this.options = { ...buildDefaultOptions(), ...options };
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<MCPServerStatus> {
    // Check if already running
    const status = await this.getStatus();
    if (status.running) {
      throw new Error(`MCP Server already running (PID: ${status.pid})`);
    }

    const startTime = performance.now();
    this.startTime = new Date();

    this.emit('starting', { options: this.options });

    try {
      // Only stdio is supported — start the stdio server in-process.
      await this.startStdioServer();

      const duration = performance.now() - startTime;

      // Write PID file
      await this.writePidFile();

      // Start health check monitoring
      this.startHealthMonitoring();

      const finalStatus = await this.getStatus();

      this.emit('started', {
        ...finalStatus,
        startupTime: duration,
      });

      return finalStatus;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the MCP server
   */
  async stop(force = false): Promise<void> {
    const status = await this.getStatus();

    if (!status.running) {
      return;
    }

    this.emit('stopping', { force });

    try {
      // Stop health monitoring
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = undefined;
      }

      if (this.process) {
        // Graceful shutdown
        if (!force) {
          this.process.kill('SIGTERM');
          await this.waitForExit(5000);
        }

        // Force kill if still running
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }

        this.process = undefined;
      }

      // Remove PID file
      await this.removePidFile();

      this.startTime = undefined;
      this.emit('stopped');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<MCPServerStatus> {
    // Check PID file
    const pid = await this.readPidFile();

    if (!pid) {
      // No PID file found. Detect if we are running in stdio mode
      // (e.g., launched by Claude Code via `claude mcp add`).
      const isStdio = !process.stdin.isTTY;
      const envTransport = process.env.CLAUDE_FLOW_MCP_TRANSPORT;
      if (isStdio || envTransport === 'stdio' || this.options.transport === 'stdio') {
        return {
          running: true,
          pid: process.pid,
          transport: 'stdio',
          startedAt: this.startTime?.toISOString(),
          uptime: this.startTime
            ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
            : undefined,
        };
      }
      return { running: false };
    }

    // Check if process is running
    const isRunning = this.isProcessRunning(pid);

    if (!isRunning) {
      // Clean up stale PID file
      await this.removePidFile();
      return { running: false };
    }

    // Build status
    const status: MCPServerStatus = {
      running: true,
      pid,
      transport: this.options.transport,
      startedAt: this.startTime?.toISOString(),
      uptime: this.startTime
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
        : undefined,
    };

    return status;
  }

  /**
   * Check server health (stdio only — checks the PID is alive)
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  }> {
    const pid = await this.readPidFile();
    if (pid === null) {
      return { healthy: false, error: 'No PID file found' };
    }
    if (!this.isProcessRunning(pid)) {
      // Clean up stale PID file
      await this.removePidFile();
      return { healthy: false, error: 'Process not running (cleaned up stale PID)' };
    }
    return { healthy: true };
  }

  /**
   * Restart the server
   */
  async restart(): Promise<MCPServerStatus> {
    await this.stop();
    return await this.start();
  }

  /**
   * Start stdio server in-process
   * Handles stdin/stdout directly like V2 implementation
   */
  private async startStdioServer(): Promise<void> {
    // Import the tool registry
    const { listMCPTools, callMCPTool, hasTool } = await import('./mcp-client.js');

    // Read version dynamically from root moflo package.json
    let VERSION = '4.6.3';
    try {
      const { readFileSync } = await import('fs');
      const { dirname: _d, join: _j } = await import('path');
      const { fileURLToPath: _f } = await import('url');
      let _dir = _d(_f(import.meta.url));
      for (;;) {
        try {
          const _pkg = JSON.parse(readFileSync(_j(_dir, 'package.json'), 'utf8'));
          if (_pkg.name === 'moflo' && _pkg.version) { VERSION = _pkg.version; break; }
        } catch {}
        const _p = _d(_dir);
        if (_p === _dir) break;
        _dir = _p;
      }
    } catch {}
    const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // Log to stderr to not corrupt stdout
    console.error(
      `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Starting in stdio mode`
    );
    console.error(JSON.stringify({
      arch: process.arch,
      mode: 'mcp-stdio',
      nodeVersion: process.version,
      pid: process.pid,
      platform: process.platform,
      protocol: 'stdio',
      sessionId,
      version: VERSION,
    }));

    // Persistent log (#1174). The MCP server previously logged only to stderr,
    // which Claude Code drops on the floor unless the user runs `claude
    // --debug`. The 18-hour daemon-island incident took that long to diagnose
    // partly because no on-disk log captured server start, the resolved
    // project root, or the request stream. Default-on JSONL log fixes that.
    const resolvedProjectRoot = findProjectRoot();
    safeAppendMcpLog(this.options.logFile, {
      event: 'server.start',
      sessionId,
      version: VERSION,
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: process.cwd(),
      projectRoot: resolvedProjectRoot,
      claudeProjectDir: process.env.CLAUDE_PROJECT_DIR || null,
      pidFile: this.options.pidFile,
      logFile: this.options.logFile,
    });

    // Send server initialization notification
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      method: 'server.initialized',
      params: {
        serverInfo: {
          name: 'moflo',
          version: VERSION,
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
          },
        },
      },
    }));

    // Handle stdin messages (S-5: bounded buffer to prevent OOM)
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
    let buffer = '';

    process.stdin.on('data', async (chunk) => {
      buffer += chunk.toString();

      if (buffer.length > MAX_BUFFER_SIZE) {
        console.error(
          `[${new Date().toISOString()}] ERROR [claude-flow-mcp] Buffer exceeded ${MAX_BUFFER_SIZE} bytes, rejecting`
        );
        buffer = '';
        console.log(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Request too large' },
        }));
        return;
      }

      // Process complete JSON messages
      let lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            const response = await this.handleMCPMessage(message, sessionId);
            if (response) {
              console.log(JSON.stringify(response));
            }
          } catch (error) {
            console.error(
              `[${new Date().toISOString()}] ERROR [claude-flow-mcp] Failed to parse message:`,
              errorDetail(error)
            );
          }
        }
      }
    });

    process.stdin.on('end', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) stdin closed, shutting down...`
      );
      process.exit(0);
    });

    process.stdin.on('error', () => {
      // stdin pipe broken — parent disconnected
      process.exit(0);
    });

    // Orphan watchdog: on Windows, stdin 'end' doesn't always fire when the
    // parent process disconnects. Poll the parent PID to detect orphaning and
    // self-terminate. Also tracks stdin inactivity as a secondary signal.
    const parentPid = process.ppid;
    let lastStdinActivity = Date.now();
    const WATCHDOG_INTERVAL_MS = 10_000; // Check every 10s
    const STDIN_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 min with no stdin = likely orphaned

    // Track stdin activity
    process.stdin.on('data', () => { lastStdinActivity = Date.now(); });

    const watchdog = setInterval(() => {
      // Check 1: Is parent process still alive?
      if (parentPid) {
        try {
          process.kill(parentPid, 0); // signal 0 = existence check
        } catch {
          // Parent is gone — we're orphaned
          console.error(
            `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Parent (PID ${parentPid}) gone, shutting down...`
          );
          clearInterval(watchdog);
          process.exit(0);
        }
      }

      // Check 2: Has stdin been idle too long?
      if (Date.now() - lastStdinActivity > STDIN_IDLE_TIMEOUT_MS) {
        console.error(
          `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) No stdin activity for ${STDIN_IDLE_TIMEOUT_MS / 1000}s, shutting down...`
        );
        clearInterval(watchdog);
        process.exit(0);
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref(); // Don't keep process alive just for watchdog

    // Handle process termination
    process.on('SIGINT', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Received SIGINT, shutting down...`
      );
      clearInterval(watchdog);
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Received SIGTERM, shutting down...`
      );
      clearInterval(watchdog);
      process.exit(0);
    });

    // Mark as ready immediately for stdio
    this.emit('ready');
  }

  /**
   * Handle incoming MCP message
   */
  private async handleMCPMessage(
    message: { jsonrpc: string; id?: string | number; method?: string; params?: unknown },
    sessionId: string
  ): Promise<{ jsonrpc: string; id?: string | number; result?: unknown; error?: { code: number; message: string } } | null> {
    const { listMCPTools, callMCPTool, hasTool } = await import('./mcp-client.js');

    if (!message.method) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32600, message: 'Invalid Request: missing method' },
      };
    }

    const params = (message.params || {}) as Record<string, unknown>;

    try {
      switch (message.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'moflo', version: '3.0.0' },
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
              },
            },
          };

        case 'tools/list': {
          const listStart = performance.now();
          const tools = listMCPTools();
          const durationMs = performance.now() - listStart;
          safeAppendMcpLog(this.options.logFile, {
            event: 'tools/list',
            sessionId,
            count: tools.length,
            durationMs: Math.round(durationMs * 100) / 100,
          });
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          };
        }

        case 'tools/call': {
          const toolName = params.name as string;
          const toolParams = (params.arguments || {}) as Record<string, unknown>;

          if (!hasTool(toolName)) {
            safeAppendMcpLog(this.options.logFile, {
              event: 'tools/call.unknown',
              sessionId,
              toolName,
            });
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Tool not found: ${toolName}` },
            };
          }

          const callStart = performance.now();
          try {
            const result = await callMCPTool(toolName, toolParams, { sessionId });
            const durationMs = performance.now() - callStart;
            safeAppendMcpLog(this.options.logFile, {
              event: 'tools/call.ok',
              sessionId,
              toolName,
              durationMs: Math.round(durationMs * 100) / 100,
            });
            return {
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
            };
          } catch (error) {
            const durationMs = performance.now() - callStart;
            safeAppendMcpLog(this.options.logFile, {
              event: 'tools/call.error',
              sessionId,
              toolName,
              durationMs: Math.round(durationMs * 100) / 100,
              error: error instanceof Error ? error.message : 'Tool execution failed',
            });
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : 'Tool execution failed',
              },
            };
          }
        }

        case 'notifications/initialized':
          // Client notification - no response needed
          console.error(
            `[${new Date().toISOString()}] INFO [claude-flow-mcp] (${sessionId}) Client initialized`
          );
          return null;

        case 'ping':
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          };

        default:
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          };
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ERROR [claude-flow-mcp] Error handling ${message.method}:`,
        error
      );
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }

  /**
   * Wait for process to exit
   */
  private async waitForExit(timeout: number): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, timeout);

      this.process!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.checkHealth();
        this.emit('health', health);

        if (!health.healthy) {
          this.emit('unhealthy', health);
        }
      } catch (error) {
        this.emit('health-error', error);
      }
    }, 30000);
    this.healthCheckInterval.unref();
  }

  /**
   * Write PID file. Ensures the per-project state directory exists and opportunistically
   * cleans up an abandoned tmpdir PID file (pre-#1151 layout) when it points at a dead
   * PID — abandoned dead-PID files belong to nobody so we can safely unlink them, but
   * a live tmpdir PID is left alone since it may belong to another project on an
   * older moflo version.
   */
  private async writePidFile(): Promise<void> {
    const pid = this.process?.pid || process.pid;
    await fs.promises.mkdir(path.dirname(this.options.pidFile), { recursive: true });
    await fs.promises.writeFile(this.options.pidFile, String(pid), 'utf8');
    await this.cleanupAbandonedTmpdirPid();
  }

  /**
   * Remove a stale `<tmpdir>/claude-flow-mcp.pid` left by a pre-#1151 moflo if
   * the PID it points to is no longer running. Live PIDs are preserved so we
   * don't break stop/status for another project still on the old layout.
   */
  private async cleanupAbandonedTmpdirPid(): Promise<void> {
    try {
      const legacy = await fs.promises.readFile(LEGACY_TMPDIR_PID_FILE, 'utf8');
      const legacyPid = parseInt(legacy.trim(), 10);
      if (!Number.isNaN(legacyPid) && !this.isProcessRunning(legacyPid)) {
        await fs.promises.unlink(LEGACY_TMPDIR_PID_FILE).catch(() => {});
        await fs.promises.unlink(LEGACY_TMPDIR_LOG_FILE).catch(() => {});
      }
    } catch {
      // No legacy file (the common path post-upgrade) — nothing to do.
    }
  }

  /**
   * Read PID file
   */
  private async readPidFile(): Promise<number | null> {
    try {
      const content = await fs.promises.readFile(this.options.pidFile, 'utf8');
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Remove PID file
   */
  private async removePidFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.options.pidFile);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Check if process is running
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

}

/**
 * Create MCP server manager
 */
export function createMCPServerManager(
  options?: MCPServerOptions
): MCPServerManager {
  return new MCPServerManager(options);
}

/**
 * Singleton server manager instance
 */
let serverManager: MCPServerManager | null = null;
let currentTransport: string | undefined = undefined;

/**
 * Get or create server manager singleton
 *
 * FIX for issue #942: Recreate singleton if transport type changes
 * Previously, once created with stdio (default), HTTP options were ignored
 */
export function getServerManager(
  options?: MCPServerOptions
): MCPServerManager {
  const requestedTransport = options?.transport;

  // Recreate if transport type changes (fixes HTTP transport not working)
  if (serverManager && requestedTransport && requestedTransport !== currentTransport) {
    serverManager = new MCPServerManager(options);
    currentTransport = requestedTransport;
  }

  if (!serverManager) {
    serverManager = new MCPServerManager(options);
    currentTransport = options?.transport;
  }
  return serverManager;
}

/**
 * Quick start MCP server
 */
export async function startMCPServer(
  options?: MCPServerOptions
): Promise<MCPServerStatus> {
  const manager = getServerManager(options);
  return await manager.start();
}

/**
 * Quick stop MCP server
 */
export async function stopMCPServer(force = false): Promise<void> {
  if (serverManager) {
    await serverManager.stop(force);
  }
}

/**
 * Get MCP server status
 */
export async function getMCPServerStatus(): Promise<MCPServerStatus> {
  const manager = getServerManager();
  return await manager.getStatus();
}

export default MCPServerManager;
